import type { Metadata } from 'next';
import { ConfirmEmailChange } from './ConfirmEmailChange';

export const metadata: Metadata = { title: 'Confirm new email' };

export default async function ConfirmEmailChangePage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  return <ConfirmEmailChange token={token} />;
}
