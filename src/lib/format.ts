/**
 * Date/time display in the business's own timezone and locale. Storage is always
 * UTC; only rendering is localised, so a multi-timezone future needs no data change.
 */
export function formatDateTime(d: Date | string, timeZone = 'Africa/Johannesburg', locale = 'en-ZA'): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(new Date(d));
}

export function formatDate(d: Date | string, timeZone = 'Africa/Johannesburg', locale = 'en-ZA'): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone }).format(new Date(d));
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  const gb = n / 1024 / 1024 / 1024;
  return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`;
}
