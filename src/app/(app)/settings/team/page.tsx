import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

/** The team directory now lives at /team (this address is kept so old links and bookmarks still work). */
export default function LegacyTeamPage() {
  redirect('/team');
}
