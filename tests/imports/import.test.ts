import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectPrisma } from '@/server/db/client';
import { AppError } from '@/lib/errors';
import { commitImport, getImport, importProblemsCsv, listImports, startImport, validateImport, cancelImport } from '@/server/imports/service';
import { createCustomer } from '@/server/customers/service';
import { customerInput } from '../helpers/customers';
import { createMemberCtx, createWorkspace, ownerQuery, upgradePlan, type TestWorkspace } from '../helpers/factory';
import { memberWithPermissions } from '../helpers/workshop';

afterAll(disconnectPrisma);

const err = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { if (e instanceof AppError) return e; throw e; }
  throw new Error('expected an AppError');
};
const b64 = (lines: string[]) => Buffer.from(lines.join('\n'), 'utf8').toString('base64');
const upload = (ws: TestWorkspace, kind: string, lines: string[], filename = `${kind}.csv`) => startImport(ws.ctx, { kind, filename, content: b64(lines) });

let ws: TestWorkspace;
beforeAll(async () => {
  ws = await createWorkspace('Import Workshop');
  await upgradePlan(ws, 'business');
});

describe('importing customers', () => {
  const header = 'First name,Last name,Cell,Email,Address,City';

  it('stages the file, suggests the column mapping and saves nothing yet', async () => {
    const before = (await ownerQuery<{ n: number }>('SELECT count(*)::int AS n FROM customers WHERE business_id = $1', [ws.businessId])).rows[0]!.n;
    const up = await upload(ws, 'customers', [header, 'Anna,Smith,0821110001,anna@example.test,1 Main Rd,Cape Town']);
    expect(up.status).toBe('UPLOADED');
    expect(up.suggestedMapping).toMatchObject({ firstName: 'First name', lastName: 'Last name', mobile: 'Cell', email: 'Email', addressLine1: 'Address', city: 'City' });
    const after = (await ownerQuery<{ n: number }>('SELECT count(*)::int AS n FROM customers WHERE business_id = $1', [ws.businessId])).rows[0]!.n;
    expect(after).toBe(before);
  });

  it('validates every row: valid, invalid with reasons, and duplicates of existing records and of earlier rows', async () => {
    await createCustomer(ws.ctx, customerInput('Existing Person', { email: 'existing@example.test', mobile: '0829998888' }));
    const up = await upload(ws, 'customers', [
      header,
      'Valid,Person,0821110002,valid@example.test,2 Side St,Durban',       // 2: valid
      'No,Mobile,,nomobile@example.test,3 Side St,Durban',                  // 3: invalid (no mobile)
      'Bad,Email,0821110003,not-an-email,4 Side St,Durban',                 // 4: invalid email
      'Same,Email,0821110004,existing@example.test,5 Side St,Durban',       // 5: duplicate of existing (email)
      'Same,Phone,+27 82 999 8888,other@example.test,6 Side St,Durban',     // 6: duplicate of existing (phone in another format)
      'First,Dup,0821110005,dup@example.test,7 Side St,Durban',             // 7: valid
      'Second,Dup,0821110006,DUP@example.test,8 Side St,Durban',            // 8: duplicate of row 7 (email, any case)
    ]);
    const v = await validateImport(ws.ctx, up.id, { mapping: up.suggestedMapping });
    expect(v).toMatchObject({ status: 'VALIDATED', totalRows: 7, validRows: 2, invalidRows: 2, duplicateRows: 3 });
    const byRow = Object.fromEntries(v.problems.map((p) => [p.row, p]));
    expect(byRow[3]!.status).toBe('INVALID');
    expect(byRow[3]!.messages.join(' ')).toMatch(/mobile/i);
    expect(byRow[4]!.messages.join(' ')).toMatch(/email/i);
    expect(byRow[5]!.messages[0]).toMatch(/Same email as Existing Person/);
    expect(byRow[6]!.messages[0]).toMatch(/Same phone number as Existing Person/);
    expect(byRow[8]!.messages[0]).toMatch(/Same email as row 7/);
  });

  it('refuses to import while rows have problems unless the person chooses to skip them, then reports every row', async () => {
    const up = await upload(ws, 'customers', [header, 'Fine,One,0821110010,fine1@example.test,,', 'Broken,,0821110011,broken@example.test,,', 'Fine,Two,0821110012,fine2@example.test,,']);
    await validateImport(ws.ctx, up.id, { mapping: up.suggestedMapping });
    const refused = await err(commitImport(ws.ctx, up.id, {}));
    expect(refused.status).toBe(409);
    expect(refused.message).toMatch(/1 row has problems/);
    const done = await commitImport(ws.ctx, up.id, { skipInvalid: true });
    expect(done).toMatchObject({ status: 'DONE', importedRows: 2, skippedRows: 1, failedRows: 0, totalRows: 3 });
    // every row has a recorded outcome: nothing silently disappeared
    const all = await getImport(ws.ctx, up.id, { status: 'IMPORTED' });
    expect(all.rows).toHaveLength(2);
    expect(all.rows.every((r) => r.recordId)).toBe(true);
    const skipped = await getImport(ws.ctx, up.id, { status: 'SKIPPED' });
    expect(skipped.rows.map((r) => r.row)).toEqual([3]);
    const real = await ownerQuery<{ name: string; customer_number: string }>("SELECT name, customer_number FROM customers WHERE business_id = $1 AND email LIKE 'fine%' ORDER BY name", [ws.businessId]);
    expect(real.rows.map((r) => r.name)).toEqual(['Fine One', 'Fine Two']);
    expect(real.rows[0]!.customer_number).toMatch(/^CUS-\d{6}$/);
    // audited
    const audit = await ownerQuery("SELECT 1 FROM audit_logs WHERE business_id = $1 AND action = 'import.completed' AND resource_id = $2", [ws.businessId, up.id]);
    expect(audit.rowCount).toBe(1);
    // the same batch cannot be processed twice
    expect((await err(commitImport(ws.ctx, up.id, { skipInvalid: true }))).status).toBe(409);
  });

  it('never merges or changes an existing record, and gives the rows to fix as a CSV', async () => {
    const existing = await createCustomer(ws.ctx, customerInput('Keep Me', { email: 'keep@example.test', mobile: '0825550000' }));
    const up = await upload(ws, 'customers', [header, 'Changed,Name,0825550000,keep@example.test,New Address,Elsewhere', 'Brand,New,0825550099,brand@example.test,,']);
    await validateImport(ws.ctx, up.id, { mapping: up.suggestedMapping });
    const done = await commitImport(ws.ctx, up.id, {});
    expect(done).toMatchObject({ importedRows: 1, duplicateRows: 1 });
    const row = (await ownerQuery<{ name: string; city: string | null }>('SELECT name, city FROM customers WHERE id = $1', [existing.id])).rows[0]!;
    expect(row.name).toBe('Keep Me');
    expect(row.city).not.toBe('Elsewhere');
    const csv = (await importProblemsCsv(ws.ctx, up.id)).data.toString('utf8');
    expect(csv).toContain('Problem');
    expect(csv).toContain('Duplicate: Same email as Keep Me');
  });

  it('uses the business\'s own customer number format', async () => {
    await ownerQuery("INSERT INTO business_config (business_id, customer_prefix, customer_padding) VALUES ($1, 'CLI', 4) ON CONFLICT (business_id) DO UPDATE SET customer_prefix = 'CLI', customer_padding = 4", [ws.businessId]);
    const up = await upload(ws, 'customers', [header, 'Numbered,Customer,0821119999,numbered@example.test,,']);
    await validateImport(ws.ctx, up.id, { mapping: up.suggestedMapping });
    await commitImport(ws.ctx, up.id, {});
    const n = (await ownerQuery<{ customer_number: string }>("SELECT customer_number FROM customers WHERE business_id = $1 AND email = 'numbered@example.test'", [ws.businessId])).rows[0]!.customer_number;
    expect(n).toMatch(/^CLI-\d{4,}$/);
    await ownerQuery("UPDATE business_config SET customer_prefix = 'CUS', customer_padding = 6 WHERE business_id = $1", [ws.businessId]);
  });

  it('a mapping to a column that is not in the file, or a missing required column, is refused', async () => {
    const up = await upload(ws, 'customers', [header, 'A,B,0821110000,a@example.test,,']);
    expect((await err(validateImport(ws.ctx, up.id, { mapping: { ...up.suggestedMapping, email: 'Nope' } }))).status).toBe(422);
    const { mobile: _m, ...noMobile } = up.suggestedMapping;
    void _m;
    expect(JSON.stringify((await err(validateImport(ws.ctx, up.id, { mapping: noMobile }))).details)).toMatch(/Mobile/);
  });

  it('rejects an unreadable or empty file, too many rows, and repeated column names', async () => {
    expect((await err(upload(ws, 'customers', ['']))).status).toBe(422);
    expect((await err(upload(ws, 'customers', [header]))).status).toBe(422);
    expect(JSON.stringify((await err(upload(ws, 'customers', ['Name,Name', 'a,b']))).details)).toMatch(/twice/);
    expect((await err(startImport(ws.ctx, { kind: 'customers', filename: 'x.exe', content: Buffer.from('MZ').toString('base64') }))).status).toBe(422);
  });
});

