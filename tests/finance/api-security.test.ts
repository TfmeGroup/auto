import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectPrisma } from '@/server/db/client';
import { GET as quotesGET, POST as quotesPOST } from '@/app/api/v1/quotes/route';
import { GET as quoteGET } from '@/app/api/v1/quotes/[id]/route';
import { POST as quoteSend } from '@/app/api/v1/quotes/[id]/send/route';
import { POST as quoteInvoice } from '@/app/api/v1/quotes/[id]/invoice/route';
import { GET as invGET } from '@/app/api/v1/invoices/[id]/route';
import { GET as invoicesGET } from '@/app/api/v1/invoices/route';
import { POST as invFinalise } from '@/app/api/v1/invoices/[id]/finalise/route';
import { POST as invSend } from '@/app/api/v1/invoices/[id]/send/route';
import { GET as invPdf } from '@/app/api/v1/invoices/[id]/pdf/route';
import { GET as paymentsGET, POST as paymentsPOST } from '@/app/api/v1/payments/route';
import { POST as refundPOST } from '@/app/api/v1/payments/[id]/refund/route';
import { GET as dashGET } from '@/app/api/v1/finance/dashboard/route';
import { GET as profitGET } from '@/app/api/v1/finance/profitability/route';
import { GET as exportGET } from '@/app/api/v1/finance/export/route';
import { GET as settingsGET, PATCH as settingsPATCH } from '@/app/api/v1/finance/settings/route';
import { GET as searchGET } from '@/app/api/v1/finance/search/route';
import { GET as customerFinGET } from '@/app/api/v1/customers/[id]/financials/route';
import { GET as pubQuoteGET } from '@/app/api/public/quotes/[token]/route';
import { POST as pubDecisionPOST } from '@/app/api/public/quotes/[token]/decision/route';
import { GET as pubQuotePdf } from '@/app/api/public/quotes/[token]/pdf/route';
import { GET as pubInvGET } from '@/app/api/public/invoices/[token]/route';
import { GET as pubInvPdf } from '@/app/api/public/invoices/[token]/pdf/route';
import { POST as pubPay } from '@/app/api/public/invoices/[token]/pay/route';
import { POST as webhookPOST } from '@/app/api/webhooks/payments/[provider]/[businessId]/route';
import { call } from '../helpers/http';
import { appClient, createMemberCtx, createWorkspace, ownerQuery, type TestWorkspace } from '../helpers/factory';
import { L, financeWorkspace, issuedInvoice, key, party, pdfText, sentQuote } from '../helpers/finance';

afterAll(disconnectPrisma);

let A: TestWorkspace;
let B: TestWorkspace;
let tech: Awaited<ReturnType<typeof createMemberCtx>>;
const NOPE = '00000000-0000-4000-8000-000000000000';

beforeAll(async () => {
  A = await financeWorkspace('API Shop A', { vat: true });
  B = await financeWorkspace('API Shop B');
  tech = await createMemberCtx(A, 'technician');
});

