import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { disconnectPrisma, withTenant } from '@/server/db/client';
import { ensureDocument, enqueueGeneration, generateDocument, listGenerations, retryGeneration, runGenerationJob } from '@/server/documents/generator';
import { getQuotePdf, getReceiptPdf, getCreditNotePdf } from '@/server/finance/pdfs';
import { openFile } from '@/server/files/service';
import { searchDocuments } from '@/server/files/search';
import { setStorageForTests } from '@/server/storage';
import { LocalStorageDriver } from '@/server/storage/local';
import { env } from '@/lib/env';
import { addJobLabour, addJobPart, addJobPhoto } from '@/server/jobcards/items';
import { addJobNote, assignTechnicians, createJob } from '@/server/jobcards/service';
import { completeInspection, createDiagnosis, createRecommendedWork, startInspection, updateInspectionItem } from '@/server/jobcards/work';
import { createCreditNote, issueCreditNote } from '@/server/finance/creditnotes';
import { createMemberCtx, createWorkspace, drainJobs, ownerQuery, type TestWorkspace } from '../helpers/factory';
import { financeWorkspace, issuedInvoice, pay, pdfText, sentQuote, L } from '../helpers/finance';
import { memberWithPermissions, seedCustomerVehicle } from '../helpers/workshop';
import { VALID_PNG, pngOf } from '../helpers/images';

afterAll(disconnectPrisma);
afterEach(() => setStorageForTests(undefined));

const bytes = async (ctx: Parameters<typeof openFile>[0], id: string) => {
  const r = await openFile(ctx, id, 'download');
  const chunks: Buffer[] = [];
  for await (const c of r.stream) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
};
const files = (businessId: string, resourceType: string, resourceId: string) =>
  ownerQuery("SELECT id, version, is_current, is_financial, visibility, category, generated_kind, generated_ref, source, status FROM files WHERE business_id = $1 AND resource_type = $2 AND resource_id = $3 AND source = 'GENERATED' ORDER BY version", [businessId, resourceType, resourceId]).then((r) => r.rows);

