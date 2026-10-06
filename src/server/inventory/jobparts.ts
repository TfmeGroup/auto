import { Errors, isAppError } from '@/lib/errors';
import type { Tx } from '@/server/db/client';
import { recordAudit, AuditActions } from '@/server/audit/audit';
import { recordActivity } from '@/server/activity/service';
import { can } from '@/server/permissions/authorize';
import { usersWithPermission } from '@/server/finance/notify';
import { notifyInApp } from '@/server/notifications/service';
import type { BusinessContext } from '@/server/context';
import type { JobRow } from '@/server/jobcards/common';
import { assertStockLocation, actorOf, loadInventorySettings, type InventorySettingsRow } from './common';
import { applyMovement } from './stock';

/**
 * Parts on job cards that come from the catalogue. The states are the Part 3 ones, now with real stock behind them:
 *
 *   Requested / Ordered   nothing held
 *   Reserved              promised to this job: reserved goes up, on hand does not change, available goes down
 *   Fitted                actually used: on hand goes down and the reservation (if there was one) is released, in ONE movement,
 *                         so stock is never taken twice
 *   Returned              back on the shelf (a fitted part) or the reservation released (an unused one)
 *
 * Every move writes a movement carrying the job, the job part, the user and the time. Selling price is copied from the catalogue
 * when the part is added (what the customer was told) and the cost is copied when the part is actually used (what it cost the
 * workshop then); neither changes when the catalogue does. A fitted part is only ever undone by returning it, and one that is already
 * on an invoice needs the proper credit note first.
 */

export type JobPartRow = Awaited<ReturnType<Tx['jobPart']['findFirstOrThrow']>>;
export type JobPartTarget = 'REQUESTED' | 'ORDERED' | 'RESERVED' | 'FITTED' | 'RETURNED';

const STOCK_REF = { referenceType: 'job_part' } as const;

async function defaultLocationFor(tx: Tx, ctx: BusinessContext, job: Pick<JobRow, 'locationId'>, chosen?: string | null): Promise<string> {
  if (chosen) {
    await assertStockLocation(tx, ctx, chosen);
    return chosen;
  }
  if (job.locationId) {
    await assertStockLocation(tx, ctx, job.locationId);
    return job.locationId;
  }
  const def = await tx.location.findFirst({ where: { businessId: ctx.business.id, isDefault: true, status: 'ACTIVE' }, select: { id: true } });
  if (!def) throw Errors.validation({ stockLocationId: 'There is no location to take the stock from.' });
  await assertStockLocation(tx, ctx, def.id);
  return def.id;
}

async function assertPartUsable(tx: Tx, businessId: string, partId: string) {
  const p = await tx.part.findFirst({ where: { id: partId, businessId } });
  if (!p) throw Errors.validation({ inventoryItemId: 'Choose a part from your catalogue.' });
  if (p.status !== 'ACTIVE') throw Errors.validation({ inventoryItemId: `${p.sku} is ${p.status.toLowerCase()} and cannot be used on a job.` });
  return p;
}

export interface AddCatalogueInput {
  inventoryItemId: string;
  quantity: number;
  stockLocationId?: string | null;
  /** Wanted state. Left out = reserve straight away if the business does that and there is enough, otherwise just request it. */
  status?: JobPartTarget;
  sellPriceCents?: number | null;
  recommendedWorkId?: string | null;
}

