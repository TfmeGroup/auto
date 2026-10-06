import { afterAll, describe, expect, it } from 'vitest';
import { disconnectPrisma } from '@/server/db/client';
import { ownerQuery } from '../helpers/factory';

afterAll(disconnectPrisma);

/**
 * Whole-database integrity audit. It reads EVERY tenant's rows (as the database owner, bypassing the application) and looks for
 * the inconsistencies the specification names: orphans, duplicate documents, wrong balances, phantom stock, broken ownership.
 * It runs after the other scenarios in the same database, so it audits everything they created too.
 */
const bad = async (sql: string, params: unknown[] = []) => (await ownerQuery(sql, params)).rows;

describe('structural: references between tenant records can only stay inside one business', () => {
  it('every foreign key between two tenant tables includes business_id (composite), so a record can never point into another business', async () => {
    const rows = await bad(`
      WITH tenant AS (SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'business_id'),
      fks AS (
        SELECT c.conname, c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent,
               (SELECT array_agg(a.attname) FROM unnest(c.conkey) k JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k) AS cols
        FROM pg_constraint c WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
      )
      SELECT conname, child, parent FROM fks
      WHERE child IN (SELECT table_name FROM tenant) AND parent IN (SELECT table_name FROM tenant)
        AND NOT ('business_id' = ANY(cols))`);
    // Reviewed exceptions, each for a reason: a membership points at a role that may be a shared SYSTEM role (a database trigger refuses another
    // business's custom role); subscriptions are platform billing records, written by the provider webhook with no tenant context.
    const reviewed = new Set(['memberships_role_id_fkey', 'subscription_invoices_subscription_id_fkey', 'subscription_payments_subscription_id_fkey']);
    const unexpected = rows.filter((r) => !reviewed.has(r.conname));
    expect(unexpected, JSON.stringify(unexpected)).toEqual([]);
  });

  it('every tenant table has row-level security enabled and forced', async () => {
    const rows = await bad(`
      SELECT c.relname FROM pg_class c JOIN information_schema.columns col ON col.table_name = c.relname AND col.column_name = 'business_id' AND col.table_schema = 'public'
      WHERE c.relkind = 'r' AND c.relnamespace = 'public'::regnamespace AND NOT (c.relrowsecurity AND c.relforcerowsecurity)`);
    // Reviewed exceptions: authentication reads a membership and its role BEFORE a business is chosen; the job queue and the billing records are
    // platform-level (webhooks and workers run with no tenant). Their access is by explicit business filter and permission, and is tested.
    const reviewed = new Set(['roles', 'memberships', 'jobs', 'subscriptions', 'subscription_payments']);
    const unexpected = rows.filter((r) => !reviewed.has(r.relname));
    expect(unexpected, JSON.stringify(unexpected)).toEqual([]);
  });
});

describe('people and permissions', () => {
  it('every business has exactly one active owner and no membership borrows another business\'s role', async () => {
    expect(await bad(`SELECT b.id FROM businesses b LEFT JOIN memberships m ON m.business_id = b.id AND m.is_owner AND m.status = 'ACTIVE' GROUP BY b.id HAVING count(m.id) <> 1`)).toEqual([]);
    expect(await bad(`SELECT m.id FROM memberships m JOIN roles r ON r.id = m.role_id WHERE r.business_id IS NOT NULL AND r.business_id <> m.business_id`)).toEqual([]);
  });
});