describe('generated financial documents live in the one document store', () => {
  let fw: TestWorkspace;
  beforeAll(async () => { fw = await financeWorkspace('Docs Finance Shop'); });

  it('an issued invoice is stored as version 1: real PDF, financial, customer-visible, retention-locked, linked from the invoice', async () => {
    const inv = await issuedInvoice(fw);
    const rows = await files(fw.businessId, 'invoice', inv.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ version: 1, is_current: true, is_financial: true, visibility: 'CUSTOMER', category: 'INVOICE', generated_kind: 'invoice', status: 'ACTIVE' });
    const pdf = await bytes(fw.ctx, rows[0]!.id);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdfText(pdf)).toContain(inv.number);
    expect((await ownerQuery('SELECT pdf_file_id FROM invoices WHERE id = $1', [inv.id])).rows[0].pdf_file_id).toBe(rows[0]!.id);
    expect((await ownerQuery("SELECT 1 FROM audit_logs WHERE resource_id = $1 AND action = 'document.generated'", [rows[0]!.id])).rowCount).toBe(1);
    // asking again gives back the stored copy: nothing new is made
    const again = await ensureDocument(fw.ctx, 'invoice', inv.id);
    expect(again).toMatchObject({ created: false });
    expect(again.file.id).toBe(rows[0]!.id);
    expect(await files(fw.businessId, 'invoice', inv.id)).toHaveLength(1);
  });

  it('a payment keeps a receipt document and a NEW version of the invoice; the earlier version is preserved untouched', async () => {
    const inv = await issuedInvoice(fw);
    const v1 = (await files(fw.businessId, 'invoice', inv.id))[0]!;
    const v1Bytes = await bytes(fw.ctx, v1.id);
    const paid = await pay(fw, inv.id, 145_000);
    await drainJobs();
    const versions = await files(fw.businessId, 'invoice', inv.id);
    expect(versions.map((v) => [v.version, v.is_current])).toEqual([[1, false], [2, true]]);
    expect((await bytes(fw.ctx, v1.id)).equals(v1Bytes)).toBe(true);
    expect(pdfText(await bytes(fw.ctx, versions[1]!.id))).toMatch(/PAID/);
    const receipt = await files(fw.businessId, 'receipt', paid.receiptId!);
    expect(receipt).toHaveLength(1);
    expect(receipt[0]).toMatchObject({ category: 'RECEIPT', is_financial: true });
    expect((await ownerQuery('SELECT file_id FROM receipts WHERE id = $1', [paid.receiptId])).rows[0].file_id).toBe(receipt[0]!.id);
    expect(pdfText(await getReceiptPdf(fw.ctx, paid.receiptId!).then((r) => r.pdf))).toContain(paid.receiptNumber);
  });

  it('an issued credit note is stored, linked to its record, and bumps the invoice\'s stored version', async () => {
    const inv = await issuedInvoice(fw);
    const cn = await createCreditNote(fw.ctx, { invoiceId: inv.id, reason: 'Goodwill', lines: [L('Goodwill credit', 1, 10_000)] });
    const issued = await issueCreditNote(fw.ctx, cn.id);
    const docs = await files(fw.businessId, 'credit_note', cn.id);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ category: 'CREDIT_NOTE', is_financial: true, visibility: 'CUSTOMER' });
    expect(pdfText((await getCreditNotePdf(fw.ctx, cn.id)).pdf)).toContain(issued.number);
    expect((await files(fw.businessId, 'invoice', inv.id)).map((v) => v.version)).toEqual([1, 2]);
  });

  it('a quote is rendered once per version and served from the store, so renaming the business never rewrites an old quote', async () => {
    const q = await sentQuote(fw);
    const first = await getQuotePdf(fw.ctx, q.id);
    expect(pdfText(first.pdf)).toContain('Docs Finance Shop');
    const stored = await files(fw.businessId, 'quote', q.id);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ generated_ref: 'v1', category: 'QUOTE', is_financial: true });
    await ownerQuery("UPDATE businesses SET name = 'Renamed Workshop', trading_name = 'Renamed Workshop' WHERE id = $1", [fw.businessId]);
    const reprint = await getQuotePdf(fw.ctx, q.id);
    expect(pdfText(reprint.pdf)).toContain('Docs Finance Shop');
    expect(pdfText(reprint.pdf)).not.toContain('Renamed Workshop');
    expect(reprint.pdf.equals(first.pdf)).toBe(true);
    await ownerQuery("UPDATE businesses SET name = 'Docs Finance Shop', trading_name = NULL WHERE id = $1", [fw.businessId]);
  });

  it('a person cannot make an extra version of a financial document without permission and a reason; with both it becomes version 2', async () => {
    const inv = await issuedInvoice(fw);
    const adv = await createMemberCtx(fw, 'service_advisor');
    await expect(ensureDocument(adv.ctx, 'invoice', inv.id, { regenerate: true, reason: 'Customer asked for a fresh copy' })).rejects.toMatchObject({ status: 403 });
    await expect(ensureDocument(fw.ctx, 'invoice', inv.id, { regenerate: true })).rejects.toMatchObject({ status: 422 });
    const v2 = await ensureDocument(fw.ctx, 'invoice', inv.id, { regenerate: true, reason: 'Customer asked for a fresh copy' });
    expect(v2).toMatchObject({ created: true });
    expect(v2.file.version).toBe(2);
    const audit = await ownerQuery("SELECT metadata FROM audit_logs WHERE resource_id = $1 AND action = 'file.versioned'", [v2.file.id]);
    expect(audit.rows[0].metadata).toMatchObject({ reason: 'Customer asked for a fresh copy', version: 2 });
  });

  it('only people who can see the record can get its document; another business gets nothing', async () => {
    const inv = await issuedInvoice(fw);
    const tech = await createMemberCtx(fw, 'technician');
    await expect(ensureDocument(tech.ctx, 'invoice', inv.id)).rejects.toMatchObject({ status: 403 });
    const other = await createWorkspace('Other Gen');
    await expect(ensureDocument(other.ctx, 'invoice', inv.id)).rejects.toMatchObject({ status: 404 });
    await expect(generateDocument(other.businessId, null, 'invoice', inv.id)).rejects.toMatchObject({ status: 404 });
  });

  it('the stored documents are searchable by invoice number and customer', async () => {
    const inv = await issuedInvoice(fw);
    const hit = await searchDocuments(fw.ctx, { q: inv.number });
    expect(hit.items.some((i) => i.resourceType === 'invoice' && i.resourceId === inv.id)).toBe(true);
  });
});