/** Add a catalogue part to a job. Returns the new line and, when it could not be reserved, how many are available. */
export async function addCatalogueJobPart(tx: Tx, ctx: BusinessContext, job: JobRow, d: AddCatalogueInput): Promise<{ part: JobPartRow; unavailable: { available: number } | null }> {
  const catalogue = await assertPartUsable(tx, ctx.business.id, d.inventoryItemId);
  const settings = await loadInventorySettings(tx, ctx.business.id);
  const locationId = await defaultLocationFor(tx, ctx, job, d.stockLocationId);
  const created = await tx.jobPart.create({
    data: {
      businessId: ctx.business.id, jobId: job.id, inventoryItemId: catalogue.id, stockLocationId: locationId, recommendedWorkId: d.recommendedWorkId ?? null, description: catalogue.name,
      partNumber: catalogue.partNumber ?? catalogue.sku, quantity: d.quantity, costCents: catalogue.costCents, sellPriceCents: d.sellPriceCents !== undefined ? d.sellPriceCents : catalogue.sellPriceCents, status: 'REQUESTED', addedById: ctx.user.id,
    },
  });
  await recordAudit(tx, ctx.meta, { action: AuditActions.jobPartChanged, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'job', resourceId: job.id, metadata: { partId: created.id, change: 'added', sku: catalogue.sku, quantity: d.quantity, catalogue: true } });
  await recordActivity(tx, ctx.business.id, ctx.user.id, { type: 'job.part_added', summary: `Part added: ${d.quantity} × ${catalogue.name}`, customerId: job.customerId, vehicleId: job.vehicleId, jobId: job.id });

  const wanted: JobPartTarget = d.status ?? (settings.autoReserveOnJobAdd ? 'RESERVED' : 'REQUESTED');
  if (wanted === 'REQUESTED') return { part: created, unavailable: null };
  try {
    const part = await setJobPartState(tx, ctx, job, created, wanted, { settings });
    return { part, unavailable: null };
  } catch (err) {
    // Reserving automatically is a convenience: if there is not enough, the part stays Requested and staff are told. An explicit request fails.
    if (d.status === undefined && isAppError(err) && (err.details as { code?: string } | undefined)?.code === 'INSUFFICIENT_STOCK') {
      const available = Math.max(0, Number((err.details as { available?: number }).available ?? 0));
      await notifyUnavailable(tx, ctx, job, catalogue.sku, catalogue.name, d.quantity, available);
      return { part: created, unavailable: { available } };
    }
    throw err;
  }
}

async function notifyUnavailable(tx: Tx, ctx: BusinessContext, job: JobRow, sku: string, name: string, wanted: number, available: number) {
  const staff = await usersWithPermission(tx, ctx.business.id, 'inventory.edit');
  for (const u of staff) {
    if (u.id === ctx.user.id) continue;
    await notifyInApp(tx, { businessId: ctx.business.id, userId: u.id, type: 'JOB_PART_UNAVAILABLE', title: `${sku} is not available for job ${job.jobNumber}`, body: `${name}: ${wanted} needed, ${available} available. It is on the job as Requested.`, linkUrl: `/jobs/${job.id}` });
  }
}

/** Is this fitted part on an invoice? Draft invoices must be fixed first; an issued one needs a credit note and an explicit acknowledgement. */
async function assertReturnAllowed(tx: Tx, businessId: string, jp: JobPartRow, acknowledge: boolean): Promise<{ invoiceNumber: string | null }> {
  const line = await tx.invoiceLine.findFirst({
    where: { businessId, jobPartId: jp.id, invoice: { status: { not: 'CANCELLED' } } },
    select: { invoice: { select: { number: true, status: true, creditNotedCents: true } } },
  });
  if (!line) return { invoiceNumber: null };
  const inv = line.invoice;
  if (inv.status === 'DRAFT') throw Errors.conflict('This part is on a draft invoice. Remove it from the invoice first, then return it.');
  if (inv.creditNotedCents <= 0) throw Errors.conflict(`This part has already been invoiced on ${inv.number}. Issue a credit note for it first (Credit notes), then return the part.`);
  if (!acknowledge) throw Errors.conflict(`This part is on invoice ${inv.number}, which has a credit note. Confirm that the credit note covers it before putting the part back on the shelf.`, { code: 'NEEDS_CREDIT_NOTE_ACK' });
  return { invoiceNumber: inv.number };
}

export interface SetStateOptions {
  quantity?: number;
  settings?: InventorySettingsRow;
  acknowledgeCreditNote?: boolean;
}

