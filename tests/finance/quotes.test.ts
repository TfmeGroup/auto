import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectPrisma, withTenant } from '@/server/db/client';
import { AppError } from '@/lib/errors';
import { createJob, getJobCard } from '@/server/jobcards/service';
import { createRecommendedWork } from '@/server/jobcards/work';
import { createInvoiceFromQuote } from '@/server/finance/invoices';
import { decideQuotePublic, getPublicQuote } from '@/server/finance/quote-public';
import { approveQuoteOnBehalf, cancelQuote, createJobFromQuote, createQuote, getQuote, listQuotes, sendQuote, updateQuote } from '@/server/finance/quotes';
import { runFinanceTasks } from '@/server/finance/scheduled';
import { createMemberCtx, createWorkspace, drainJobs, latestEmailTo, ownerQuery, testMeta, type TestWorkspace } from '../helpers/factory';
import { L, approvedQuote, financeWorkspace, party, sentQuote, setVat, tokenOf } from '../helpers/finance';

afterAll(disconnectPrisma);

let ws: TestWorkspace;
beforeAll(async () => {
  ws = await financeWorkspace('Quote Workshop');
});

const err = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { if (e instanceof AppError) return e; throw e; }
  throw new Error('expected an AppError');
};

describe('creating quotes', () => {
  it('numbers quotes on the server, in sequence, and never twice (even when created at the same time)', async () => {
    const { customer } = await party(ws);
    const made = await Promise.all(Array.from({ length: 8 }, () => createQuote(ws.ctx, { customerId: customer.id, lines: [L('Service kit', 1, 100_000)] })));
    const numbers = made.map((m) => m.number);
    expect(new Set(numbers).size).toBe(8);
    for (const n of numbers) expect(n).toMatch(/^QUO-\d{6}$/);
    const sorted = [...numbers].sort();
    const first = Number(sorted[0]!.slice(4));
    sorted.forEach((n, i) => expect(Number(n.slice(4))).toBe(first + i)); // no gaps among concurrent creates
  });

  it('calculates every total on the server and ignores totals sent by the browser', async () => {
    const { customer } = await party(ws);
    const q = await createQuote(ws.ctx, { customerId: customer.id, lines: [L('Brake pads', 2, 50_000), L('Labour', 1.5, 45_000, { lineType: 'LABOUR' })], totalCents: 1, vatCents: 0, subtotalCents: 5 });
    const got = await getQuote(ws.ctx, q.id);
    expect(got.version.subtotalCents).toBe(167_500);
    expect(got.version.totalCents).toBe(167_500); // not a VAT business
    expect(got.lines).toHaveLength(2);
    expect(got.lines[1]!.totalCents).toBe(67_500);
  });

  it('refuses impossible lines and discounts', async () => {
    const { customer } = await party(ws);
    const base = { customerId: customer.id };
    expect((await err(createQuote(ws.ctx, { ...base, lines: [L('x', 1, -100)] }))).code).toBe('VALIDATION_ERROR');
    expect((await err(createQuote(ws.ctx, { ...base, lines: [L('x', 0, 100)] }))).code).toBe('VALIDATION_ERROR');
    expect((await err(createQuote(ws.ctx, { ...base, lines: [L('x', 1, 100)], discountType: 'FIXED', discountValue: 101 }))).code).toBe('VALIDATION_ERROR');
    expect((await err(createQuote(ws.ctx, { ...base, lines: [L('x', 1, 100, { discountType: 'PERCENT', discountValue: 10_001 })] }))).code).toBe('VALIDATION_ERROR');
    expect((await err(createQuote(ws.ctx, { ...base, lines: [L('x', 1, 100)], validUntil: '2001-01-01' }))).code).toBe('VALIDATION_ERROR');
  });

  it('never mixes up customers, vehicles and jobs', async () => {
    const a = await party(ws, 'A');
    const b = await party(ws, 'B');
    expect((await err(createQuote(ws.ctx, { customerId: a.customer.id, vehicleId: b.vehicle.id }))).code).toBe('VALIDATION_ERROR');
    const other = await createWorkspace('Someone Elses Garage');
    const theirs = await party(other, 'X');
    expect((await err(createQuote(ws.ctx, { customerId: theirs.customer.id }))).code).toBe('VALIDATION_ERROR');
    expect((await err(createQuote(ws.ctx, { customerId: a.customer.id, vehicleId: theirs.vehicle.id }))).code).toBe('VALIDATION_ERROR');
  });

  it('stores the VAT facts on the quote and honours inclusive pricing', async () => {
    const vat = await financeWorkspace('VAT Quote Shop', { vat: true });
    const { customer } = await party(vat);
    const q = await createQuote(vat.ctx, { customerId: customer.id, lines: [L('Clutch', 1, 100_000)] });
    const got = await getQuote(vat.ctx, q.id);
    expect(got.version).toMatchObject({ vatRegistered: true, vatRateBps: 1500, subtotalCents: 100_000, vatCents: 15_000, totalCents: 115_000 });
    await ownerQuery('UPDATE finance_settings SET prices_include_vat = true WHERE business_id = $1', [vat.businessId]);
    const q2 = await createQuote(vat.ctx, { customerId: customer.id, lines: [L('Clutch', 1, 115_000)] });
    expect((await getQuote(vat.ctx, q2.id)).version).toMatchObject({ pricesIncludeVat: true, totalCents: 115_000, vatCents: 15_000, subtotalCents: 100_000 });
    // history is not rewritten when settings change later
    await setVat(vat, false);
    expect((await getQuote(vat.ctx, q.id)).version).toMatchObject({ vatRegistered: true, totalCents: 115_000 });
  });
});

