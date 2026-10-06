import { z } from 'zod';
import { Errors } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { MAX_IMPORT_BYTES, MAX_IMPORT_ROWS, readTable, TabularError } from '@/lib/tabular-read';
import { toCsv } from '@/lib/tabular';
import { pageMeta, parseOrThrow, uuidSchema } from '@/lib/validation';
import { withTenant, type Tx } from '@/server/db/client';
import { AuditActions, recordAudit } from '@/server/audit/audit';
import { assertCanWrite } from '@/server/billing/subscriptions';
import { canUseFeature, requireFeature } from '@/server/billing/features';
import { notifyInApp } from '@/server/notifications/service';
import { can, requirePermission } from '@/server/permissions/authorize';
import { consume } from '@/server/security/rate-limit';
import type { BusinessContext } from '@/server/context';
import { KINDS, isKind, norm, type DupKey, type KindDef } from './kinds';

/**
 * Importing records from a file:  upload -> choose type -> map columns -> validate -> preview -> confirm -> process -> results.
 * Nothing is written to real records until the person confirms, and then only rows that passed validation. The file's rows are staged in
 * the database (so the preview, the corrections and the final result are all the same data) and removed after the business's retention period.
 *
 *  - Validation uses the same rules as creating the record by hand.
 *  - A row that matches an existing record, or an earlier row in the file, is a DUPLICATE: it is listed and skipped, never merged or overwritten.
 *  - Rows with problems are never imported quietly: committing needs the person to choose to skip them, and every skipped row is listed with its reason.
 *  - Rows are saved in batches, each batch one transaction, so a failure cannot leave a half-saved batch. A crash leaves the import resumable.
 */

const BATCH = 100;
const PREVIEW_PROBLEMS = 200;
const MAX_CELL = 2000;

export const startSchema = z.object({
  kind: z.string().max(20),
  filename: z.string().trim().min(1).max(200),
  /** The file, base64 encoded. */
  content: z.string().min(1).max(Math.ceil((MAX_IMPORT_BYTES * 4) / 3) + 16),
});
export const validateSchema = z.object({ mapping: z.record(z.string().max(60), z.string().max(200)).default({}), });
export const commitSchema = z.object({ skipInvalid: z.boolean().default(false) });

function kindOf(ctx: BusinessContext, key: string): KindDef {
  if (!isKind(key)) throw Errors.validation({ kind: 'Choose what you are importing.' });
  const k = KINDS[key];
  requirePermission(ctx, 'data.import');
  for (const p of k.permissions) requirePermission(ctx, p);
  if (k.feature) requireFeature(ctx.subscription, k.feature);
  return k;
}

export function availableKinds(ctx: BusinessContext) {
  if (!can(ctx, 'data.import')) return [];
  return Object.values(KINDS).filter((k) => k.permissions.every((p) => can(ctx, p))).map((k) => ({
    key: k.key, label: k.label, description: k.description, locked: k.feature ? !canUseFeature(ctx.subscription, k.feature) : false,
    fields: k.fields.map((f) => ({ key: f.key, label: f.label, required: f.required })),
  }));
}

function suggest(kind: KindDef, headers: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const used = new Set<string>();
  for (const f of kind.fields) {
    const names = [f.label, f.key, ...f.synonyms].map(norm);
    const hit = headers.find((h) => !used.has(h) && names.includes(norm(h)));
    if (hit) { out[f.key] = hit; used.add(hit); }
  }
  return out;
}

type Raw = Record<string, string>;

/** Apply the column mapping to one staged row. */
function mapped(kind: KindDef, raw: Raw, mapping: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of kind.fields) {
    const col = mapping[f.key];
    out[f.key] = col ? String(raw[col] ?? '').trim().slice(0, MAX_CELL) : '';
  }
  return out;
}

const summarise = (b: { id: string; kind: string; status: string; fileName: string; totalRows: number; validRows: number; invalidRows: number; duplicateRows: number; warningRows: number; importedRows: number; skippedRows: number; failedRows: number; processedRows: number; error: string | null; createdAt: Date; completedAt: Date | null }) => ({
  id: b.id, kind: b.kind, status: b.status, fileName: b.fileName, totalRows: b.totalRows, validRows: b.validRows, invalidRows: b.invalidRows, duplicateRows: b.duplicateRows, warningRows: b.warningRows,
  importedRows: b.importedRows, skippedRows: b.skippedRows, failedRows: b.failedRows, processedRows: b.processedRows, error: b.error, createdAt: b.createdAt, completedAt: b.completedAt,
});