/**
 * Move a catalogue job part to a new state (and/or quantity) and make the stock follow. The caller holds the job row lock, so changes
 * to one job are applied one after another; the stock row lock (and the database) decides between jobs.
 */
export async function setJobPartState(tx: Tx, ctx: BusinessContext, job: JobRow, jp: JobPartRow, to: JobPartTarget, o: SetStateOptions = {}): Promise<JobPartRow> {
  if (!jp.inventoryItemId) throw Errors.badRequest('This part is not from the catalogue.');
  const settings = o.settings ?? (await loadInventorySettings(tx, ctx.business.id));
  const q = o.quantity ?? jp.quantity;
  const from = jp.status as JobPartTarget;
  if (from === to && q === jp.quantity) return jp;
  if (from === 'RETURNED') throw Errors.conflict('This part has already been returned.');
  if (from === 'FITTED' && to !== 'RETURNED') throw Errors.conflict('A fitted part can only be returned.');
  if (from === 'FITTED' && q !== jp.quantity) throw Errors.conflict('The quantity of a fitted part cannot change. Return it and add it again.');
  if (to === 'RETURNED' && o.quantity !== undefined && q !== jp.quantity) throw Errors.conflict('Return the whole line.');
  if (q < 1) throw Errors.validation({ quantity: 'At least 1.' });
  const locationId = jp.stockLocationId ?? (await defaultLocationFor(tx, ctx, job));
  const partId = jp.inventoryItemId;
  const actor = actorOf(ctx);
  const ref = { ...STOCK_REF, referenceId: jp.id, jobId: job.id, jobPartId: jp.id };
  const mv = (key: string) => `jobpart:${jp.id}:${key}`;
  const patch: Record<string, unknown> = { status: to, quantity: q, stockLocationId: locationId };

  if (from !== 'FITTED' && (to === 'RESERVED' || to === 'FITTED')) await assertPartUsable(tx, ctx.business.id, partId);

  if (from === 'RESERVED' && to === 'RESERVED') {
    // Same state, different quantity: reserve or release the difference.
    const diff = q - jp.quantity;
    await applyMovement(tx, actor, { partId, locationId, type: diff > 0 ? 'RESERVED' : 'UNRESERVED', onHandDelta: 0, reservedDelta: diff, ...ref, reason: `Quantity on job ${job.jobNumber} changed from ${jp.quantity} to ${q}`, idempotencyKey: mv(`qty:${jp.quantity}->${q}:${jp.updatedAt.getTime()}`) }, { settings });
  } else {
    // 1. release what this line is holding when it is leaving "reserved" for something other than "fitted"
    if (from === 'RESERVED' && to !== 'FITTED') {
      await applyMovement(tx, actor, { partId, locationId, type: 'UNRESERVED', onHandDelta: 0, reservedDelta: -jp.quantity, ...ref, reason: to === 'RETURNED' ? `Released: not used on job ${job.jobNumber}` : `Reservation released on job ${job.jobNumber}`, idempotencyKey: mv(`release:${jp.updatedAt.getTime()}`) }, { settings });
    }
    // 2. take what the new state needs
    if (to === 'RESERVED') {
      await applyMovement(tx, actor, { partId, locationId, type: 'RESERVED', onHandDelta: 0, reservedDelta: q, ...ref, reason: `Reserved for job ${job.jobNumber}`, idempotencyKey: mv(`reserve:${jp.updatedAt.getTime()}`) }, { settings });
      patch.reservedAt = new Date();
    }
    if (to === 'FITTED') {
      const held = from === 'RESERVED';
      const r = await applyMovement(tx, actor, { partId, locationId, type: 'USED', onHandDelta: -q, reservedDelta: held ? -q : 0, ...ref, reason: `Used on job ${job.jobNumber}`, idempotencyKey: mv(`use:${jp.updatedAt.getTime()}`) }, { settings });
      patch.fittedAt = new Date();
      patch.fittedById = ctx.user.id;
      if (r.movement.unitCostCents !== null) patch.costCents = r.movement.unitCostCents; // what it cost the workshop when it was used
    }
    if (to === 'RETURNED' && from === 'FITTED') {
      const { invoiceNumber } = await assertReturnAllowed(tx, ctx.business.id, jp, !!o.acknowledgeCreditNote);
      await applyMovement(tx, actor, { partId, locationId, type: 'RETURNED', onHandDelta: jp.quantity, unitCostCents: jp.costCents, ...ref, reason: `Returned from job ${job.jobNumber}${invoiceNumber ? ` (credit note on ${invoiceNumber})` : ''}`, idempotencyKey: mv(`return:${jp.updatedAt.getTime()}`) }, { settings });
    }
    if (to === 'RETURNED') patch.returnedAt = new Date();
    if (to !== 'RESERVED' && from === 'RESERVED') patch.reservedAt = null;
  }

  const after = await tx.jobPart.update({ where: { id: jp.id }, data: patch });
  await recordAudit(tx, ctx.meta, { action: AuditActions.jobPartChanged, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'job', resourceId: job.id, metadata: { partId: jp.id, change: 'stock', from, to, quantity: q, catalogue: true } });
  if (from !== to) {
    await recordActivity(tx, ctx.business.id, ctx.user.id, { type: 'job.part_status', summary: `${jp.description}: ${from.toLowerCase()} → ${to.toLowerCase()}`, customerId: job.customerId, vehicleId: job.vehicleId, jobId: job.id });
  }
  return after;
}

