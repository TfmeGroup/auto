import type { Metadata } from 'next';

// Customer pages carry a secret link: keep them out of search engines and never leak the link in a Referer header.
export const metadata: Metadata = { robots: { index: false, follow: false }, referrer: 'no-referrer' };
export const dynamic = 'force-dynamic';

/** A plain page for customers: no workshop navigation, nothing to sign in to. */
export default function CustomerLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-canvas">
      <main className="mx-auto w-full max-w-3xl px-4 py-6 sm:py-10">{children}</main>
      <footer className="px-4 pb-8 text-center text-xs text-muted">Sent using TFME Auto</footer>
    </div>
  );
}
