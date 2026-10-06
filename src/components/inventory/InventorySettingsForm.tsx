'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Field, Input, Select } from '@/components/ui';
import { useSubmit } from '@/components/forms/use-submit';
import { api } from '@/lib/api-client';
import { centsToRand, randToCentsOrNull } from './shared';

export interface InventorySettingsView {
  uniqueSku: boolean; uniquePartNumber: boolean; uniqueBarcode: boolean; allowNegativeStock: boolean; autoReserveOnJobAdd: boolean; costMethod: string;
  poPrefix: string; receiptPrefix: string; transferPrefix: string; supplierReturnPrefix: string; numberPadding: number;
  poApprovalRequired: boolean; poApprovalThresholdCents: number; transferApprovalRequired: boolean; poReminderDays: number;
}

const Check = ({ name, label, hint, defaultChecked, disabled }: { name: string; label: string; hint?: string; defaultChecked: boolean; disabled?: boolean }) => (
  <label className="flex min-h-11 items-start gap-3 text-sm"><input type="checkbox" name={name} defaultChecked={defaultChecked} disabled={disabled} className="mt-0.5 size-5" /><span><span className="font-medium">{label}</span>{hint && <span className="block text-xs text-muted">{hint}</span>}</span></label>
);

export function InventorySettingsForm({ s, canEdit, canNegative, hasPurchasing, multiLocation }: { s: InventorySettingsView; canEdit: boolean; canNegative: boolean; hasPurchasing: boolean; multiLocation: boolean }) {
  const router = useRouter();
  const { pending, ready, error, fields, run } = useSubmit();
  const [saved, setSaved] = useState(false);
  return (
    <form
      noValidate
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        const f = e.currentTarget;
        const el = (n: string) => f.elements.namedItem(n) as HTMLInputElement | HTMLSelectElement | null;
        const v = (n: string) => (el(n)?.value ?? '').trim();
        const b = (n: string) => !!(el(n) as HTMLInputElement | null)?.checked;
        const threshold = randToCentsOrNull(v('poApprovalThresholdRand') || '0');
        const body: Record<string, unknown> = {
          uniqueSku: b('uniqueSku'), uniquePartNumber: b('uniquePartNumber'), uniqueBarcode: b('uniqueBarcode'), autoReserveOnJobAdd: b('autoReserveOnJobAdd'), costMethod: v('costMethod'),
          poPrefix: v('poPrefix'), receiptPrefix: v('receiptPrefix'), transferPrefix: v('transferPrefix'), supplierReturnPrefix: v('supplierReturnPrefix'), numberPadding: v('numberPadding'),
          poApprovalRequired: b('poApprovalRequired'), poApprovalThresholdCents: threshold ?? 0, transferApprovalRequired: b('transferApprovalRequired'), poReminderDays: v('poReminderDays'),
        };
        if (canNegative) body.allowNegativeStock = b('allowNegativeStock');
        setSaved(false);
        void run(async () => { await api('/api/v1/inventory/settings', { method: 'PATCH', body }); setSaved(true); router.refresh(); });
      }}
    >
      {error && <Alert>{error}</Alert>}
      {saved && !error && <Alert tone="ok">Settings saved.</Alert>}
      <fieldset disabled={!canEdit} className="space-y-6 disabled:opacity-70">
        <section className="space-y-1">
          <h2 className="text-base font-semibold">Identifiers</h2>
          <Check name="uniqueSku" label="Every part must have its own SKU" defaultChecked={s.uniqueSku} />
          <Check name="uniquePartNumber" label="Every part must have its own part number" hint="Off by default: the same manufacturer number can appear under different SKUs." defaultChecked={s.uniquePartNumber} />
          <Check name="uniqueBarcode" label="Every part must have its own barcode" defaultChecked={s.uniqueBarcode} />
          {(fields.uniqueSku || fields.uniquePartNumber || fields.uniqueBarcode) && <p role="alert" className="text-xs font-medium text-danger">{fields.uniqueSku ?? fields.uniquePartNumber ?? fields.uniqueBarcode}</p>}
        </section>

        <section className="space-y-1">
          <h2 className="text-base font-semibold">Stock rules</h2>
          <Check name="autoReserveOnJobAdd" label="Reserve stock when a part is added to a job" hint="If there is not enough, the part is added as Requested and the stock team is told." defaultChecked={s.autoReserveOnJobAdd} />
          <Check name="allowNegativeStock" label="Allow stock to go below zero" hint={canNegative ? 'Off by default. When on, parts can be used before they are booked in; every such movement is flagged and audited.' : 'Only people with permission to allow negative stock can change this.'} defaultChecked={s.allowNegativeStock} disabled={!canNegative} />
          <div className="max-w-xs pt-2">
            <Field label="Cost basis" htmlFor="is-cost" hint="How a part's cost follows what you pay. Each delivery always keeps the price actually paid.">
              <Select id="is-cost" name="costMethod" defaultValue={s.costMethod}><option value="LAST_COST">Latest price paid</option><option value="AVERAGE_COST">Weighted average cost</option></Select>
            </Field>
          </div>
        </section>

        {hasPurchasing && (
          <section className="space-y-3">
            <h2 className="text-base font-semibold">Purchase orders</h2>
            <Check name="poApprovalRequired" label="Orders need approval before they can be placed" hint="Someone with permission to approve purchase orders must approve them." defaultChecked={s.poApprovalRequired} />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Only for orders of at least (rand)" htmlFor="is-thr" hint="0 means every order." error={fields.poApprovalThresholdCents}><Input id="is-thr" name="poApprovalThresholdRand" inputMode="decimal" defaultValue={centsToRand(s.poApprovalThresholdCents)} /></Field>
              <Field label="Flag an order as late after (days)" htmlFor="is-late"><Input id="is-late" name="poReminderDays" inputMode="numeric" defaultValue={String(s.poReminderDays)} /></Field>
            </div>
          </section>
        )}
        {multiLocation && <section><Check name="transferApprovalRequired" label="Stock transfers need approval before they can ship" defaultChecked={s.transferApprovalRequired} /></section>}

        <section className="space-y-3">
          <h2 className="text-base font-semibold">Numbering</h2>
          <p className="text-xs text-muted">Numbers are made by the server and never reused. Changing a prefix never changes numbers already issued. A location&apos;s document code (set under Quotes &amp; invoices) is added to order numbers.</p>
          <div className="grid gap-3 sm:grid-cols-3">
            {hasPurchasing && <Field label="Purchase orders" htmlFor="is-po" error={fields.poPrefix}><Input id="is-po" name="poPrefix" defaultValue={s.poPrefix} maxLength={8} /></Field>}
            {hasPurchasing && <Field label="Deliveries" htmlFor="is-grn" error={fields.receiptPrefix}><Input id="is-grn" name="receiptPrefix" defaultValue={s.receiptPrefix} maxLength={8} /></Field>}
            {multiLocation && <Field label="Transfers" htmlFor="is-trf" error={fields.transferPrefix}><Input id="is-trf" name="transferPrefix" defaultValue={s.transferPrefix} maxLength={8} /></Field>}
            {hasPurchasing && <Field label="Supplier returns" htmlFor="is-srt" error={fields.supplierReturnPrefix}><Input id="is-srt" name="supplierReturnPrefix" defaultValue={s.supplierReturnPrefix} maxLength={8} /></Field>}
            <Field label="Digits" htmlFor="is-pad" error={fields.numberPadding}><Input id="is-pad" name="numberPadding" inputMode="numeric" defaultValue={String(s.numberPadding)} /></Field>
          </div>
        </section>
      </fieldset>
      {canEdit && <Button type="submit" loading={pending || !ready}>Save settings</Button>}
    </form>
  );
}