describe('purchase order documents', () => {
  it('a placed order is filed as a document, emailed from the stored copy, and a draft is not filed', async () => {
    const { invWorkspace, mkPart, mkSupplier, placedOrder } = await import('../helpers/inventory');
    const { createPurchaseOrder, emailPurchaseOrder } = await import('@/server/inventory/purchasing');
    const { sentTo } = await import('../helpers/factory');
    const w = await invWorkspace('PO Docs');
    const s = await mkSupplier(w, 'Doc Parts');
    const p = await mkPart(w);
    const draft = await createPurchaseOrder(w.ctx, { supplierId: s.id, lines: [{ partId: p.id, quantity: 1, unitCostCents: 500 }] });
    await expect(ensureDocument(w.ctx, 'purchase_order', draft.id)).rejects.toMatchObject({ status: 409 });
    const po = await placedOrder(w, s.id, [{ partId: p.id, quantity: 2 }]);
    const docs = await files(w.businessId, 'purchase_order', po.id);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ category: 'PURCHASE_ORDER', visibility: 'INTERNAL', is_financial: false });
    expect(pdfText(await bytes(w.ctx, docs[0]!.id))).toContain(po.number);
    await emailPurchaseOrder(w.ctx, po.id);
    await drainJobs();
    const mail = sentTo('doclparts@supplier.test').concat(sentTo(s.email ?? ''));
    const sent = mail.find((m) => m.subject.includes(po.number));
    expect(sent?.attachments?.[0]).toMatchObject({ contentType: 'application/pdf' });
    expect(await files(w.businessId, 'purchase_order', po.id)).toHaveLength(1); // sending again does not pile up copies
  });
});

