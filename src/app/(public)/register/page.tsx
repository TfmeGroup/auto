import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getUser } from '@/server/web/session';
import { RegisterForm } from './RegisterForm';

export const metadata: Metadata = { title: 'Create account' };
export const dynamic = 'force-dynamic';

export default async function RegisterPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  if (await getUser()) redirect(next && next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard');
  return <RegisterForm next={next} />;
}
