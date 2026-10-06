import type { Metadata } from 'next';
import Link from 'next/link';
import { Card, PageHeader } from '@/components/ui';
import { CloseBusiness, MfaRequirement, TransferOwnership } from '@/components/forms/BusinessSecurityPanels';
import { prisma } from '@/server/db/client';
import { SecurityLimitsForm } from '@/components/settings/ConfigForms';
import { getSecuritySettings } from '@/server/settings/config-service';
import { getBusiness } from '@/server/businesses/service';
import { requireBusiness } from '@/server/web/session';
import { redirect } from 'next/navigation';

export const metadata: Metadata = { title: 'Business security' };
export const dynamic = 'force-dynamic';

export default async function BusinessSecurityPage() {
  const ctx = await requireBusiness();
  const can = (p: Parameters<typeof ctx.permissions.has>[0]) => ctx.permissions.has(p);
  if (!can('settings.manage_security') && !can('business.transfer_ownership') && !can('business.close')) redirect('/forbidden');
  const b = await getBusiness(ctx);
  const limits = await getSecuritySettings(ctx).catch(() => null);
  const candidates = can('business.transfer_ownership')
    ? (await prisma().membership.findMany({ where: { businessId: ctx.business.id, status: 'ACTIVE', isOwner: false, userId: { not: null } }, include: { user: { select: { name: true, email: true, emailVerifiedAt: true } } } }))
        .filter((m) => m.user?.emailVerifiedAt)
        .map((m) => ({ id: m.id, label: `${m.user!.name} (${m.user!.email})` }))
    : [];

  return (
    <>
      <PageHeader title="Business security" description="Rules that protect this whole business. Your personal sign-in security is under My account." />
      <p className="mb-4 text-sm"><Link href="/account/security" className="font-medium text-brand-600 hover:underline">Go to my account security →</Link></p>
      <div className="space-y-4">
        {can('settings.manage_security') && (
          <Card>
            <h2 className="mb-3 text-base font-semibold">Two-factor authentication</h2>
            <MfaRequirement required={b.requireMfa} available={ctx.subscription.features.has('mfa_enforcement')} ownMfa={ctx.user.mfaEnabled} />
          </Card>
        )}
        {limits && can('settings.manage_security') && (
          <Card>
            <h2 className="mb-1 text-base font-semibold">Sign-in and invitation limits</h2>
            <p className="mb-3 text-sm text-muted">Password rules and who can sign in are set by the platform and your roles. A business can shorten how long a sign-in lasts and how long an invitation stays open.</p>
            <SecurityLimitsForm initial={{ sessionMaxHours: limits.sessionMaxHours, invitationExpiryDays: limits.invitationExpiryDays }} canEdit={ctx.subscription.canWrite} />
          </Card>
        )}
        {can('business.transfer_ownership') && (
          <Card>
            <h2 className="mb-1 text-base font-semibold">Ownership</h2>
            <p className="mb-3 text-sm text-muted">There is exactly one Owner. Ownership moves only by a deliberate, re-authenticated transfer.</p>
            <TransferOwnership candidates={candidates} mfaEnabled={ctx.user.mfaEnabled} />
          </Card>
        )}
        {can('business.close') && (
          <Card className="border-danger/30">
            <h2 className="mb-3 text-base font-semibold">Close business</h2>
            <CloseBusiness businessName={ctx.business.name} mfaEnabled={ctx.user.mfaEnabled} />
          </Card>
        )}
      </div>
    </>
  );
}