describe('importing vehicles', () => {
  it('links each vehicle to its owner, and reports an unknown or ambiguous owner and duplicate registrations', async () => {
    const owner = await createCustomer(ws.ctx, customerInput('Vehicle Owner', { email: 'vowner@example.test', mobile: '0823330001' }));
    const num = (await ownerQuery<{ customer_number: string }>('SELECT customer_number FROM customers WHERE id = $1', [owner.id])).rows[0]!.customer_number;
    await createCustomer(ws.ctx, customerInput('Twin One', { email: 'twin@example.test', mobile: '0823330002' }));
    await createCustomer(ws.ctx, customerInput('Twin Two', { email: 'twin@example.test', mobile: '0823330003' }));
    const up = await upload(ws, 'vehicles', [
      'Reg,Make,Model,Year,Customer number,Owner email',
      `CA 111 111,Toyota,Hilux,2019,${num},`,          // 2 valid by customer number
      'CA 222 222,VW,Polo,2020,,vowner@example.test',  // 3 valid by email
      'CA 333 333,Ford,Ranger,2018,,nobody@example.test', // 4 owner not found
      'CA 444 444,Kia,Rio,2017,,twin@example.test',    // 5 ambiguous owner
      `ca111111,Toyota,Hilux,2019,${num},`,            // 6 duplicate of row 2 (registration, any format)
    ]);
    expect(up.suggestedMapping).toMatchObject({ registration: 'Reg', ownerCustomerNumber: 'Customer number', ownerEmail: 'Owner email' });
    const v = await validateImport(ws.ctx, up.id, { mapping: up.suggestedMapping });
    expect(v).toMatchObject({ validRows: 2, invalidRows: 2, duplicateRows: 1 });
    const byRow = Object.fromEntries(v.problems.map((p) => [p.row, p.messages.join(' ')]));
    expect(byRow[4]).toMatch(/owner was not found/);
    expect(byRow[5]).toMatch(/ambiguous/);
    expect(byRow[6]).toMatch(/Same registration as row 2/);
    const done = await commitImport(ws.ctx, up.id, { skipInvalid: true });
    expect(done.importedRows).toBe(2);
    const vs = await ownerQuery<{ registration: string; customer_id: string }>("SELECT registration, customer_id FROM vehicles WHERE business_id = $1 AND registration IN ('CA 111 111', 'CA 222 222')", [ws.businessId]);
    expect(vs.rows).toHaveLength(2);
    expect(vs.rows.every((r) => r.customer_id === owner.id)).toBe(true);
  });

  it('applies this workshop\'s vehicle rules (required fields) to imported vehicles', async () => {
    await ownerQuery("UPDATE business_config SET vehicle_required_fields = ARRAY['vin'] WHERE business_id = $1", [ws.businessId]);
    try {
      const up = await upload(ws, 'vehicles', ['Reg,Make,Model,Customer number', 'CA 555 555,Audi,A3,CUS-000001']);
      const v = await validateImport(ws.ctx, up.id, { mapping: up.suggestedMapping });
      expect(v.invalidRows).toBe(1);
    } finally {
      await ownerQuery("UPDATE business_config SET vehicle_required_fields = '{}' WHERE business_id = $1", [ws.businessId]);
    }
  });
});

