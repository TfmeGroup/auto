import { centsToDecimal } from '@/lib/money';
import type { LineState } from './DocumentForm';

// This module has no "use client" on purpose: the quote and invoice EDIT pages are server components that pre-fill the form,
// and Next refuses to run a function exported by a client module on the server.

let counter = 0;
/** A key for a line being edited. Unique across server- and browser-made lines, so a pre-filled line never collides with one added later. */
export const lineKey = () => `l${++counter}-${Math.random().toString(36).slice(2, 8)}`;

/** Convert stored values into the strings a form field shows. */
export const lineToState = (l: { id?: string; recommendedWorkId?: string | null; inventoryItemId?: string | null; lineType: string; description: string; sku?: string | null; unit?: string | null; quantityMilli: number; unitPriceCents: number; discountType: string; discountValue: number; taxTreatment: string; unitCostCents?: number | null }): LineState => ({
  key: lineKey(), id: l.id, recommendedWorkId: l.recommendedWorkId ?? null, inventoryItemId: l.inventoryItemId ?? null, lineType: l.lineType as LineState['lineType'], description: l.description, sku: l.sku ?? '', unit: l.unit ?? '',
  qty: String(l.quantityMilli / 1000), price: centsToDecimal(l.unitPriceCents), discountType: l.discountType as LineState['discountType'],
  discount: l.discountType === 'NONE' ? '' : centsToDecimal(l.discountValue), taxTreatment: l.taxTreatment as LineState['taxTreatment'], cost: l.unitCostCents != null ? centsToDecimal(l.unitCostCents) : '',
});
