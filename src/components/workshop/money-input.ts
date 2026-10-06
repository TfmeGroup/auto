import { parseDecimalToCents } from '@/lib/money';

/** Form helper: "450", "450.5" or "R 450,50" → cents as a string for the API ('' stays empty, junk is passed through so the server reports it). */
export function randToCents(raw: string): string {
  const cleaned = raw.replace(/[Rr\s]/g, '').replace(',', '.');
  if (cleaned === '') return '';
  try {
    return String(parseDecimalToCents(cleaned));
  } catch {
    return raw;
  }
}

/** "P0301, p0420 U0100" → ["P0301", "p0420", "U0100"] (the server normalises and validates each code). */
export function splitCodes(raw: string): string[] {
  return raw.split(/[\s,;]+/).filter(Boolean);
}