// ───────────────────────── 1. upload ─────────────────────────

export async function startImport(ctx: BusinessContext, input: unknown) {
  const d = parseOrThrow(startSchema, input);
  const kind = kindOf(ctx, d.kind);
  assertCanWrite(ctx.subscription);
  await consume({ key: `import:${ctx.business.id}`, limit: 30, windowSec: 3600 });
  let table: string[][];
  try {
    table = readTable(Buffer.from(d.content, 'base64'), d.filename);
  } catch (e) {
    if (e instanceof TabularError) throw Errors.validation({ file: e.message });
    throw e;
  }
  const headers = (table[0] ?? []).map((h) => String(h ?? '').trim()).filter((h) => h !== '');
  if (headers.length === 0) throw Errors.validation({ file: 'The first row of the file must be the column names.' });
  const dataRows = table.slice(1).filter((r) => r.some((c) => String(c ?? '').trim() !== ''));
  if (dataRows.length === 0) throw Errors.validation({ file: 'The file has no rows below the column names.' });
  if (dataRows.length > MAX_IMPORT_ROWS) throw Errors.validation({ file: `A file can hold at most ${MAX_IMPORT_ROWS.toLocaleString('en')} rows. Split it into smaller files.` });
  const dup = headers.find((h, i) => headers.indexOf(h) !== i);
  if (dup) throw Errors.validation({ file: `The column name "${dup}" appears twice. Rename one of them.` });

  const mapping = suggest(kind, headers);
  return withTenant(ctx.business.id, async (tx) => {
    const batch = await tx.importBatch.create({ data: { businessId: ctx.business.id, kind: kind.key, fileName: d.filename.slice(0, 200), headers, mapping, totalRows: dataRows.length, createdById: ctx.user.id } });
    for (let i = 0; i < dataRows.length; i += 500) {
      await tx.importRow.createMany({
        data: dataRows.slice(i, i + 500).map((r, j) => ({ businessId: ctx.business.id, batchId: batch.id, rowNumber: i + j + 2, raw: Object.fromEntries(headers.map((h, c) => [h, String(r[c] ?? '').slice(0, MAX_CELL)])) })),
      });
    }
    await recordAudit(tx, ctx.meta, { action: AuditActions.importUploaded, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'import', resourceId: batch.id, metadata: { kind: kind.key, file: d.filename, rows: dataRows.length } });
    return { ...summarise(batch), headers, suggestedMapping: mapping, fields: kind.fields.map((f) => ({ key: f.key, label: f.label, required: f.required })) };
  });
}

// ───────────────────────── 2. validate / preview ─────────────────────────

async function loadBatch(tx: Tx, ctx: BusinessContext, id: string) {
  const b = await tx.importBatch.findFirst({ where: { id: parseOrThrow(uuidSchema, id), businessId: ctx.business.id } });
  if (!b) throw Errors.notFound('Import');
  return b;
}

