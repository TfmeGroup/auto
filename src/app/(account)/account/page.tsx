import type { Metadata } from 'next';
import { Badge, Card, PageHeader } from '@/components/ui';
import { NotificationPrefs, PhotoUploader, ProfileForm } from '@/components/account/Forms';
import { getAccount, getNotificationSettings } from '@/server/account/service';
import { requireUser } from '@/server/web/session';
import { formatDateTime } from '@/lib/format';

export const metadata: Metadata = { title: 'My account' };
export const dynamic = 'force-dynamic';

export default async function AccountPage() {
  const user = await requireUser();
  const [a, notifications] = await Promise.all([getAccount(user.user.id), getNotificationSettings(user.user.id)]);
  const initials = `${a.firstName[0] ?? ''}${a.lastName[0] ?? ''}`.toUpperCase() || a.email[0]!.toUpperCase();

  return (
    <>
      <PageHeader title="My account" description="Your personal TFME Auto account. It is yours alone — separate from any business you belong to." />
      <Card>
        <h2 className="mb-3 text-base font-semibold">Photo</h2>
        <PhotoUploader hasPhoto={a.hasPhoto} initials={initials} />
      </Card>
      <Card>
        <h2 className="mb-3 text-base font-semibold">Profile</h2>
        <ProfileForm initial={{ firstName: a.firstName, lastName: a.lastName, mobile: a.mobile }} />
      </Card>
      <Card>
        <h2 className="mb-2 text-base font-semibold">Sign-in details</h2>
        <dl className="space-y-1 text-sm">
          <div className="flex flex-wrap gap-2"><dt className="text-muted">Email:</dt><dd>{a.email} {a.emailVerified ? <Badge tone="ok">verified</Badge> : <Badge tone="warn">not verified</Badge>}</dd></div>
          <div className="flex gap-2"><dt className="text-muted">Last sign-in:</dt><dd>{a.lastLoginAt ? formatDateTime(a.lastLoginAt) : '—'}</dd></div>
          <div className="flex gap-2"><dt className="text-muted">Member since:</dt><dd>{formatDateTime(a.createdAt)}</dd></div>
        </dl>
      </Card>
      <Card>
        <h2 className="mb-3 text-base font-semibold">Email notifications</h2>
        <NotificationPrefs optional={notifications.optional} alwaysOn={notifications.alwaysOn} />
      </Card>
    </>
  );
}