describe('editing, sending and versions', () => {
  it('a draft can be edited in place; a sent version is frozen and a change makes a new version', async () => {
    const { customer } = await party(ws);
    const q = await createQuote(ws.ctx, { customerId: customer.id, lines: [L('Shocks', 2, 80_000)] });
    await updateQuote(ws.ctx, q.id, { lines: [L('Shocks', 2, 90_000)] });
    expect((await getQuote(ws.ctx, q.id)).version.totalCents).toBe(180_000);
    expect((await getQuote(ws.ctx, q.id)).quote.currentVersion).toBe(1);

    const sent = await sendQuote(ws.ctx, q.id);
    expect(sent.status).toBe('SENT');
    expect((await getQuote(ws.ctx, q.id)).version.frozen).toBe(true);

    // editing a sent quote needs a reason and creates version 2
    expect((await err(updateQuote(ws.ctx, q.id, { lines: [L('Shocks', 2, 70_000)] }))).code).toBe('VALIDATION_ERROR');
    const v2 = await updateQuote(ws.ctx, q.id, { lines: [L('Shocks', 2, 70_000)], changeNote: 'Customer asked for a cheaper brand' });
    expect(v2).toMatchObject({ version: 2, newVersion: true });
    const now = await getQuote(ws.ctx, q.id);
    expect(now.quote).toMatchObject({ currentVersion: 2, status: 'DRAFT' });
    expect(now.version.totalCents).toBe(140_000);
    // the version the customer saw is preserved exactly
    const old = await getQuote(ws.ctx, q.id, { version: '1' });
    expect(old.version).toMatchObject({ version: 1, totalCents: 180_000, isCurrent: false });
    expect(old.lines[0]!.unitPriceCents).toBe(90_000);
    expect(now.versions.map((v) => v.version)).toEqual([2, 1]);
    expect(now.versions[0]!.changeNote).toBe('Customer asked for a cheaper brand');
    expect(now.events.map((e) => e.type)).toEqual(expect.arrayContaining(['quote.created', 'quote.sent', 'quote.version_created']));
  });

  it('the database itself refuses to alter a sent version', async () => {
    const q = await sentQuote(ws);
    const version = (await ownerQuery<{ id: string }>('SELECT id FROM quote_versions WHERE quote_id = $1 AND version = 1', [q.id])).rows[0]!;
    await expect(ownerQuery('UPDATE quote_lines SET unit_price_cents = 1 WHERE version_id = $1', [version.id])).rejects.toThrow(/cannot be changed/);
    await expect(ownerQuery('DELETE FROM quote_lines WHERE version_id = $1', [version.id])).rejects.toThrow(/cannot be changed/);
    await expect(ownerQuery('UPDATE quote_versions SET total_cents = 1 WHERE id = $1', [version.id])).rejects.toThrow();
    await expect(ownerQuery('DELETE FROM quotes WHERE id = $1', [q.id])).rejects.toThrow(/cannot be deleted/);
  });

  it('only quotes with lines can be sent, and sending is repeatable without changing what the customer sees', async () => {
    const { customer } = await party(ws);
    const empty = await createQuote(ws.ctx, { customerId: customer.id });
    expect((await err(sendQuote(ws.ctx, empty.id))).code).toBe('VALIDATION_ERROR');
    const q = await sentQuote(ws);
    const again = await sendQuote(ws.ctx, q.id);
    expect(again.version).toBe(1);
    expect(again.customerUrl).not.toBe(`http://localhost:3000/q/${q.token}`); // fresh link, same quote
    expect((await getQuote(ws.ctx, q.id)).quote.status).toBe('SENT');
  });

  it('sending queues the customer email with the link', async () => {
    const { customer } = await party(ws, 'Mail');
    const q = await createQuote(ws.ctx, { customerId: customer.id, lines: [L('Wipers', 1, 25_000)] });
    const s = await sendQuote(ws.ctx, q.id);
    expect(s.emailed).toBe(true);
    const c = await ownerQuery<{ email: string }>('SELECT email FROM customers WHERE id = $1', [customer.id]);
    const mail = await latestEmailTo(c.rows[0]!.email);
    expect(mail?.subject).toContain(q.number);
    expect(mail?.text).toContain(s.customerUrl);
    const log = await ownerQuery('SELECT status, template_key FROM communications WHERE entity_id = $1', [q.id]);
    expect(log.rows[0]).toMatchObject({ status: 'QUEUED', template_key: 'QUOTE_SENT' });
  });

  it('is skipped (and logged) when the customer has no email', async () => {
    const { customer } = await party(ws, 'NoMail');
    await ownerQuery('UPDATE customers SET email = NULL WHERE id = $1', [customer.id]);
    const q = await createQuote(ws.ctx, { customerId: customer.id, lines: [L('Wipers', 1, 25_000)] });
    const s = await sendQuote(ws.ctx, q.id);
    expect(s.emailed).toBe(false);
    const log = await ownerQuery('SELECT status, status_detail AS detail FROM communications WHERE entity_id = $1', [q.id]);
    expect(log.rows[0]).toMatchObject({ status: 'SKIPPED' });
  });
});

