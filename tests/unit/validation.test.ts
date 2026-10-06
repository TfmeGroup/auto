import { describe, expect, it } from 'vitest';
import {
  emailSchema, escapeLike, optionalPhone, pageMeta, paginationSchema, parseOrThrow, passwordSchema, phoneSchema,
} from '@/lib/validation';
import { detectFileType, sanitizeFilename } from '@/server/files/sniff';
import { AppError } from '@/lib/errors';
import { phpUrlencode, payfastSignature } from '@/server/billing/payfast';

describe('input validation', () => {
  it('normalises and validates email', () => {
    expect(emailSchema.parse('  Foo@Example.COM ')).toBe('foo@example.com');
    expect(emailSchema.safeParse('not-an-email').success).toBe(false);
    expect(emailSchema.safeParse('a'.repeat(250) + '@x.co').success).toBe(false);
  });
  it('validates phone numbers loosely but safely', () => {
    expect(phoneSchema.safeParse('+27 82 123 4567').success).toBe(true);
    expect(phoneSchema.safeParse('(021) 555-0100').success).toBe(true);
    expect(phoneSchema.safeParse('12345').success).toBe(false);
    expect(phoneSchema.safeParse('phone: 0821234567').success).toBe(false);
    expect(optionalPhone.parse('')).toBeUndefined();
  });
  it('enforces a sensible password policy', () => {
    expect(passwordSchema.safeParse('short1!').success).toBe(false);
    expect(passwordSchema.safeParse('password123').success).toBe(false); // common
    expect(passwordSchema.safeParse('aaaaaaaaaaaa').success).toBe(false); // no variety
    expect(passwordSchema.safeParse('x'.repeat(129)).success).toBe(false);
    expect(passwordSchema.safeParse('Correct-Horse-9!').success).toBe(true);
  });
  it('turns schema failures into field-level validation errors', () => {
    try {
      parseOrThrow(emailSchema, 'nope');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).status).toBe(422);
    }
  });
  it('bounds pagination', () => {
    expect(paginationSchema.parse({})).toEqual({ page: 1, pageSize: 25 });
    expect(paginationSchema.safeParse({ pageSize: 101 }).success).toBe(false);
    expect(paginationSchema.safeParse({ page: 0 }).success).toBe(false);
    expect(pageMeta(2, 25, 51)).toEqual({ page: 2, pageSize: 25, total: 51, totalPages: 3 });
  });
  it('escapes LIKE wildcards so user input matches literally', () => {
    expect(escapeLike('100%_off\\')).toBe('100\\%\\_off\\\\');
  });
});

describe('uploaded file content detection (never trust the declared type)', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  it('identifies real images/PDFs by their bytes', () => {
    expect(detectFileType(png, 'x.png')?.mime).toBe('image/png');
    expect(detectFileType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]), 'a.jpg')?.mime).toBe('image/jpeg');
    expect(detectFileType(Buffer.from('%PDF-1.7 ...'), 'a.pdf')?.mime).toBe('application/pdf');
    expect(detectFileType(Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBP'), Buffer.alloc(8)]), 'a.webp')?.mime).toBe('image/webp');
  });
  it('rejects a script renamed to look like an image', () => {
    expect(detectFileType(Buffer.from('<script>alert(1)</script>'), 'evil.png')).toBeNull();
    expect(detectFileType(Buffer.from('<html><body>x</body></html>'), 'evil.jpg')).toBeNull();
  });
  it('rejects SVG, executables and unknown binaries', () => {
    expect(detectFileType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'a.svg')).toBeNull();
    expect(detectFileType(Buffer.from('MZ\x90\x00\x03\x00\x00\x00'), 'a.exe')).toBeNull();
    expect(detectFileType(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]), 'a.bin')).toBeNull();
  });
  it('accepts zip-based Office files only with a matching extension', () => {
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
    expect(detectFileType(zip, 'quote.docx')?.ext).toBe('docx');
    expect(detectFileType(zip, 'stock.xlsx')?.ext).toBe('xlsx');
    expect(detectFileType(zip, 'archive.zip')).toBeNull();
  });
  it('accepts plain text/CSV but not binary posing as text', () => {
    expect(detectFileType(Buffer.from('a,b,c\n1,2,3'), 'data.csv')?.mime).toBe('text/csv');
    expect(detectFileType(Buffer.from([0x61, 0, 0x62, 0, 0x63, 0]), 'notes.txt')).toBeNull();
  });
  it('sanitises filenames', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('C:\\Users\\x\\a<b>.png')).toBe('a_b_.png');
    expect(sanitizeFilename('..')).toBe('file');
    expect(sanitizeFilename('a'.repeat(300)).length).toBe(150);
  });
});

describe('PayFast signature primitives', () => {
  it('url-encodes like PHP urlencode', () => {
    expect(phpUrlencode('John Doe & Co (Pty) Ltd!')).toBe('John+Doe+%26+Co+%28Pty%29+Ltd%21');
    expect(phpUrlencode('a~b*c')).toBe('a%7Eb%2Ac');
    expect(phpUrlencode('https://x.test/a?b=c')).toBe('https%3A%2F%2Fx.test%2Fa%3Fb%3Dc');
  });
  it('produces a stable md5 over ordered fields plus passphrase', () => {
    const pairs: [string, string][] = [['merchant_id', '10000100'], ['amount', '100.00'], ['item_name', 'Test Item']];
    const a = payfastSignature(pairs, 'secret');
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(payfastSignature(pairs, 'secret')).toBe(a);
    expect(payfastSignature(pairs, 'other')).not.toBe(a);
    expect(payfastSignature([...pairs].reverse(), 'secret')).not.toBe(a); // order matters
  });
});