/** Run every row through the kind's rules and mark it VALID, INVALID or DUPLICATE. Re-runnable: the mapping can be changed and validated again. */
export async function validateImport(ctx: BusinessContext, id: string, input: unknown) {
  const d = parseOrThrow(validateSchema, input);
  return withTenant(ctx.business.id, async (tx) => {
    const batch = await loadBatch(tx, ctx, id);
    const kind = kindOf(ctx, batch.kind);
    assertCanWrite(ctx.subscription);
    if (!['UPLOADED', 'VALIDATED'].includes(batch.status)) throw Errors.conflict('This import has already been processed. Upload the file again to start a new one.');
    for (const [field, col] of Object.entries(d.mapping)) {
      if (!kind.fields.some((f) => f.key === field)) throw Errors.validation({ mapping: `"${field}" is not a field of ${kind.label.toLowerCase()}.` });
      if (col && !batch.headers.includes(col)) throw Errors.validation({ mapping: `The column "${col}" is not in the file.` });
    }
    const mapping = { ...d.mapping };
    const missing = kind.fields.filter((f) => f.required && !mapping[f.key] && !(kind.key === 'customers' && f.key !== 'mobile' && mapping.fullName)).map((f) => f.label);
    if (missing.length) throw Errors.validation({ mapping: `Choose a column for: ${missing.join(', ')}.` });

    const lookups = await kind.load(tx, ctx.business.id);
    const rows = await tx.importRow.findMany({ where: { batchId: batch.id, businessId: ctx.business.id }, orderBy: { rowNumber: 'asc' } });
    const seen = new Map<string, number>();
    const counts = { valid: 0, invalid: 0, duplicate: 0, warning: 0 };
    const updates: { id: string; status: string; errors: string[]; warnings: string[]; duplicateOf: string | null; values: unknown }[] = [];
    for (const row of rows) {
      const m = mapped(kind, row.raw as Raw, mapping);
      const res = kind.check(m, lookups, { ctx });
      let status = res.errors.length ? 'INVALID' : 'VALID';
      let duplicateOf: string | null = null;
      if (status === 'VALID') {
        const hit = firstDuplicate(res.keys, lookups.existing, seen, row.rowNumber);
        if (hit) { status = 'DUPLICATE'; duplicateOf = hit; }
      }
      // Rows that carry errors still claim their keys, so a later row with the same registration is flagged against the first, not both accepted.
      for (const k of res.keys) if (!seen.has(`${k.type}:${k.value}`)) seen.set(`${k.type}:${k.value}`, row.rowNumber);
      if (status === 'VALID') counts.valid++; else if (status === 'INVALID') counts.invalid++; else counts.duplicate++;
      if (res.warnings.length) counts.warning++;
      updates.push({ id: row.id, status, errors: res.errors, warnings: res.warnings, duplicateOf, values: status === 'VALID' ? res.values ?? null : null });
    }
    for (const u of updates) await tx.importRow.update({ where: { id: u.id }, data: { status: u.status, errors: u.errors, warnings: u.warnings, duplicateOf: u.duplicateOf, values: (u.values ?? undefined) as never } });
    const after = await tx.importBatch.update({
      where: { id: batch.id },
      data: { status: 'VALIDATED', mapping, validRows: counts.valid, invalidRows: counts.invalid, duplicateRows: counts.duplicate, warningRows: counts.warning, updatedAt: new Date() },
    });
    await recordAudit(tx, ctx.meta, { action: AuditActions.importValidated, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'import', resourceId: batch.id, metadata: { kind: kind.key, ...counts } });
    return getImportTx(tx, ctx, after.id);
  });
}

/** The earlier record or row a row duplicates, described for a person ("same email as Jane Doe (CUS-000012)" / "same registration as row 5"). */
function firstDuplicate(keys: DupKey[], existing: Map<string, string>, seen: Map<string, number>, rowNumber: number): string | null {
  for (const k of keys) {
    const key = `${k.type}:${k.value}`;
    const e = existing.get(key);
    if (e) return `Same ${k.label} as ${e}`;
    const s = seen.get(key);
    if (s !== undefined && s !== rowNumber) return `Same ${k.label} as row ${s} of this file`;
  }
  return null;
}

// ───────────────────────── reading ─────────────────────────

async function getImportTx(tx: Tx, ctx: BusinessContext, id: string, o: { status?: string; page?: number; pageSize?: number } = {}) {
  const b = await loadBatch(tx, ctx, id);
  const kind = isKind(b.kind) ? KINDS[b.kind] : null;
  const page = o.page ?? 1;
  const pageSize = o.pageSize ?? 25;
  const where = { batchId: b.id, businessId: ctx.business.id, ...(o.status ? { status: o.status } : { status: { not: 'VALID' } }) };
  const [total, rows] = [await tx.importRow.count({ where }), await tx.importRow.findMany({ where, orderBy: { rowNumber: 'asc' }, skip: (page - 1) * pageSize, take: pageSize })];
  return {
    ...summarise(b), headers: b.headers, mapping: b.mapping as Record<string, string>, fields: kind?.fields.map((f) => ({ key: f.key, label: f.label, required: f.required })) ?? [],
    rows: rows.map((r) => ({ row: r.rowNumber, status: r.status, errors: r.errors, warnings: r.warnings, duplicateOf: r.duplicateOf, raw: r.raw as Raw, recordId: r.recordId })),
    meta: pageMeta(page, pageSize, total),
    problems: (await tx.importRow.findMany({ where: { batchId: b.id, businessId: ctx.business.id, status: { in: ['INVALID', 'DUPLICATE'] } }, orderBy: { rowNumber: 'asc' }, take: PREVIEW_PROBLEMS, select: { rowNumber: true, status: true, errors: true, duplicateOf: true } }))
      .map((r) => ({ row: r.rowNumber, status: r.status, messages: r.status === 'DUPLICATE' ? [`${r.duplicateOf}. Skipped: nothing is merged automatically.`] : r.errors })),
  };
}