describe('customer review and approval', () => {
  it('shows the customer only what is meant for them, and marks the quote viewed', async () => {
    const { customer } = await party(ws);
    const q = await createQuote(ws.ctx, { customerId: customer.id, internalNotes: 'SECRET margin note', customerNotes: 'Thanks for choosing us', lines: [L('Brake discs', 2, 90_000, { unitCostCents: 50_000 })] });
    const s = await sendQuote(ws.ctx, q.id);
    const view = await getPublicQuote(tokenOf(s.customerUrl), testMeta());
    expect(view.quote).toMatchObject({ number: q.number, status: 'VIEWED', version: 1, customerNotes: 'Thanks for choosing us' });
    expect(view.canDecide).toBe(true);
    expect(view.lines[0]).toMatchObject({ description: 'Brake discs', totalCents: 180_000 });
    const json = JSON.stringify(view);
    expect(json).not.toContain('SECRET');
    expect(json).not.toContain('unitCost');
    expect(json).not.toContain('50000');
    expect((await getQuote(ws.ctx, q.id)).quote.status).toBe('VIEWED');
    expect((await getQuote(ws.ctx, q.id)).events.filter((e) => e.type === 'quote.viewed')).toHaveLength(1);
    await getPublicQuote(tokenOf(s.customerUrl), testMeta()); // viewing again does not log again
    expect((await getQuote(ws.ctx, q.id)).events.filter((e) => e.type === 'quote.viewed')).toHaveLength(1);
  });

  it('records a full audit trail when the customer approves, and approving twice changes nothing', async () => {
    const q = await sentQuote(ws);
    const meta = testMeta('203.0.113.9');
    const r = await decideQuotePublic(q.token, { action: 'approve', version: 1, name: 'Sam Customer', acceptTerms: true }, meta);
    expect(r).toMatchObject({ status: 'APPROVED', alreadyDecided: false });
    const got = await getQuote(ws.ctx, q.id);
    expect(got.quote).toMatchObject({ status: 'APPROVED', approvedVersion: 1 });
    expect(got.decision).toMatchObject({ type: 'quote.approved', by: 'Sam Customer' });
    const ev = await ownerQuery('SELECT * FROM finance_events WHERE entity_id = $1 AND type = $2', [q.id, 'quote.approved']);
    expect(ev.rows).toHaveLength(1);
    expect(ev.rows[0]).toMatchObject({ version: 1, actor_kind: 'CUSTOMER', ip: '203.0.113.9' });
    expect(ev.rows[0].detail).toMatchObject({ signerName: 'Sam Customer', acceptedTerms: true, method: 'ELECTRONIC' });
    const audit = await ownerQuery("SELECT * FROM audit_logs WHERE resource_id = $1 AND action = 'quote.approved'", [q.id]);
    expect(audit.rows).toHaveLength(1);

    const again = await decideQuotePublic(q.token, { action: 'approve', version: 1, name: 'Sam Customer', acceptTerms: true }, meta);
    expect(again).toMatchObject({ status: 'APPROVED', alreadyDecided: true });
    expect((await ownerQuery('SELECT 1 FROM finance_events WHERE entity_id = $1 AND type = $2', [q.id, 'quote.approved'])).rows).toHaveLength(1);
  });

  it('two simultaneous approvals produce exactly one approval record', async () => {
    const q = await sentQuote(ws);
    const body = { action: 'approve', version: 1, name: 'Double Click', acceptTerms: true };
    const results = await Promise.all([decideQuotePublic(q.token, body, testMeta()), decideQuotePublic(q.token, body, testMeta()), decideQuotePublic(q.token, body, testMeta())]);
    expect(results.filter((r) => !r.alreadyDecided)).toHaveLength(1);
    expect((await ownerQuery('SELECT 1 FROM finance_events WHERE entity_id = $1 AND type = $2', [q.id, 'quote.approved'])).rows).toHaveLength(1);
  });

  it('needs the customer to accept the terms and type their name', async () => {
    const q = await sentQuote(ws);
    expect((await err(decideQuotePublic(q.token, { action: 'approve', version: 1, name: 'A B' }, testMeta()))).code).toBe('VALIDATION_ERROR');
    expect((await err(decideQuotePublic(q.token, { action: 'approve', version: 1, acceptTerms: true }, testMeta()))).code).toBe('VALIDATION_ERROR');
    expect((await getQuote(ws.ctx, q.id)).quote.status).toBe('SENT');
  });

  it('approval of an out-of-date version is refused: an old approval can never approve a new version', async () => {
    const q = await sentQuote(ws);
    await updateQuote(ws.ctx, q.id, { lines: [L('Different job', 1, 999_00)], changeNote: 'Scope changed' });
    // the old link is dead
    expect((await err(decideQuotePublic(q.token, { action: 'approve', version: 1, name: 'Old Link', acceptTerms: true }, testMeta()))).code).toBe('NOT_FOUND');
    const s2 = await sendQuote(ws.ctx, q.id);
    const t2 = tokenOf(s2.customerUrl);
    const stale = await err(decideQuotePublic(t2, { action: 'approve', version: 1, name: 'Stale Page', acceptTerms: true }, testMeta()));
    expect(stale.code).toBe('CONFLICT');
    expect(stale.details).toMatchObject({ code: 'QUOTE_VERSION_OUTDATED', currentVersion: 2 });
    expect((await getQuote(ws.ctx, q.id)).quote.status).toBe('SENT');
    const ok = await decideQuotePublic(t2, { action: 'approve', version: 2, name: 'Fresh Page', acceptTerms: true }, testMeta());
    expect(ok.status).toBe('APPROVED');
    expect((await getQuote(ws.ctx, q.id)).quote.approvedVersion).toBe(2);
  });

  it('declining records who, when, which version and why; it cannot then be approved', async () => {
    const q = await sentQuote(ws);
    await decideQuotePublic(q.token, { action: 'decline', version: 1, name: 'No Thanks', comment: 'Too expensive' }, testMeta());
    const got = await getQuote(ws.ctx, q.id);
    expect(got.quote.status).toBe('DECLINED');
    expect(got.decision).toMatchObject({ type: 'quote.declined', by: 'No Thanks' });
    expect(got.decision!.detail).toMatchObject({ comment: 'Too expensive' });
    expect((await err(decideQuotePublic(q.token, { action: 'approve', version: 1, name: 'Changed Mind', acceptTerms: true }, testMeta()))).code).toBe('CONFLICT');
    expect((await ownerQuery("SELECT 1 FROM audit_logs WHERE resource_id = $1 AND action = 'quote.declined'", [q.id])).rows).toHaveLength(1);
  });

  it('a request for changes keeps the quote as it is, tells the workshop, and lets them create a new version', async () => {
    const q = await sentQuote(ws);
    await decideQuotePublic(q.token, { action: 'request_changes', version: 1, comment: 'Can you use OEM parts?' }, testMeta());
    const got = await getQuote(ws.ctx, q.id);
    expect(got.quote.status).toBe('SENT');
    expect(got.quote.changesRequestedAt).not.toBeNull();
    expect(got.events.find((e) => e.type === 'quote.changes_requested')?.detail).toMatchObject({ comment: 'Can you use OEM parts?' });
    const note = await ownerQuery("SELECT title FROM notifications WHERE business_id = $1 AND type = 'QUOTE_CHANGES_REQUESTED' ORDER BY created_at DESC LIMIT 1", [ws.businessId]);
    expect(note.rows[0]!.title).toContain(q.number);
    expect((await err(decideQuotePublic(q.token, { action: 'request_changes', version: 1 }, testMeta()))).code).toBe('VALIDATION_ERROR'); // needs a comment
    const v2 = await updateQuote(ws.ctx, q.id, { lines: [L('OEM parts', 1, 150_000)], changeNote: 'OEM parts as requested' });
    expect(v2.version).toBe(2);
    expect((await getQuote(ws.ctx, q.id)).quote.changesRequestedAt).toBeNull();
  });

  it('staff can record an approval given by phone or in person, once', async () => {
    const { customer } = await party(ws);
    const q = await createQuote(ws.ctx, { customerId: customer.id, lines: [L('Oil change', 1, 60_000)] });
    expect((await err(approveQuoteOnBehalf(ws.ctx, q.id, { method: 'PHONE', version: 2 }))).code).toBe('CONFLICT'); // wrong version
    expect((await approveQuoteOnBehalf(ws.ctx, q.id, { method: 'PHONE', version: 1, note: 'Called at 9' })).alreadyApproved).toBe(false);
    expect((await approveQuoteOnBehalf(ws.ctx, q.id, { method: 'PHONE', version: 1 })).alreadyApproved).toBe(true);
    const got = await getQuote(ws.ctx, q.id);
    expect(got.quote.status).toBe('APPROVED');
    expect(got.version.frozen).toBe(true);
    expect(got.decision!.detail).toMatchObject({ method: 'PHONE' });
  });
});

