import Link from 'next/link';

export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-4 py-8">
      <Link href="/" className="mb-6 text-2xl font-extrabold tracking-tight text-brand-600">
        TFME <span className="text-ink">Auto</span>
      </Link>
      <div className="w-full max-w-md rounded-2xl border border-line bg-surface p-5 shadow-sm sm:p-7">{children}</div>
      <p className="mt-6 text-xs text-muted">Workshop management for automotive businesses</p>
    </div>
  );
}
