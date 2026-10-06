import { describe, expect, it } from 'vitest';
import {
  base32Decode, base32Encode, currentStep, decryptSecret, encryptSecret, generateRecoveryCodes, generateTotpSecret,
  hashRecoveryCode, normalizeRecoveryCode, otpauthUri, totpAtStep, verifyTotp,
} from '@/server/auth/totp';
import { describeUserAgent } from '@/lib/user-agent';

describe('TOTP (RFC 6238)', () => {
  // RFC 6238 Appendix B, SHA-1, secret "12345678901234567890". Codes are 8 digits there; ours are the last 6.
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  const vectors: [number, string][] = [
    [59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037'], [20000000000, '353130'],
  ];
  it.each(vectors)('matches the reference vector at T=%i', (t, code) => {
    expect(totpAtStep(secret, Math.floor(t / 30))).toBe(code);
  });

  it('base32 round-trips', () => {
    for (const len of [1, 5, 10, 20, 33]) {
      const buf = Buffer.from(Array.from({ length: len }, (_, i) => (i * 37 + 11) % 256));
      expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true);
    }
    expect(base32Decode('MFRGGZDFMZTWQ2LK').toString()).toBe('abcdefghij');
    expect(base32Decode('mfrg gzdf mztw q2lk').toString()).toBe('abcdefghij'); // tolerant of case and spacing
    expect(() => base32Decode('not*base32')).toThrow();
  });

  it('generates 160-bit secrets that differ every time', () => {
    const a = generateTotpSecret();
    expect(base32Decode(a)).toHaveLength(20);
    expect(generateTotpSecret()).not.toBe(a);
  });

  it('accepts the current code and one step of drift either side, nothing else', () => {
    const now = 1_700_000_000_000;
    const step = currentStep(now);
    for (const s of [step - 1, step, step + 1]) expect(verifyTotp(secret, totpAtStep(secret, s), 0, now)).toBe(s);
    for (const s of [step - 2, step + 2]) expect(verifyTotp(secret, totpAtStep(secret, s), 0, now)).toBeNull();
  });

  it('a code can never be used twice (replay protection via last-used step)', () => {
    const now = 1_700_000_000_000;
    const step = currentStep(now);
    const code = totpAtStep(secret, step);
    expect(verifyTotp(secret, code, 0, now)).toBe(step);
    expect(verifyTotp(secret, code, step, now)).toBeNull(); // same code again
    expect(verifyTotp(secret, totpAtStep(secret, step - 1), step, now)).toBeNull(); // an older code after a newer one
    expect(verifyTotp(secret, totpAtStep(secret, step + 1), step, now)).toBe(step + 1);
  });

  it('rejects malformed codes', () => {
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 5x']) expect(verifyTotp(secret, bad, 0)).toBeNull();
  });

  it('builds an otpauth URI authenticator apps understand', () => {
    const uri = otpauthUri('ABC234', 'jo@example.test');
    expect(uri).toMatch(/^otpauth:\/\/totp\/TFME%20Auto%3Ajo%40example\.test\?secret=ABC234&issuer=TFME%20Auto/);
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
  });
});

describe('secret encryption at rest (AES-256-GCM)', () => {
  it('round-trips, and every encryption of the same secret is different', () => {
    const a = encryptSecret('JBSWY3DPEHPK3PXP');
    const b = encryptSecret('JBSWY3DPEHPK3PXP');
    expect(a).not.toBe(b);
    expect(a).not.toContain('JBSWY3DPEHPK3PXP');
    expect(decryptSecret(a)).toBe('JBSWY3DPEHPK3PXP');
  });
  it('detects tampering', () => {
    const [iv, tag, enc] = encryptSecret('JBSWY3DPEHPK3PXP').split('.');
    const flipped = Buffer.from(enc!, 'base64');
    flipped[0] = flipped[0]! ^ 1;
    expect(() => decryptSecret([iv, tag, flipped.toString('base64')].join('.'))).toThrow();
    expect(() => decryptSecret('garbage')).toThrow();
  });
});

describe('recovery codes', () => {
  it('are 10 unique, high-entropy, human-friendly codes', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/);
  });
  it('hash identically however the person types them, and never equal the plaintext', () => {
    expect(hashRecoveryCode('ABCDE-FGH23')).toBe(hashRecoveryCode('abcde fgh23'));
    expect(hashRecoveryCode('abcdefgh23')).toBe(hashRecoveryCode(' abcde-fgh23 '));
    expect(hashRecoveryCode('abcde-fgh23')).not.toContain('abcde');
    expect(normalizeRecoveryCode('AbC-De')).toBe('abcde');
  });
});

describe('device descriptions', () => {
  it('summarises common browsers and devices', () => {
    expect(describeUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36')).toMatchObject({ label: 'Chrome on Windows', type: 'Desktop' });
    expect(describeUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1')).toMatchObject({ label: 'Safari on iOS', type: 'Mobile' });
    expect(describeUserAgent('Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 Chrome/126.0 Safari/537.36')).toMatchObject({ os: 'Android', type: 'Tablet' });
    expect(describeUserAgent('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/126.0 Safari/537.36 Edg/126.0')).toMatchObject({ browser: 'Edge' });
    expect(describeUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) Gecko/20100101 Firefox/127.0')).toMatchObject({ label: 'Firefox on macOS' });
  });
  it('copes with missing or odd input', () => {
    expect(describeUserAgent(null).label).toBe('Unknown device');
    expect(describeUserAgent('').label).toBe('Unknown device');
    expect(describeUserAgent('curl/8.0').browser).toBe('API client');
  });
});