describe('money', () => {
  it('invoice balances: outstanding = total - paid - credit applied - credit notes - written off, never negative, for every issued invoice', async () => {
    const rows = await bad(`
      SELECT id FROM invoices WHERE status NOT IN ('DRAFT', 'CANCELLED')
        AND (outstanding_cents <> total_cents - paid_cents - credit_applied_cents - credit_noted_cents - written_off_cents OR outstanding_cents < 0)`);
    expect(rows, JSON.stringify(rows)).toEqual([]);
  });

  it('invoice totals: (subtotal - discount) + VAT = total, and the lines add up to the header', async () => {
    // The amount VAT is charged on is what is left after the discount: taxable = subtotal - discount; total = taxable + VAT.
    const rows = await bad(`SELECT id, (SELECT name FROM businesses b WHERE b.id = invoices.business_id) AS biz, status, subtotal_cents, discount_cents, taxable_cents, vat_cents, total_cents FROM invoices
      WHERE status <> 'DRAFT' AND (taxable_cents + vat_cents <> total_cents OR subtotal_cents - discount_cents <> taxable_cents)`);
    expect(rows, JSON.stringify(rows)).toEqual([]);
    expect(await bad(`
      SELECT i.id FROM invoices i JOIN (SELECT invoice_id, sum(taxable_cents) t, sum(vat_cents) v, sum(total_cents) g FROM invoice_lines GROUP BY invoice_id) l ON l.invoice_id = i.id
      WHERE i.status <> 'DRAFT' AND i.total_cents <> l.g`)).toEqual([]);
  });

  it('an invoice\'s paid amount equals what its payments applied to it, less refunds (refunded payments still count: they hold the refund)', async () => {
    const rows = await bad(`
      SELECT i.id, (SELECT name FROM businesses b WHERE b.id = i.business_id) AS biz, i.status, i.payment_status, i.paid_cents, i.credit_applied_cents, coalesce(p.net, 0) AS net FROM invoices i
      LEFT JOIN (SELECT invoice_id, sum(applied_cents - refunded_applied_cents) AS net FROM payments WHERE status IN ('COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED') AND invoice_id IS NOT NULL GROUP BY invoice_id) p ON p.invoice_id = i.id
      WHERE i.status NOT IN ('DRAFT') AND i.paid_cents <> coalesce(p.net, 0)`);
    expect(rows, JSON.stringify(rows)).toEqual([]);
  });

  it('every completed payment splits exactly into applied + credited, and has exactly one receipt', async () => {
    expect(await bad(`SELECT id FROM payments WHERE status = 'COMPLETED' AND amount_cents <> applied_cents + credited_cents`)).toEqual([]);
    const missing = await bad(`SELECT p.id FROM payments p LEFT JOIN receipts r ON r.payment_id = p.id WHERE p.status = 'COMPLETED' AND r.id IS NULL`);
    expect(missing, JSON.stringify(missing)).toEqual([]);
    expect(await bad(`SELECT payment_id FROM receipts GROUP BY payment_id HAVING count(*) > 1`)).toEqual([]);
  });

  it('no duplicates: one live invoice per job, one invoice per quote, unique numbers, one payment per idempotency key', async () => {
    expect(await bad(`SELECT business_id, job_id FROM invoices WHERE job_id IS NOT NULL AND status <> 'CANCELLED' GROUP BY 1, 2 HAVING count(*) > 1`)).toEqual([]);
    expect(await bad(`SELECT business_id, quote_id FROM invoices WHERE quote_id IS NOT NULL AND status <> 'CANCELLED' GROUP BY 1, 2 HAVING count(*) > 1`)).toEqual([]);
    expect(await bad(`SELECT business_id, number FROM invoices WHERE number IS NOT NULL GROUP BY 1, 2 HAVING count(*) > 1`)).toEqual([]);
    expect(await bad(`SELECT business_id, idempotency_key FROM payments WHERE idempotency_key IS NOT NULL GROUP BY 1, 2 HAVING count(*) > 1`)).toEqual([]);
  });

  it('no customer holds negative credit', async () => {
    const rows = await bad(`SELECT business_id, customer_id, sum(amount_cents) AS bal FROM customer_credit_entries GROUP BY 1, 2 HAVING sum(amount_cents) < 0`);
    expect(rows, JSON.stringify(rows)).toEqual([]);
  });
});

