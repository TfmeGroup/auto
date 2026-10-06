import type { Metadata } from 'next';
import Link from 'next/link';
import { ResetForm } from './ResetForm';

export const metadata: Metadata = { title: 'Choose a new password' };

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  if (!token) {
    return (
      <div className="space-y-3">
        <h1 className="text-xl font-bold">Link not valid</h1>
        <p className="text-sm text-muted">This password reset link is incomplete. Request a new one.</p>
        <Link href="/forgot-password" className="text-sm font-medium text-brand-600 hover:underline">Request a new link</Link>
      </div>
    );
  }
  return <ResetForm token={token} />;
}