describe('expiry', () => {
  it('the scheduler expires quotes past their date, keeps them, and the customer can no longer approve', async () => {
    const q = await sentQuote(ws);
    await ownerQuery("UPDATE quotes SET valid_until = (now() - interval '3 days')::date WHERE id = $1", [q.id]);
    const r = await runFinanceTasks();
    expect(r.quotesExpired).toBeGreaterThanOrEqual(1);
    const got = await getQuote(ws.ctx, q.id);
    expect(got.quote.status).toBe('EXPIRED');
    expect(got.quote.expiredAt).not.toBeNull();
    expect(got.lines).toHaveLength(2); // preserved, not deleted
    expect((await err(decideQuotePublic(q.token, { action: 'approve', version: 1, name: 'Too Late', acceptTerms: true }, testMeta()))).code).toBe('NOT_FOUND');
    // running again changes nothing
    expect((await runFinanceTasks()).quotesExpired).toBe(0);
    // staff can revise an expired quote into a new version
    expect((await updateQuote(ws.ctx, q.id, { validUntil: new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10), changeNote: 'Renewed offer' })).version).toBe(2);
  });

  it('a quote past its date is not approvable even before the scheduler runs', async () => {
    const q = await sentQuote(ws);
    await ownerQuery("UPDATE quotes SET valid_until = (now() - interval '2 days')::date WHERE id = $1", [q.id]);
    // The sent version is frozen by a trigger, so lift it for this test only to simulate time passing.
    await ownerQuery('ALTER TABLE quote_versions DISABLE TRIGGER quote_versions_frozen');
    await ownerQuery("UPDATE quote_versions SET valid_until = (now() - interval '2 days')::date WHERE quote_id = $1", [q.id]);
    await ownerQuery('ALTER TABLE quote_versions ENABLE TRIGGER quote_versions_frozen');
    const err1 = await err(decideQuotePublic(q.token, { action: 'approve', version: 1, name: 'Late Larry', acceptTerms: true }, testMeta()));
    expect(['CONFLICT', 'NOT_FOUND']).toContain(err1.code);
  });
});