describe('authentication, CSRF and permissions', () => {
  it('every finance endpoint needs a signed-in member of a business', async () => {
    const id = { params: { id: NOPE } };
    const calls = [
      call(quotesGET), call(quotesPOST, { body: {} }), call(quoteGET, id), call(invoicesGET), call(invGET, id), call(invPdf, id), call(paymentsGET), call(paymentsPOST, { body: {} }), call(refundPOST, { ...id, body: {} }),
      call(dashGET), call(profitGET), call(exportGET, { query: { dataset: 'invoices' } }), call(settingsGET), call(settingsPATCH, { method: 'PATCH', body: {} }), call(searchGET, { query: { q: 'abc' } }), call(customerFinGET, id),
    ];
    for (const r of await Promise.all(calls)) expect(r.status).toBe(401);
  });

  it('refuses state-changing requests that come from another site', async () => {
    const r = await call(quotesPOST, { token: A.ctx.token, origin: 'https://evil.example', body: { customerId: NOPE } });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('CSRF_REJECTED');
    const r2 = await call(paymentsPOST, { token: A.ctx.token, origin: 'https://evil.example', body: { invoiceId: NOPE, amountCents: 100, method: 'CASH' } });
    expect(r2.status).toBe(403);
  });

  it('a technician (no financial role) is refused everywhere, however the request is made', async () => {
    const t = tech.ctx.token;
    const inv = await issuedInvoice(A);
    const q = await sentQuote(A);
    const id = { params: { id: inv.id } };
    const results = await Promise.all([
      call(quotesGET, { token: t }), call(quoteGET, { token: t, params: { id: q.id } }), call(quoteSend, { token: t, params: { id: q.id }, body: {} }), call(invoicesGET, { token: t }), call(invGET, { token: t, ...id }),
      call(invFinalise, { token: t, ...id, body: {} }), call(invPdf, { token: t, ...id }), call(paymentsGET, { token: t }), call(paymentsPOST, { token: t, body: { invoiceId: inv.id, amountCents: 100, method: 'CASH' } }),
      call(refundPOST, { token: t, params: { id: NOPE }, body: { amountCents: 1, reason: 'no no' } }), call(dashGET, { token: t }), call(profitGET, { token: t }), call(exportGET, { token: t, query: { dataset: 'invoices' } }),
      call(customerFinGET, { token: t, params: { id: inv.customerId } }), call(settingsPATCH, { token: t, method: 'PATCH', body: { paymentTermsDays: 1 } }), call(quoteInvoice, { token: t, params: { id: q.id }, body: {} }),
    ]);
    for (const r of results) expect([401, 403]).toContain(r.status);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(results[0]!.body.error.code).toBe('FORBIDDEN');
  });

  it('plan limits are enforced by the endpoint, not the screen', async () => {
    const solo = await financeWorkspace('API Solo');
    await ownerQuery("UPDATE subscriptions SET status='ACTIVE', trial_ends_at=NULL, current_period_end=now()+interval '30 days', plan_id=(SELECT id FROM plans WHERE key='solo') WHERE business_id=$1", [solo.businessId]);
    const { businessContext } = await import('../helpers/factory');
    solo.ctx = await businessContext(solo.owner);
    const r = await call(profitGET, { token: solo.ctx.token });
    expect(r.status).toBe(402);
    expect(r.body.error.code).toBe('FEATURE_NOT_IN_PLAN');
    expect((await call(dashGET, { token: solo.ctx.token })).status).toBe(200);
  });

  it('answers errors safely: no stack traces, SQL, or internals', async () => {
    const bad = await call(quotesPOST, { token: A.ctx.token, body: '{not json' });
    expect(bad.status).toBe(400);
    const invalid = await call(quotesPOST, { token: A.ctx.token, body: { customerId: 'nope' } });
    expect(invalid.status).toBe(422);
    expect(invalid.body.error).toMatchObject({ code: 'VALIDATION_ERROR' });
    const missing = await call(invGET, { token: A.ctx.token, params: { id: NOPE } });
    expect(missing.status).toBe(404);
    for (const r of [bad, invalid, missing]) {
      const text = JSON.stringify(r.body);
      expect(text).not.toMatch(/prisma|postgres|stack|node_modules|SELECT |at .*\.ts/i);
      expect(r.body.error.requestId).toBeTruthy();
    }
  });
});

