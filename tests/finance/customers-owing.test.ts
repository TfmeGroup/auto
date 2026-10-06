import { afterAll, describe, expect, it } from 'vitest';
import { disconnectPrisma } from '@/server/db/client';
import { AppError } from '@/lib/errors';
import { listCustomers } from '@/server/customers/service';
import { createMemberCtx } from '../helpers/factory';
import { financeWorkspace, issuedInvoice, party, pay } from '../helpers/finance';

afterAll(disconnectPrisma);

describe('customers who owe money', () => {
  it('lists only customers with an open issued balance, and only for people who may see invoices', async () => {
    const ws = await financeWorkspace('Owing Shop');
    const owes = await party(ws, 'Owes');
    const paid = await party(ws, 'Paid');
    await party(ws, 'Clean');
    await issuedInvoice(ws, { customerId: owes.customer.id, vehicleId: owes.vehicle.id });
    const inv = await issuedInvoice(ws, { customerId: paid.customer.id, vehicleId: paid.vehicle.id });
    await pay(ws, inv.id, 145_000);
    const r = await listCustomers(ws.ctx, { hasBalance: 'true' });
    expect(r.items.map((c) => c!.id)).toEqual([owes.customer.id]);
    expect((await listCustomers(ws.ctx, {})).items).toHaveLength(3);
    const tech = await createMemberCtx(ws, 'technician');
    await expect(listCustomers(tech.ctx, { hasBalance: 'true' })).rejects.toBeInstanceOf(AppError);
  });
});
