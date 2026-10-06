import { redirect } from 'next/navigation';
import { getUser } from '@/server/web/session';

export const dynamic = 'force-dynamic';

export default async function Home() {
  redirect((await getUser()) ? '/dashboard' : '/login');
}