export async function getImport(ctx: BusinessContext, id: string, o: { status?: string; page?: number } = {}) {
  requirePermission(ctx, 'data.import');
  return withTenant(ctx.business.id, (tx) => getImportTx(tx, ctx, id, o));
}

export async function listImports(ctx: BusinessContext) {
  requirePermission(ctx, 'data.import');
  return withTenant(ctx.business.id, async (tx) => (await tx.importBatch.findMany({ where: { businessId: ctx.business.id }, orderBy: { createdAt: 'desc' }, take: 50 })).map(summarise));
}

/** The rows that could not be imported, with their original columns and the reason, ready to correct and upload again. */
export async function importProblemsCsv(ctx: BusinessContext, id: string) {
  requirePermission(ctx, 'data.import');
  return withTenant(ctx.business.id, async (tx) => {
    const b = await loadBatch(tx, ctx, id);
    const rows = await tx.importRow.findMany({ where: { batchId: b.id, businessId: ctx.business.id, status: { in: ['INVALID', 'DUPLICATE', 'FAILED', 'SKIPPED'] } }, orderBy: { rowNumber: 'asc' } });
    const columns = [...b.headers.map((h) => ({ header: h, kind: 'text' as const })), { header: 'Problem', kind: 'text' as const }];
    const data = toCsv(columns, rows.map((r) => [...b.headers.map((h) => (r.raw as Raw)[h] ?? ''), r.status === 'DUPLICATE' ? `Duplicate: ${r.duplicateOf}` : r.errors.join('; ')]));
    return { data, filename: `${b.kind}-rows-to-fix.csv` };
  });
}

// ───────────────────────── 3. confirm and process ─────────────────────────