describe('the whole workflow over HTTP', () => {
  it('quote -> customer approval -> invoice -> payment -> PDF, with a clean JSON envelope', async () => {
    const { customer, vehicle } = await party(A, 'Http');
    const t = A.ctx.token;
    const created = await call(quotesPOST, { token: t, body: { customerId: customer.id, vehicleId: vehicle.id, lines: [L('Brake pads', 2, 50_000), L('Labour', 1.5, 45_000, { lineType: 'LABOUR' })] } });
    expect(created.status).toBe(201);
    const qid = created.body.data.id;
    const got = await call(quoteGET, { token: t, params: { id: qid } });
    expect(got.body.data.version).toMatchObject({ subtotalCents: 167_500, vatCents: 25_125, totalCents: 192_625 });
    const sent = await call(quoteSend, { token: t, params: { id: qid }, body: {} });
    expect(sent.status).toBe(200);
    const token = sent.body.data.customerUrl.split('/q/')[1];

    // the customer, with no sign-in
    const view = await call(pubQuoteGET, { params: { token }, origin: null });
    expect(view.status).toBe(200);
    expect(view.body.data.quote).toMatchObject({ version: 1 });
    expect(view.body.data.totals.totalCents).toBe(192_625);
    const pdf = await call(pubQuotePdf, { params: { token }, origin: null });
    expect(pdf.headers.get('content-type')).toBe('application/pdf');
    expect(pdfText(Buffer.from(await pdf.raw.arrayBuffer()))).toContain('QUOTE');
    const decision = await call(pubDecisionPOST, { params: { token }, body: { action: 'approve', version: 1, name: 'Hannah Http', acceptTerms: true } });
    expect(decision.status).toBe(200);
    expect(decision.body.data).toMatchObject({ status: 'APPROVED' });

    // the workshop converts it
    const inv = await call(quoteInvoice, { token: t, params: { id: qid }, body: {} });
    expect(inv.status).toBe(201);
    const dup = await call(quoteInvoice, { token: t, params: { id: qid }, body: {} });
    expect(dup.status).toBe(409);
    const iid = inv.body.data.id;
    expect((await call(invFinalise, { token: t, params: { id: iid }, body: {} })).status).toBe(200);
    const sentInv = await call(invSend, { token: t, params: { id: iid }, body: {} });
    const itoken = sentInv.body.data.customerUrl.split('/i/')[1];
    const pay1 = await call(paymentsPOST, { token: t, body: { invoiceId: iid, amountCents: 100_000, method: 'EFT', reference: 'HTTP-1', idempotencyKey: key() } });
    expect(pay1.status).toBe(201);
    const k = key();
    const a = await call(paymentsPOST, { token: t, body: { invoiceId: iid, amountCents: 92_625, method: 'CASH', idempotencyKey: k } });
    const b = await call(paymentsPOST, { token: t, body: { invoiceId: iid, amountCents: 92_625, method: 'CASH', idempotencyKey: k } });
    expect([a.status, b.status]).toEqual([201, 200]);
    expect(b.body.data.id).toBe(a.body.data.id);
    const fin = await call(invGET, { token: t, params: { id: iid } });
    expect(fin.body.data.invoice).toMatchObject({ status: 'PAID', outstandingCents: 0, paidCents: 192_625 });
    const ipdf = await call(invPdf, { token: t, params: { id: iid } });
    expect(ipdf.headers.get('content-type')).toBe('application/pdf');
    expect(ipdf.headers.get('content-disposition')).toMatch(/inline/);
    expect(ipdf.headers.get('x-content-type-options')).toBe('nosniff');
    const pubInv = await call(pubInvGET, { params: { token: itoken }, origin: null });
    expect(pubInv.body.data.invoice.status).toBe('PAID');
    const pubInvPdfRes = await call(pubInvPdf, { params: { token: itoken }, origin: null });
    expect(pubInvPdfRes.status).toBe(200);
    const list = await call(paymentsGET, { token: t, query: { q: 'HTTP-1' } });
    expect(list.body.data).toHaveLength(1);
    expect(list.body.meta).toMatchObject({ total: 1 });
    const pg = await call(invoicesGET, { token: t, query: { pageSize: 1, page: 1 } });
    expect(pg.body.meta.pageSize).toBe(1);
  });
});

describe('customer links', () => {
  it('open only the one document they were made for, and nothing for anything else', async () => {
    const q = await sentQuote(A);
    const inv = await issuedInvoice(A, { send: true });
    const itoken = inv.customerUrl!.split('/i/')[1]!;
    expect((await call(pubQuoteGET, { params: { token: q.token }, origin: null })).status).toBe(200);
    expect((await call(pubInvGET, { params: { token: q.token }, origin: null })).status).toBe(404); // a quote link on the invoice endpoint
    expect((await call(pubQuoteGET, { params: { token: itoken }, origin: null })).status).toBe(404);
    for (const bad of ['', 'abc', 'x'.repeat(43), '../../etc/passwd', `${q.token}x`, q.token.slice(1)]) {
      const r = await call(pubQuoteGET, { params: { token: bad }, origin: null });
      expect(r.status, bad).toBe(404);
      expect(JSON.stringify(r.body)).not.toMatch(/expired|revoked|malformed|unknown/i); // never says which part was wrong
      expect(r.body.error.message).toBe('This link is not valid or is no longer available.');
    }
  });

  it('are stored only as hashes, can expire and can be revoked', async () => {
    const q = await sentQuote(A);
    const hash = createHash('sha256').update(q.token).digest('hex');
    const row = await ownerQuery<{ token_hash: string }>('SELECT token_hash FROM document_links WHERE document_id = $1', [q.id]);
    expect(row.rows.map((r) => r.token_hash)).toContain(hash);
    const all = await ownerQuery("SELECT string_agg(token_hash, ',') AS s FROM document_links");
    expect(all.rows[0]!.s).not.toContain(q.token);
    await ownerQuery("UPDATE document_links SET expires_at = now() - interval '1 second' WHERE token_hash = $1", [hash]).catch(async () => {
      await ownerQuery("UPDATE document_links SET created_at = now() - interval '2 days', expires_at = now() - interval '1 day' WHERE token_hash = $1", [hash]);
    });
    expect((await call(pubQuoteGET, { params: { token: q.token }, origin: null })).status).toBe(404);
    const q2 = await sentQuote(A);
    await ownerQuery('UPDATE document_links SET revoked_at = now() WHERE document_id = $1', [q2.id]);
    expect((await call(pubQuoteGET, { params: { token: q2.token }, origin: null })).status).toBe(404);
    expect((await call(pubDecisionPOST, { params: { token: q2.token }, body: { action: 'approve', version: 1, name: 'Late Link', acceptTerms: true } })).status).toBe(404);
  });

  it('cannot be used to read or pay anything in another business', async () => {
    const qB = await sentQuote(B);
    const qA = await sentQuote(A);
    const viewB = await call(pubQuoteGET, { params: { token: qB.token }, origin: null });
    expect(JSON.stringify(viewB.body)).not.toContain(qA.number);
    expect((await call(pubInvGET, { params: { token: qB.token }, origin: null })).status).toBe(404);
    expect((await call(pubPay, { params: { token: qB.token }, body: {} })).status).toBe(404);
  });

  it('never expose internal data to the customer', async () => {
    const { customer } = await party(A, 'Secret');
    const inv = await issuedInvoice(A, { customerId: customer.id, send: true, internalNotes: 'INTERNAL-ONLY-NOTE', lines: [L('Gearbox', 1, 100_000, { unitCostCents: 61_234 })] });
    const itoken = inv.customerUrl!.split('/i/')[1]!;
    const r = await call(pubInvGET, { params: { token: itoken }, origin: null });
    const text = JSON.stringify(r.body);
    for (const leak of ['INTERNAL-ONLY-NOTE', '61234', 'unitCost', 'internalNotes', 'createdBy', 'finalisedBy', 'audit', 'passphrase', 'merchant', 'online_credentials']) expect(text, leak).not.toContain(leak);
    const pdf = pdfText(Buffer.from(await (await call(pubInvPdf, { params: { token: itoken }, origin: null })).raw.arrayBuffer()));
    expect(pdf).not.toContain('INTERNAL-ONLY-NOTE');
    expect(pdf).not.toContain('612,34'); // the cost price R612.34
  });
});