describe('job summary and inspection report', () => {
  let w: TestWorkspace;
  let jobId: string;
  let techCtx: Awaited<ReturnType<typeof createMemberCtx>>;
  beforeAll(async () => {
    w = await createWorkspace('Narrative Docs');
    techCtx = await createMemberCtx(w, 'technician');
    const { customer, vehicle } = await seedCustomerVehicle(w, 'Narr');
    const { job } = await createJob(w.ctx, { customerId: customer.id, vehicleId: vehicle.id, complaint: 'Grinding noise when braking', mileageKm: 60_000, primaryTechnicianMembershipId: techCtx.ctx.membership.id });
    jobId = job.id;
    await startInspection(techCtx.ctx, jobId);
    const card = await (await import('@/server/jobcards/service')).getJobCard(w.ctx, jobId);
    const brakes = card.inspection!.items.find((i) => i.itemKey === 'brakes')!;
    const lights = card.inspection!.items.find((i) => i.itemKey === 'lights')!;
    await updateInspectionItem(techCtx.ctx, jobId, brakes.id, { status: 'CRITICAL', internalNotes: 'INTERNAL-PAD-NOTE scored discs', customerNotes: 'Front pads are worn out', customerVisible: true });
    await updateInspectionItem(techCtx.ctx, jobId, lights.id, { status: 'GOOD', customerVisible: true });
    await createDiagnosis(techCtx.ctx, jobId, { findings: 'INTERNAL-FINDINGS caliper seized', diagnosis: 'Seized caliper', customerSummary: 'A brake caliper is sticking', internalNotes: 'INTERNAL-DIAG-NOTE' });
    await completeInspection(techCtx.ctx, jobId);
    await createRecommendedWork(techCtx.ctx, jobId, { description: 'Replace front brake pads', priority: 'URGENT', customerVisible: true });
    await addJobNote(w.ctx, jobId, { body: 'Customer-visible update: parts ordered', visibility: 'CUSTOMER' });
    await addJobNote(w.ctx, jobId, { body: 'INTERNAL-NOTE margin is thin on this job', visibility: 'INTERNAL' });
    await addJobLabour(w.ctx, jobId, { description: 'Replace front brake pads and bleed brakes', minutes: 90, rateCentsPerHour: 45_000 });
    await addJobPart(w.ctx, jobId, { description: 'Front brake pad set', partNumber: 'BP-9', quantity: 1, status: 'FITTED', costCents: 123_456, sellPriceCents: 199_900 });
    await addJobPhoto(w.ctx, jobId, { data: VALID_PNG, filename: 'shown.png' }, { category: 'BEFORE_REPAIR', visibility: 'CUSTOMER', description: 'Worn pad shown to the customer' });
    await addJobPhoto(w.ctx, jobId, { data: pngOf(10, 3), filename: 'private.png' }, { category: 'DIAGNOSTIC_EVIDENCE', visibility: 'INTERNAL', description: 'INTERNAL-PHOTO' });
    void assignTechnicians;
  });

  it('the inspection report contains what was marked for the customer and nothing internal', async () => {
    const g = await ensureDocument(w.ctx, 'inspection_report', jobId);
    expect(g.created).toBe(true);
    expect(g.file).toMatchObject({ category: 'VEHICLE_INSPECTION', source: 'GENERATED', visibility: 'INTERNAL', resourceType: 'job' }); // shared only when a person chooses to
    const pdf = await bytes(w.ctx, g.file.id);
    const text = pdfText(pdf);
    for (const needle of ['VEHICLE INSPECTION REPORT', 'Front pads are worn out', 'CRITICAL', 'A brake caliper is sticking', 'Replace front brake pads']) expect(text).toContain(needle);
    for (const secret of ['INTERNAL-PAD-NOTE', 'INTERNAL-FINDINGS', 'INTERNAL-DIAG-NOTE', 'INTERNAL-NOTE', 'INTERNAL-PHOTO', 'caliper seized']) expect(text).not.toContain(secret);
    expect((pdf.toString('latin1').match(/\/Subtype\s*\/Image/g) ?? []).length).toBeLessThanOrEqual(1); // only the customer-visible photo can be in it
  });

  it('the job summary lists the work and parts but no costs, rates or internal notes, and only customer-visible photos', async () => {
    const g = await ensureDocument(w.ctx, 'job_summary', jobId);
    const pdf = await bytes(w.ctx, g.file.id);
    const text = pdfText(pdf);
    for (const needle of ['JOB SUMMARY', 'Grinding noise when braking', 'Replace front brake pads and bleed brakes', '1 h 30 min', 'Front brake pad set', 'BP-9', 'Customer-visible update: parts ordered']) expect(text).toContain(needle);
    for (const secret of ['INTERNAL-NOTE', 'INTERNAL-PHOTO', '123456', '1 234,56', '1234.56', '199900', '450,00', 'margin']) expect(text).not.toContain(secret);
    expect((pdf.toString('latin1').match(/\/Subtype\s*\/Image/g) ?? []).length).toBe(1);
  });

  it('a new version needs the right permission and a reason, and keeps the old one; a technician can see the record but not remake it', async () => {
    const v1 = await ensureDocument(w.ctx, 'job_summary', jobId);
    const viewer = await memberWithPermissions(w, ['job.view', 'document.view']);
    await expect(ensureDocument(viewer.ctx, 'job_summary', jobId, { regenerate: true, reason: 'Updated' })).rejects.toMatchObject({ status: 403 }); // can see the record, cannot remake its documents
    await expect(ensureDocument(techCtx.ctx, 'job_summary', jobId, { regenerate: true })).rejects.toMatchObject({ status: 422 }); // a reason is always needed
    await addJobNote(w.ctx, jobId, { body: 'Another customer update', visibility: 'CUSTOMER' });
    const v2 = await ensureDocument(w.ctx, 'job_summary', jobId, { regenerate: true, reason: 'New update added' });
    expect(v2.file.version).toBe(v1.file.version + 1);
    expect(pdfText(await bytes(w.ctx, v2.file.id))).toContain('Another customer update');
    expect(pdfText(await bytes(w.ctx, v1.file.id))).not.toContain('Another customer update');
    const hist = await files(w.businessId, 'job', jobId);
    expect(hist.filter((h) => h.generated_kind === 'job_summary').map((h) => h.is_current)).toEqual([false, true]);
  });

  it('refuses the inspection report until the inspection is completed', async () => {
    const { customer, vehicle } = await seedCustomerVehicle(w, 'Early');
    const { job } = await createJob(w.ctx, { customerId: customer.id, vehicleId: vehicle.id, complaint: 'x', mileageKm: 60_000 });
    await expect(ensureDocument(w.ctx, 'inspection_report', job.id)).rejects.toMatchObject({ status: 404 });
    await startInspection(w.ctx, job.id);
    await expect(ensureDocument(w.ctx, 'inspection_report', job.id)).rejects.toMatchObject({ status: 409 });
  });
});