describe('quotes and jobs', () => {
  async function jobWithWork(w = ws) {
    const { customer, vehicle } = await party(w, 'JobQ');
    const { job } = await createJob(w.ctx, { customerId: customer.id, vehicleId: vehicle.id, complaint: 'Noise' });
    const brakes = await createRecommendedWork(w.ctx, job.id, { description: 'Replace front brake pads', priority: 'URGENT', estimatedLabourCents: 60_000, estimatedMinutes: 90, estimatedPartsCents: 120_000, partsDescription: 'Pads' });
    const wipers = await createRecommendedWork(w.ctx, job.id, { description: 'Replace wipers', estimatedLabourCents: 10_000 });
    return { customer, vehicle, job, brakes, wipers };
  }

  it('builds a quote from recommended work without approving anything', async () => {
    const { customer, vehicle, job, brakes, wipers } = await jobWithWork();
    const q = await createQuote(ws.ctx, { customerId: customer.id, vehicleId: vehicle.id, jobId: job.id, fromJob: true });
    const got = await getQuote(ws.ctx, q.id);
    expect(got.lines.map((l) => l.description)).toEqual(expect.arrayContaining([expect.stringContaining('Replace front brake pads'), expect.stringContaining('Pads'), expect.stringContaining('Replace wipers')]));
    expect(got.version.totalCents).toBe(60_000 + 120_000 + 10_000);
    expect(got.lines.filter((l) => l.recommendedWorkId === brakes.id)).toHaveLength(2); // labour + parts
    const work = (await getJobCard(ws.ctx, job.id)).recommendedWork;
    expect(work.every((w) => w.approvalStatus === 'PENDING')).toBe(true); // creating a quote is not approval
    void wipers;
  });

  it('customer approval approves exactly the work on the quote and leaves diagnostic findings alone', async () => {
    const { customer, vehicle, job, brakes, wipers } = await jobWithWork();
    const q = await createQuote(ws.ctx, { customerId: customer.id, vehicleId: vehicle.id, jobId: job.id, fromJob: true });
    // the workshop drops the wipers from this quote
    const full = await getQuote(ws.ctx, q.id);
    await updateQuote(ws.ctx, q.id, { lines: full.lines.filter((l) => l.recommendedWorkId !== wipers.id).map((l) => ({ ...l })) });
    const s = await sendQuote(ws.ctx, q.id);
    const diagBefore = (await ownerQuery('SELECT count(*)::int AS n FROM diagnoses WHERE job_id = $1', [job.id])).rows[0]!.n;
    await decideQuotePublic(tokenOf(s.customerUrl), { action: 'approve', version: 1, name: 'Pat Payer', acceptTerms: true }, testMeta());
    const work = (await getJobCard(ws.ctx, job.id)).recommendedWork;
    expect(work.find((w) => w.id === brakes.id)).toMatchObject({ approvalStatus: 'APPROVED', approvalMethod: 'ELECTRONIC' });
    expect(work.find((w) => w.id === wipers.id)!.approvalStatus).toBe('PENDING');
    expect((await ownerQuery('SELECT count(*)::int AS n FROM diagnoses WHERE job_id = $1', [job.id])).rows[0]!.n).toBe(diagBefore);
  });

  it('declining a job quote marks that work declined', async () => {
    const { customer, vehicle, job, brakes } = await jobWithWork();
    const q = await createQuote(ws.ctx, { customerId: customer.id, vehicleId: vehicle.id, jobId: job.id, fromJob: true });
    const s = await sendQuote(ws.ctx, q.id);
    await decideQuotePublic(tokenOf(s.customerUrl), { action: 'decline', version: 1, name: 'No Deal' }, testMeta());
    expect((await getJobCard(ws.ctx, job.id)).recommendedWork.find((w) => w.id === brakes.id)!.approvalStatus).toBe('DECLINED');
  });

  it('turns an approved quote with no job into exactly one job, reusing the customer and vehicle', async () => {
    const q = await approvedQuote(ws, { lines: [L('Gearbox oil', 4, 15_000), L('Labour', 1, 45_000, { lineType: 'LABOUR' }), L('Call-out', 1, 20_000, { lineType: 'CHARGE' })] });
    const customersBefore = (await ownerQuery('SELECT count(*)::int AS n FROM customers WHERE business_id = $1', [ws.businessId])).rows[0]!.n;
    const results = await Promise.allSettled([createJobFromQuote(ws.ctx, q.id), createJobFromQuote(ws.ctx, q.id)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const got = await getQuote(ws.ctx, q.id);
    expect(got.job).not.toBeNull();
    const jobs = await ownerQuery('SELECT id FROM job_cards WHERE customer_id = $1', [q.customerId]);
    expect(jobs.rows).toHaveLength(1);
    const card = await getJobCard(ws.ctx, got.job!.id);
    expect(card.job.vehicleId).toBe(q.vehicleId);
    expect(card.parts.some((p) => p.description === 'Gearbox oil' && p.quantity === 4)).toBe(true);
    expect(card.recommendedWork.some((w) => w.description === 'Labour' && w.approvalStatus === 'APPROVED')).toBe(true);
    expect(card.recommendedWork.some((w) => w.description === 'Call-out')).toBe(false); // a charge is billed, not worked
    expect((await ownerQuery('SELECT count(*)::int AS n FROM customers WHERE business_id = $1', [ws.businessId])).rows[0]!.n).toBe(customersBefore);
    expect((await err(createJobFromQuote(ws.ctx, q.id))).code).toBe('CONFLICT');
  });

  it('only approved quotes become jobs', async () => {
    const q = await sentQuote(ws);
    expect((await err(createJobFromQuote(ws.ctx, q.id))).code).toBe('CONFLICT');
  });
});

describe('quote to invoice', () => {
  it('creates a separate invoice that matches the approved quote and cannot be created twice', async () => {
    const q = await approvedQuote(ws);
    const results = await Promise.allSettled([createInvoiceFromQuote(ws.ctx, q.id), createInvoiceFromQuote(ws.ctx, q.id)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const got = await getQuote(ws.ctx, q.id);
    expect(got.quote.status).toBe('CONVERTED');
    expect(got.invoices).toHaveLength(1);
    expect(got.version.totalCents).toBe(got.invoices[0]!.totalCents);
    expect(got.quote.invoicedAt).not.toBeNull();
    // the quote still exists, untouched, with its approval
    expect(got.quote.approvedVersion).toBe(1);
    expect((await err(createInvoiceFromQuote(ws.ctx, q.id))).code).toBe('CONFLICT');
    expect((await err(cancelQuote(ws.ctx, q.id, { reason: 'oops' }))).code).toBe('CONFLICT');
  });

  it('only approved quotes can be invoiced', async () => {
    const q = await sentQuote(ws);
    expect((await err(createInvoiceFromQuote(ws.ctx, q.id))).code).toBe('CONFLICT');
  });
});

describe('cancelling, lists and permissions', () => {
  it('cancelling a quote kills its link and keeps the record', async () => {
    const q = await sentQuote(ws);
    await cancelQuote(ws.ctx, q.id, { reason: 'Customer went elsewhere' });
    expect((await getQuote(ws.ctx, q.id)).quote).toMatchObject({ status: 'CANCELLED', cancelReason: 'Customer went elsewhere' });
    expect((await err(getPublicQuote(q.token, testMeta()))).code).toBe('NOT_FOUND');
    expect((await err(updateQuote(ws.ctx, q.id, { title: 'x' }))).code).toBe('CONFLICT');
    expect((await err(cancelQuote(ws.ctx, q.id, { reason: 'ab' }))).code).toBe('VALIDATION_ERROR');
  });

  it('searches and filters quotes on the server with pagination', async () => {
    const w = await financeWorkspace('Quote Search');
    const a = await party(w, 'Alpha');
    const b = await party(w, 'Beta');
    for (let i = 0; i < 5; i++) await createQuote(w.ctx, { customerId: a.customer.id, vehicleId: a.vehicle.id, lines: [L('Item', 1, (i + 1) * 10_000)] });
    const qb = await createQuote(w.ctx, { customerId: b.customer.id, lines: [L('Item', 1, 500_000)] });
    await sendQuote(w.ctx, qb.id);
    expect((await listQuotes(w.ctx, { pageSize: 2 })).items).toHaveLength(2);
    expect((await listQuotes(w.ctx, { pageSize: 2 })).meta).toMatchObject({ total: 6, totalPages: 3 });
    expect((await listQuotes(w.ctx, { q: qb.number })).items.map((i) => i.id)).toEqual([qb.id]);
    expect((await listQuotes(w.ctx, { q: 'Beta' })).items).toHaveLength(1);
    expect((await listQuotes(w.ctx, { q: a.vehicle.registration! })).items).toHaveLength(5);
    expect((await listQuotes(w.ctx, { status: 'SENT' })).items).toHaveLength(1);
    expect((await listQuotes(w.ctx, { minCents: 400_000 })).items).toHaveLength(1);
    expect((await listQuotes(w.ctx, { sort: 'total', dir: 'asc', pageSize: 1 })).items[0]!.totalCents).toBe(10_000);
    expect((await err(listQuotes(w.ctx, { pageSize: 5000 }))).code).toBe('VALIDATION_ERROR');
  });

  it('technicians have no quote access; advisors can prepare and send but not approve or cancel', async () => {
    const tech = await createMemberCtx(ws, 'technician');
    const advisor = await createMemberCtx(ws, 'service_advisor');
    const { customer } = await party(ws);
    expect((await err(createQuote(tech.ctx, { customerId: customer.id }))).code).toBe('FORBIDDEN');
    expect((await err(listQuotes(tech.ctx, {}))).code).toBe('FORBIDDEN');
    const q = await createQuote(advisor.ctx, { customerId: customer.id, lines: [L('Wipers', 1, 20_000)] });
    await sendQuote(advisor.ctx, q.id);
    expect((await err(approveQuoteOnBehalf(advisor.ctx, q.id, { method: 'PHONE', version: 1 }))).code).toBe('FORBIDDEN');
    expect((await err(cancelQuote(advisor.ctx, q.id, { reason: 'because' }))).code).toBe('FORBIDDEN');
    const manager = await createMemberCtx(ws, 'manager');
    expect((await approveQuoteOnBehalf(manager.ctx, q.id, { method: 'IN_PERSON', version: 1 })).status).toBe('APPROVED');
  });

  it('keeps every action in the business audit log', async () => {
    const q = await sentQuote(ws);
    await drainJobs();
    const actions = (await ownerQuery<{ action: string }>('SELECT action FROM audit_logs WHERE resource_id = $1 ORDER BY created_at', [q.id])).rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['quote.created', 'quote.sent']));
    await withTenant(ws.businessId, async (tx) => expect(await tx.financeEvent.count({ where: { entityId: q.id } })).toBeGreaterThanOrEqual(2));
  });
});
