import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getUser } from '@/server/web/session';
import { LoginForm } from './LoginForm';

export const metadata: Metadata = { title: 'Sign in' };
export const dynamic = 'force-dynamic';

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  if (await getUser()) redirect('/dashboard');
  const { next } = await searchParams;
  return <LoginForm next={next} />;
}
