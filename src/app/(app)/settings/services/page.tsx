import type { Metadata } from 'next';
import { Alert, Badge, Card, PageHeader } from '@/components/ui';
import { ActionButton } from '@/components/forms/RowActions';
import { ServiceForm, TemplateForm } from '@/components/settings/ConfigForms';
import { withTenant } from '@/server/db/client';
import { listJobTemplates, listServiceCatalogue } from '@/server/settings/catalogue';
import { assertCan, requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'Services and templates' };
export const dynamic = 'force-dynamic';

export default async function ServicesPage() {
  const ctx = await requireBusiness();
  assertCan(ctx, 'settings.view');
  const can = (p: Parameters<typeof ctx.permissions.has>[0]) => ctx.permissions.has(p);
  const locked = !ctx.subscription.features.has('advanced_settings');
  const edit = can('settings.manage_workshop') && ctx.subscription.canWrite && !locked;
  const [services, templates] = [await listServiceCatalogue(ctx, { includeArchived: true }), can('job.view') ? await listJobTemplates(ctx, { includeArchived: true }) : []];
  const parts = can('inventory.view') ? await withTenant(ctx.business.id, (tx) => tx.part.findMany({ where: { businessId: ctx.business.id, status: 'ACTIVE' }, orderBy: { name: 'asc' }, take: 500, select: { id: true, sku: true, name: true } })) : [];
  const partOpts = parts.map((p) => ({ value: p.id, label: p.sku + ' — ' + p.name }));
  const active = services.filter((s) => s.status === 'ACTIVE');
  return (
    <>
      <PageHeader title="Services and job templates" description="What you sell, and ready-made recipes for opening jobs. A job made from a template gets copies of its labour, parts and checklist: later changes to the template never alter jobs that already exist." />
      {locked && <div className="mb-4"><Alert tone="warn">The full service catalogue and job templates are included from the Team plan. You can still see what is set up.</Alert></div>}
      <div className="space-y-6">
        <section aria-labelledby="svc-h" className="space-y-3">
          <h2 id="svc-h" className="text-base font-semibold">Services</h2>
          {edit && <Card><h3 className="mb-2 text-sm font-semibold">Add a service</h3><ServiceForm parts={partOpts} canRates={can('labour.manage_rates')} /></Card>}
          <ul className="grid gap-2">
            {services.map((s) => (
              <li key={s.id}>
                <Card>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-medium">{s.name} <span className="font-normal text-muted">· {s.defaultDurationMin} min</span> {s.status === 'ARCHIVED' && <Badge>Archived</Badge>}</p>
                    {edit && <ActionButton label={s.status === 'ARCHIVED' ? 'Restore' : 'Archive'} variant="ghost" method="PATCH" path={'/api/v1/settings/services/' + s.id} body={{ archived: s.status !== 'ARCHIVED' }} />}
                  </div>
                  {s.description && <p className="text-sm text-muted">{s.description}</p>}
                  {edit && s.status === 'ACTIVE' && <details className="mt-1"><summary className="min-h-11 cursor-pointer text-sm font-medium leading-[2.75rem] text-brand-700">Edit</summary><ServiceForm service={s} parts={partOpts} canRates={can('labour.manage_rates')} /></details>}
                </Card>
              </li>
            ))}
          </ul>
        </section>
        {can('job.view') && (
          <section aria-labelledby="tpl-h" className="space-y-3">
            <h2 id="tpl-h" className="text-base font-semibold">Job templates</h2>
            {edit && <Card><h3 className="mb-2 text-sm font-semibold">Add a template</h3><TemplateForm services={active.map((s) => ({ value: s.id, label: s.name }))} parts={partOpts} /></Card>}
            {templates.length === 0 ? <p className="text-sm text-muted">No templates yet.</p> : (
              <ul className="grid gap-2">
                {templates.map((t) => (
                  <li key={t.id}>
                    <Card>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="font-medium">{t.name} {t.status === 'ARCHIVED' && <Badge>Archived</Badge>}<span className="block text-xs font-normal text-muted">{t.labour.length} labour line{t.labour.length === 1 ? '' : 's'} · {t.parts.length} part{t.parts.length === 1 ? '' : 's'} · {t.checklist.length + t.inspectionFields.length} checklist item{t.checklist.length + t.inspectionFields.length === 1 ? '' : 's'}</span></p>
                        {edit && <ActionButton label={t.status === 'ARCHIVED' ? 'Restore' : 'Archive'} variant="ghost" method="PATCH" path={'/api/v1/settings/job-templates/' + t.id} body={{ archived: t.status !== 'ARCHIVED' }} />}
                      </div>
                      {edit && t.status === 'ACTIVE' && <details className="mt-1"><summary className="min-h-11 cursor-pointer text-sm font-medium leading-[2.75rem] text-brand-700">Edit</summary><TemplateForm template={t} services={active.map((s) => ({ value: s.id, label: s.name }))} parts={partOpts} /></details>}
                    </Card>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
    </>
  );
}
