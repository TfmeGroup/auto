/** Shown while any page inside the app shell is loading its data (customers, vehicles, calendar, job card…). */
export default function Loading() {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className="animate-pulse space-y-4">
      <span className="sr-only">Loading…</span>
      <div className="h-8 w-56 rounded-lg bg-line" />
      <div className="h-4 w-80 max-w-full rounded bg-line/70" />
      <div className="grid grid-cols-2 gap-3 pt-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => <div key={i} className="h-24 rounded-xl border border-line bg-surface" />)}
      </div>
      <div className="h-64 rounded-xl border border-line bg-surface" />
    </div>
  );
}