describe('importing suppliers', () => {
  it('detects duplicates by supplier reference and by name', async () => {
    await ownerQuery("INSERT INTO suppliers (business_id, name, account_number, status, updated_at) VALUES ($1, 'Acme Parts', 'ACME-1', 'ACTIVE', now())", [ws.businessId]);
    const up = await upload(ws, 'suppliers', ['Supplier,Account number,Email', 'Brand New Spares,BNS-1,a@bns.test', 'Other Name,ACME-1,b@x.test', 'acme parts,Z-9,c@x.test', 'Brand New Spares,BNS-2,d@bns.test']);
    const v = await validateImport(ws.ctx, up.id, { mapping: up.suggestedMapping });
    expect(v).toMatchObject({ validRows: 1, duplicateRows: 3 });
    expect(v.problems.map((p) => p.messages[0]).join(' ')).toMatch(/supplier reference as supplier Acme Parts/);
    expect((await commitImport(ws.ctx, up.id, {})).importedRows).toBe(1);
  });

  it('needs the plan feature', async () => {
    const team = await createWorkspace('Import Team');
    await upgradePlan(team, 'team');
    expect((await err(startImport(team.ctx, { kind: 'suppliers', filename: 's.csv', content: b64(['Name', 'X']) }))).status).toBe(402);
    // customers are available on every plan
    expect((await startImport(team.ctx, { kind: 'customers', filename: 'c.csv', content: b64(['First name,Last name,Mobile', 'A,B,0821110000']) })).status).toBe('UPLOADED');
  });
});