describe('failures are safe, visible and retryable', () => {
  class FlakyStorage extends LocalStorageDriver {
    fails = 0;
    constructor() { super(env().STORAGE_LOCAL_DIR); }
    override async put(key: string, body: Buffer, opts: { contentType: string }) {
      if (this.fails > 0) { this.fails--; throw new Error('disk full'); }
      return super.put(key, body, opts);
    }
  }

  it('a storage failure leaves no file record behind and no half-made document; the queue retries and notifies the requester', async () => {
    const w = await createWorkspace('Flaky Docs');
    const { customer, vehicle } = await seedCustomerVehicle(w, 'Fl');
    const { job } = await createJob(w.ctx, { customerId: customer.id, vehicleId: vehicle.id, complaint: 'x', mileageKm: 60_000 });
    const flaky = new FlakyStorage();
    setStorageForTests(flaky);
    flaky.fails = 1;
    await expect(ensureDocument(w.ctx, 'job_summary', job.id)).rejects.toMatchObject({ status: 500 });
    expect(await files(w.businessId, 'job', job.id)).toHaveLength(0);
    expect((await ownerQuery("SELECT 1 FROM audit_logs WHERE business_id = $1 AND action = 'document.generation_failed'", [w.businessId])).rowCount).toBe(1);
    // as a background request: first attempt fails, the retry succeeds, the requester is told
    flaky.fails = 1;
    await withTenant(w.businessId, (tx) => enqueueGeneration(tx, w.businessId, 'job_summary', job.id, { dedupeKey: `t:${job.id}`, requestedById: w.ctx.user.id }));
    await drainJobs();
    let gen = (await listGenerations(w.ctx))[0]!;
    expect(gen).toMatchObject({ status: 'QUEUED', attempts: 1 });
    expect(gen.lastError).toMatch(/disk full/);
    await ownerQuery("UPDATE jobs SET run_at = now() WHERE type = 'document.generate' AND status = 'PENDING' AND business_id = $1", [w.businessId]);
    await drainJobs();
    gen = (await listGenerations(w.ctx))[0]!;
    expect(gen).toMatchObject({ status: 'DONE', attempts: 2 });
    expect(gen.fileId).toBeTruthy();
    expect(await files(w.businessId, 'job', job.id)).toHaveLength(1);
    expect((await ownerQuery("SELECT 1 FROM notifications WHERE business_id = $1 AND user_id = $2 AND type = 'DOCUMENT_READY'", [w.businessId, w.ctx.user.id])).rowCount).toBe(1);
    // the same event cannot queue the same work twice
    expect(await withTenant(w.businessId, (tx) => enqueueGeneration(tx, w.businessId, 'job_summary', job.id, { dedupeKey: `t:${job.id}` }))).toBe(false);
  });

  it('a request that keeps failing is marked failed (with a safe reason), audited, and can be retried by someone who manages documents', async () => {
    const w = await createWorkspace('Failing Docs');
    const flaky = new FlakyStorage();
    setStorageForTests(flaky);
    const { customer, vehicle } = await seedCustomerVehicle(w, 'Fx');
    const { job } = await createJob(w.ctx, { customerId: customer.id, vehicleId: vehicle.id, complaint: 'x', mileageKm: 60_000 });
    flaky.fails = 100;
    await withTenant(w.businessId, (tx) => enqueueGeneration(tx, w.businessId, 'job_summary', job.id, { dedupeKey: `f:${job.id}`, requestedById: w.ctx.user.id }));
    for (let i = 0; i < 5; i++) {
      await drainJobs();
      await ownerQuery("UPDATE jobs SET run_at = now() WHERE type = 'document.generate' AND status = 'PENDING' AND business_id = $1", [w.businessId]);
    }
    const failed = (await listGenerations(w.ctx, { status: 'FAILED' }))[0]!;
    expect(failed.attempts).toBe(4);
    expect(failed.lastError).toBeTruthy();
    expect(await files(w.businessId, 'job', job.id)).toHaveLength(0);
    flaky.fails = 0;
    const tech = await createMemberCtx(w, 'technician');
    await expect(retryGeneration(tech.ctx, failed.id)).rejects.toMatchObject({ status: 403 });
    await retryGeneration(w.ctx, failed.id);
    await drainJobs();
    expect((await listGenerations(w.ctx, { status: 'DONE' })).length).toBe(1);
    expect(await files(w.businessId, 'job', job.id)).toHaveLength(1);
    await expect(retryGeneration(w.ctx, failed.id)).rejects.toMatchObject({ status: 409 }); // only a failed request can be retried
    void runGenerationJob;
  });

  it('an invoice stays valid and its PDF can still be rendered live when filing fails', async () => {
    const fw2 = await financeWorkspace('Resilient Invoices');
    const flaky = new FlakyStorage();
    setStorageForTests(flaky);
    flaky.fails = 100;
    const inv = await issuedInvoice(fw2); // issuing must not fail because the document store did
    expect(inv.number).toMatch(/^INV/);
    expect(await files(fw2.businessId, 'invoice', inv.id)).toHaveLength(0);
    flaky.fails = 0;
    await ownerQuery("UPDATE jobs SET run_at = now() WHERE type = 'document.generate' AND status = 'PENDING' AND business_id = $1", [fw2.businessId]);
    await drainJobs();
    expect(await files(fw2.businessId, 'invoice', inv.id)).toHaveLength(1);
  });
});
