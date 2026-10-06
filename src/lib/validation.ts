import { z } from 'zod';
import { Errors } from './errors';

/** Shared field schemas. Server-side validation is authoritative; forms reuse these messages. */

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, 'Email is too long')
  .pipe(z.email('Enter a valid email address'));

/** Digits with optional leading +, spaces, dashes, brackets. 7-20 digits. */
export const phoneSchema = z
  .string()
  .trim()
  .max(30)
  .refine((v) => /^[+]?[\d\s\-()]+$/.test(v) && v.replace(/\D/g, '').length >= 7 && v.replace(/\D/g, '').length <= 15, {
    message: 'Enter a valid phone number',
  });

const COMMON_PASSWORDS = new Set([
  'password',
  'password1',
  'password123',
  '123456789',
  '1234567890',
  'qwertyuiop',
  'qwerty123',
  'iloveyou1',
  'letmein123',
  'admin12345',
  'welcome123',
  'changeme123',
]);

export const passwordSchema = z
  .string()
  .min(10, 'Use at least 10 characters')
  .max(128, 'Password is too long')
  .refine((p) => !COMMON_PASSWORDS.has(p.toLowerCase()), 'That password is too common')
  .refine((p) => new Set(p).size >= 5, 'Use a more varied password');

export const uuidSchema = z.uuid('Invalid id');

export const nameSchema = z.string().trim().min(1, 'Required').max(120);

/** Optional text that turns "" into undefined, so empty form fields don't store ''. */
export const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v === undefined || v === '' ? undefined : v));

export const optionalEmail = z
  .union([z.literal(''), emailSchema])
  .optional()
  .transform((v) => (v ? v : undefined));

export const optionalPhone = z
  .union([z.literal(''), phoneSchema])
  .optional()
  .transform((v) => (v ? v : undefined));

/** Parse with a zod schema, throwing a field-level ValidationError on failure. */
export function parseOrThrow<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) throw Errors.validation(fieldErrors(result.error));
  return result.data;
}

export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_';
    if (!(key in out)) out[key] = issue.message;
  }
  return out;
}

// ─────────────── Pagination / sorting ───────────────

export const MAX_PAGE_SIZE = 100;

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(25),
});

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export function pageMeta(page: number, pageSize: number, total: number): PageMeta {
  return { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}

/** Escape LIKE/ILIKE wildcards so user input is matched literally. */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (c) => `\\${c}`);
}