/** Take a catalogue part off a job. Reservations are released; a fitted part must be returned first. */
export async function removeCatalogueJobPart(tx: Tx, ctx: BusinessContext, job: JobRow, jp: JobPartRow): Promise<void> {
  if (jp.status === 'FITTED') throw Errors.conflict('This part has been fitted. Return it first.');
  if (jp.status === 'RESERVED') await setJobPartState(tx, ctx, job, jp, 'RETURNED');
}

/** Release every reservation a job still holds (a cancelled job must not keep stock locked up). */
export async function releaseJobReservations(tx: Tx, ctx: BusinessContext, job: JobRow): Promise<number> {
  const held = await tx.jobPart.findMany({ where: { businessId: ctx.business.id, jobId: job.id, archivedAt: null, status: 'RESERVED', inventoryItemId: { not: null } } });
  if (held.length === 0) return 0;
  const settings = await loadInventorySettings(tx, ctx.business.id);
  for (const jp of [...held].sort((a, b) => (a.inventoryItemId ?? '').localeCompare(b.inventoryItemId ?? ''))) await setJobPartState(tx, ctx, job, jp, 'RETURNED', { settings });
  return held.length;
}

/** Catalogue parts still reserved on a job: they must be fitted or released before the job is signed off. */
export async function reservedPartsOn(tx: Tx, businessId: string, jobId: string): Promise<{ id: string; description: string; quantity: number }[]> {
  return tx.jobPart.findMany({ where: { businessId, jobId, archivedAt: null, status: 'RESERVED', inventoryItemId: { not: null } }, select: { id: true, description: true, quantity: true } });
}

export async function assertNoPhantomReservations(tx: Tx, businessId: string, jobId: string, what: string): Promise<void> {
  const held = await reservedPartsOn(tx, businessId, jobId);
  if (held.length > 0) {
    throw Errors.conflict(`${what}: ${held.length} part${held.length === 1 ? ' is' : 's are'} still reserved (${held.map((h) => `${h.quantity} × ${h.description}`).join(', ')}). Mark ${held.length === 1 ? 'it' : 'them'} as fitted if used, or return ${held.length === 1 ? 'it' : 'them'} to stock.`, { code: 'PARTS_STILL_RESERVED' });
  }
}

export const canUseStock = (ctx: BusinessContext) => can(ctx, 'inventory.view');