describe('stock', () => {
  it('every stock level equals the sum of its movements (the ledger is the truth)', async () => {
    const rows = await bad(`
      SELECT l.business_id, l.part_id, l.location_id, l.on_hand, l.reserved, coalesce(m.oh, 0) AS ledger_on_hand, coalesce(m.rs, 0) AS ledger_reserved
      FROM stock_levels l
      LEFT JOIN (SELECT business_id, part_id, location_id, sum(on_hand_delta) oh, sum(reserved_delta) rs FROM stock_movements GROUP BY 1, 2, 3) m
        ON m.business_id = l.business_id AND m.part_id = l.part_id AND m.location_id = l.location_id
      WHERE l.on_hand <> coalesce(m.oh, 0) OR l.reserved <> coalesce(m.rs, 0)`);
    expect(rows, JSON.stringify(rows)).toEqual([]);
  });

  it('nothing is negative unless it went negative through the explicitly permitted route, and reservations never exceed what is held', async () => {
    const rows = await bad(`
      SELECT l.* FROM stock_levels l WHERE (l.on_hand < 0 OR l.reserved < 0 OR l.reserved > greatest(l.on_hand, 0))
        AND NOT EXISTS (SELECT 1 FROM stock_movements m WHERE m.business_id = l.business_id AND m.part_id = l.part_id AND m.location_id = l.location_id AND m.went_negative)`);
    expect(rows, JSON.stringify(rows)).toEqual([]);
  });

  it('there are no phantom reservations: reserved units equal the job-part lines still holding a reservation', async () => {
    const rows = await bad(`
      SELECT s.business_id, s.part_id, s.r AS reserved, coalesce(j.q, 0) AS held_by_jobs FROM (SELECT business_id, part_id, sum(reserved) r FROM stock_levels GROUP BY 1, 2) s
      LEFT JOIN (SELECT business_id, inventory_item_id AS part_id, sum(quantity) q FROM job_parts WHERE status = 'RESERVED' GROUP BY 1, 2) j
        ON j.business_id = s.business_id AND j.part_id = s.part_id
      WHERE s.r <> coalesce(j.q, 0)`);
    expect(rows, JSON.stringify(rows)).toEqual([]);
  });
});

describe('workflow', () => {
  it('a completed job has no catalogue part still reserved, and a cancelled job holds nothing (a reservation is a claim on STOCK; free-text lines hold none)', async () => {
    expect(await bad(`SELECT j.id, (SELECT name FROM businesses b WHERE b.id = j.business_id) AS biz, j.status, p.status AS part_status FROM job_cards j JOIN job_parts p ON p.job_id = j.id WHERE j.status IN ('COMPLETED', 'CANCELLED') AND p.status = 'RESERVED' AND p.inventory_item_id IS NOT NULL`)).toEqual([]);
  });

  it('records point at records of the same customer: a job\'s vehicle belongs to the job\'s customer, an invoice\'s job to its customer', async () => {
    expect(await bad(`SELECT j.id FROM job_cards j JOIN vehicles v ON v.id = j.vehicle_id WHERE v.customer_id <> j.customer_id`)).toEqual([]);
    expect(await bad(`SELECT i.id FROM invoices i JOIN job_cards j ON j.id = i.job_id WHERE j.customer_id <> i.customer_id`)).toEqual([]);
    expect(await bad(`SELECT p.id FROM payments p JOIN invoices i ON i.id = p.invoice_id WHERE i.customer_id <> p.customer_id`)).toEqual([]);
    expect(await bad(`SELECT b.id FROM bookings b JOIN vehicles v ON v.id = b.vehicle_id WHERE v.customer_id <> b.customer_id`)).toEqual([]);
  });

  it('every file belongs to the business of the record it is attached to', async () => {
    expect(await bad(`SELECT f.id FROM files f JOIN job_cards j ON f.resource_type = 'job' AND f.resource_id = j.id::text WHERE j.business_id <> f.business_id`)).toEqual([]);
    expect(await bad(`SELECT f.id FROM files f JOIN customers c ON f.resource_type = 'customer' AND f.resource_id = c.id::text WHERE c.business_id <> f.business_id`)).toEqual([]);
  });
});