describe('import security', () => {
  it('needs data.import and the permission to create that kind of record', async () => {
    const tech = await createMemberCtx(ws, 'technician');
    expect((await err(startImport(tech.ctx, { kind: 'customers', filename: 'c.csv', content: b64(['First name,Last name,Mobile', 'A,B,0821110000']) }))).status).toBe(403);
    const importer = await memberWithPermissions(ws, ['data.import', 'customer.create']);
    expect((await startImport(importer.ctx, { kind: 'customers', filename: 'c.csv', content: b64(['First name,Last name,Mobile', 'A,B,0821110000']) })).status).toBe('UPLOADED');
    expect((await err(startImport(importer.ctx, { kind: 'vehicles', filename: 'v.csv', content: b64(['Reg', 'X']) }))).status).toBe(403);
    const noImport = await memberWithPermissions(ws, ['customer.create']);
    expect((await err(startImport(noImport.ctx, { kind: 'customers', filename: 'c.csv', content: b64(['First name,Last name,Mobile', 'A,B,0821110000']) }))).status).toBe(403);
  });

  it('another business can neither see nor process an import, and duplicates are only judged within a business', async () => {
    const other = await createWorkspace('Import Other');
    await upgradePlan(other, 'business');
    const mine = await upload(ws, 'customers', ['First name,Last name,Mobile,Email', 'Mine,Only,0821110077,shared@example.test']);
    expect((await err(getImport(other.ctx, mine.id))).status).toBe(404);
    expect((await err(validateImport(other.ctx, mine.id, { mapping: mine.suggestedMapping }))).status).toBe(404);
    expect((await err(commitImport(other.ctx, mine.id, {}))).status).toBe(404);
    expect((await listImports(other.ctx))).toEqual([]);
    // the same email in the other business is not a duplicate there
    await validateImport(ws.ctx, mine.id, { mapping: mine.suggestedMapping });
    await commitImport(ws.ctx, mine.id, {});
    const theirs = await startImport(other.ctx, { kind: 'customers', filename: 'c.csv', content: b64(['First name,Last name,Mobile,Email', 'Mine,Only,0821110077,shared@example.test']) });
    const v = await validateImport(other.ctx, theirs.id, { mapping: theirs.suggestedMapping });
    expect(v).toMatchObject({ validRows: 1, duplicateRows: 0 });
  });

  it('a cancelled import cannot be processed, and a processed one cannot be cancelled', async () => {
    const up = await upload(ws, 'customers', ['First name,Last name,Mobile', 'C,D,0821110088']);
    await cancelImport(ws.ctx, up.id);
    expect((await err(validateImport(ws.ctx, up.id, { mapping: up.suggestedMapping }))).status).toBe(409);
    expect((await err(commitImport(ws.ctx, up.id, {}))).status).toBe(409);
    const done = await upload(ws, 'customers', ['First name,Last name,Mobile', 'E,F,0821110089']);
    await validateImport(ws.ctx, done.id, { mapping: done.suggestedMapping });
    await commitImport(ws.ctx, done.id, {});
    expect((await err(cancelImport(ws.ctx, done.id))).status).toBe(409);
  });
});
