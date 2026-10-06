/** Where a record that has documents lives in the app (so a document can link back to what it belongs to). */
const PATHS: Record<string, string> = {
  customer: '/customers', statement: '/customers', vehicle: '/vehicles', job: '/jobs', inspection: '/jobs', diagnosis: '/jobs', booking: '/bookings', quote: '/quotes', invoice: '/invoices',
  payment: '/payments', credit_note: '/credit-notes', part: '/inventory/parts', supplier: '/inventory/suppliers', purchase_order: '/purchase-orders', stock_transfer: '/inventory/transfers',
  goods_receipt: '/purchase-orders', supplier_return: '/purchase-orders', employee: '/team',
};

export function recordHref(type: string, id: string): string | null {
  const base = PATHS[type];
  return base ? `${base}/${id}` : null;
}
