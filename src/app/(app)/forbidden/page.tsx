import type { Metadata } from 'next';
import { EmptyState, LinkButton } from '@/components/ui';

export const metadata: Metadata = { title: 'Not allowed' };

export default function ForbiddenPage() {
  return (
    <EmptyState title="You don’t have access to this page" action={<LinkButton href="/dashboard" variant="secondary">Back to dashboard</LinkButton>}>
      Your role doesn’t include this area. If you think that’s a mistake, ask the business owner or an admin.
    </EmptyState>
  );
}