export async function commitImport(ctx: BusinessContext, id: string, input: unknown) {
  const d = parseOrThrow(commitSchema, input);
  assertCanWrite(ctx.subscription);
  const batch = await withTenant(ctx.business.id, (tx) => loadBatch(tx, ctx, id));
  const kind = kindOf(ctx, batch.kind);
  if (!['VALIDATED', 'PROCESSING'].includes(batch.status)) throw Errors.conflict(batch.status === 'DONE' ? 'This import has already been processed.' : 'Validate the file before importing it.');
  if (batch.status === 'VALIDATED') {
    const problems = batch.invalidRows;
    if (problems > 0 && !d.skipInvalid) throw Errors.conflict(`${problems} row${problems === 1 ? ' has' : 's have'} problems. Fix the file and upload it again, or choose to skip the rows with problems.`, { invalid: problems });
    if (batch.validRows === 0) throw Errors.validation({ file: 'There is nothing valid to import.' });
  }
  await consume({ key: `import-commit:${ctx.business.id}`, limit: 20, windowSec: 3600 });
  await withTenant(ctx.business.id, (tx) => tx.importBatch.update({ where: { id: batch.id }, data: { status: 'PROCESSING', updatedAt: new Date() } }));

  // Resumable: only rows still VALID are processed, in row order, a batch at a time.
  for (;;) {
    const rows = await withTenant(ctx.business.id, (tx) => tx.importRow.findMany({ where: { batchId: batch.id, businessId: ctx.business.id, status: 'VALID' }, orderBy: { rowNumber: 'asc' }, take: BATCH }));
    if (rows.length === 0) break;
    try {
      await withTenant(ctx.business.id, async (tx) => {
        const lookups = await kind.load(tx, ctx.business.id);
        for (const row of rows) {
          // Re-check inside the transaction: the data may have changed since the preview (another import, someone typing a customer).
          const mappedRow = mapped(kind, row.raw as Raw, batch.mapping as Record<string, string>);
          const re = kind.check(mappedRow, lookups, { ctx });
          const dup = re.errors.length ? null : firstDuplicate(re.keys, lookups.existing, new Map(), row.rowNumber);
          if (re.errors.length || !re.values) { await tx.importRow.update({ where: { id: row.id }, data: { status: 'SKIPPED', errors: re.errors.length ? re.errors : ['The row no longer passes validation.'] } }); continue; }
          if (dup) { await tx.importRow.update({ where: { id: row.id }, data: { status: 'DUPLICATE', duplicateOf: dup } }); continue; }
          const recordId = await kind.insert(ctx, tx, re.values, batch.id);
          await tx.importRow.update({ where: { id: row.id }, data: { status: 'IMPORTED', recordId } });
        }
        await refreshCounts(tx, batch.id, ctx.business.id);
      });
    } catch (e) {
      // The whole batch rolled back (nothing half-saved). Mark its rows failed with a safe reason and carry on with the rest.
      logger.error({ importId: batch.id, err: String(e) }, 'import batch failed');
      await withTenant(ctx.business.id, async (tx) => {
        await tx.importRow.updateMany({ where: { id: { in: rows.map((r) => r.id) }, status: 'VALID' }, data: { status: 'FAILED', errors: ['This group of rows could not be saved, so none of them were. Upload them again.'] } });
        await refreshCounts(tx, batch.id, ctx.business.id);
      });
    }
  }
  return withTenant(ctx.business.id, async (tx) => {
    // Rows that were INVALID and the person chose to skip are recorded as skipped (never silently dropped).
    await tx.importRow.updateMany({ where: { batchId: batch.id, businessId: ctx.business.id, status: 'INVALID' }, data: { status: 'SKIPPED' } });
    const final = await refreshCounts(tx, batch.id, ctx.business.id);
    const status = final.importedRows === 0 && final.failedRows > 0 ? 'FAILED' : 'DONE';
    await tx.importBatch.update({ where: { id: batch.id }, data: { status, completedAt: new Date(), error: status === 'FAILED' ? 'No rows could be saved.' : null } });
    await recordAudit(tx, ctx.meta, { action: status === 'FAILED' ? AuditActions.importFailed : AuditActions.importCompleted, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'import', resourceId: batch.id, metadata: { kind: kind.key, imported: final.importedRows, skipped: final.skippedRows, duplicates: final.duplicateRows, failed: final.failedRows } });
    await notifyInApp(tx, { businessId: ctx.business.id, userId: ctx.user.id, type: 'IMPORT_FINISHED', title: `${kind.label} import finished`, body: `${final.importedRows} imported, ${final.skippedRows + final.duplicateRows} skipped, ${final.failedRows} failed.`, linkUrl: `/admin/import/${batch.id}`, priority: 'NORMAL', entityType: 'import', entityId: batch.id });
    return getImportTx(tx, ctx, batch.id, { status: undefined });
  });
}

async function refreshCounts(tx: Tx, batchId: string, businessId: string) {
  const g = await tx.importRow.groupBy({ by: ['status'], where: { batchId, businessId }, _count: true });
  const n = (s: string) => g.find((x) => x.status === s)?._count ?? 0;
  const total = g.reduce((a, x) => a + x._count, 0);
  const data = { importedRows: n('IMPORTED'), skippedRows: n('SKIPPED'), failedRows: n('FAILED'), duplicateRows: n('DUPLICATE'), invalidRows: n('INVALID'), validRows: n('VALID'), processedRows: total - n('VALID') - n('PENDING'), updatedAt: new Date() };
  return tx.importBatch.update({ where: { id: batchId }, data });
}

export async function cancelImport(ctx: BusinessContext, id: string) {
  requirePermission(ctx, 'data.import');
  return withTenant(ctx.business.id, async (tx) => {
    const b = await loadBatch(tx, ctx, id);
    if (!['UPLOADED', 'VALIDATED'].includes(b.status)) throw Errors.conflict('Only an import that has not been processed can be cancelled.');
    await tx.importBatch.update({ where: { id: b.id }, data: { status: 'CANCELLED', completedAt: new Date() } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.importCancelled, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'import', resourceId: b.id, metadata: { kind: b.kind } });
    return { id: b.id };
  });
}

/** Old staged files are cleared after the business's retention period (default 30 days). The records they created are, of course, kept. */
export async function cleanupImports(tx: Tx, businessId: string, now: Date): Promise<number> {
  const cfg = await tx.businessConfig.findUnique({ where: { businessId }, select: { importRetentionDays: true } });
  const cutoff = new Date(now.getTime() - (cfg?.importRetentionDays ?? 30) * 86_400_000);
  const r = await tx.importBatch.deleteMany({ where: { businessId, createdAt: { lt: cutoff }, status: { notIn: ['PROCESSING'] } } });
  return r.count;
}