describe('the payment webhook endpoint', () => {
  it('answers 400 to anything it cannot verify and never changes state', async () => {
    for (const [provider, businessId, body] of [['payfast', A.businessId, 'm_payment_id=x&payment_status=COMPLETE'], ['nonexistent', A.businessId, '{}'], ['payfast', 'not-a-uuid', 'x=1'], ['payfast', NOPE, 'x=1']] as const) {
      const r = await call(webhookPOST as never, { method: 'POST', params: { provider, businessId }, body, origin: null });
      expect(r.status, `${provider}/${businessId}`).toBe(400);
    }
    const tooBig = await call(webhookPOST as never, { method: 'POST', params: { provider: 'payfast', businessId: A.businessId }, body: 'x'.repeat(25_000), origin: null });
    expect(tooBig.status).toBe(413);
  });
});

describe('row-level security on every new table', () => {
  it('shows each business only its own money records, and nothing without a business', async () => {
    const invA = await issuedInvoice(A);
    const invB = await issuedInvoice(B);
    const c = await appClient();
    try {
      const count = async (table: string) => Number((await c.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);
      for (const t of ['invoices', 'invoice_lines', 'quotes', 'quote_versions', 'quote_lines', 'payments', 'receipts', 'refunds', 'credit_notes', 'credit_note_lines', 'customer_credit_entries', 'finance_events', 'finance_notifications', 'document_links', 'finance_settings']) {
        expect(await count(t), `${t} without a business`).toBe(0);
      }
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.business_id', $1, true)", [A.businessId]);
      const mine = await c.query('SELECT id FROM invoices');
      expect(mine.rows.map((r) => r.id)).toContain(invA.id);
      expect(mine.rows.map((r) => r.id)).not.toContain(invB.id);
      await expect(c.query("UPDATE invoices SET internal_notes = 'x' WHERE id = $1", [invB.id]).then((r) => r.rowCount)).resolves.toBe(0);
      await expect(c.query(`INSERT INTO finance_events (business_id, entity_type, entity_id, type, actor_kind) VALUES ($1, 'invoice', $2, 'x', 'STAFF')`, [B.businessId, invB.id])).rejects.toThrow(/row-level security/);
      await c.query('ROLLBACK');
    } finally {
      await c.end();
    }
  });

  it('a link hash reveals exactly one link row and no business data', async () => {
    const q = await sentQuote(A);
    const hash = createHash('sha256').update(q.token).digest('hex');
    const c = await appClient();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.link_hash', $1, true)", [hash]);
      const rows = await c.query('SELECT document_id FROM document_links');
      expect(rows.rows).toEqual([{ document_id: q.id }]);
      expect(Number((await c.query('SELECT count(*) AS n FROM quotes')).rows[0].n)).toBe(0); // the link alone opens no business table
      await c.query('ROLLBACK');
    } finally {
      await c.end();
    }
    void createWorkspace;
  });
});
