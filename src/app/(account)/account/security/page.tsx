import type { Metadata } from 'next';
import { Alert, Card, PageHeader, Pagination } from '@/components/ui';
import { DeactivatePanel, EmailChangeForm, PasswordForm } from '@/components/account/Forms';
import { MfaPanel } from '@/components/account/MfaPanel';
import { SessionsList } from '@/components/account/SessionsList';
import { getAccount, listMySecurityEvents, listSessions } from '@/server/account/service';
import { getMfaStatus } from '@/server/auth/mfa';
import { requireUser } from '@/server/web/session';
import { eventLabel } from '@/lib/event-labels';
import { formatDateTime } from '@/lib/format';

export const metadata: Metadata = { title: 'Account security' };
export const dynamic = 'force-dynamic';

export default async function AccountSecurityPage({ searchParams }: { searchParams: Promise<{ page?: string; mfa?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const [account, mfa, sessions, events] = await Promise.all([
    getAccount(user.user.id),
    getMfaStatus(user.user.id),
    listSessions(user),
    listMySecurityEvents(user, { page: sp.page, pageSize: 10 }),
  ]);

  return (
    <>
      <PageHeader title="Account security" description={`Signed in as ${account.email}`} />
      {sp.mfa === 'required' && !mfa.enabled && <Alert tone="warn">A business you belong to requires two-factor authentication. Turn it on below to keep using that business.</Alert>}

      <Card>
        <h2 className="mb-3 text-base font-semibold">Two-factor authentication</h2>
        <MfaPanel enabled={mfa.enabled} recoveryCodesRemaining={mfa.recoveryCodesRemaining} required={sp.mfa === 'required'} />
      </Card>
      <Card>
        <h2 className="mb-1 text-base font-semibold">Password</h2>
        <p className="mb-4 text-sm text-muted">Changing your password signs out your other devices.</p>
        <PasswordForm />
      </Card>
      <Card>
        <h2 className="mb-3 text-base font-semibold">Email address</h2>
        <EmailChangeForm currentEmail={account.email} verified={account.emailVerified} />
      </Card>
      <Card>
        <h2 className="mb-1 text-base font-semibold">Where you are signed in</h2>
        <p className="mb-2 text-sm text-muted">Sign out any device you do not recognise.</p>
        <SessionsList sessions={JSON.parse(JSON.stringify(sessions))} />
      </Card>
      <Card>
        <h2 className="mb-2 text-base font-semibold">Recent security activity</h2>
        {events.items.length === 0 ? <p className="text-sm text-muted">Nothing yet.</p> : (
          <ul className="divide-y divide-line">
            {events.items.map((e) => (
              <li key={e.id} className="flex flex-wrap items-baseline justify-between gap-x-4 py-2 text-sm">
                <span className="font-medium">{eventLabel(e.action)}</span>
                <span className="text-xs text-muted">{e.device}{e.ip ? ` · ${e.ip}` : ''} · {formatDateTime(e.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
        <Pagination page={events.meta.page} totalPages={events.meta.totalPages} total={events.meta.total} hrefFor={(p) => `/account/security?page=${p}`} />
      </Card>
      <Card className="border-danger/30">
        <h2 className="mb-2 text-base font-semibold">Deactivate account</h2>
        <DeactivatePanel mfaEnabled={mfa.enabled} />
      </Card>
    </>
  );
}
