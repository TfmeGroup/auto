import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { allowedVariables, EVENTS, EVENT_KEYS, VARIABLES, type EventKey } from '@/server/notifications/events';
import { emailHtml, redactLinks, renderText, sampleVars, validateTemplate } from '@/server/notifications/render';
import { toE164 } from '@/server/notifications/comms';
import { addMonths, dueKeyOf, nextServiceDue, reminderIsDue } from '@/server/notifications/reminders';
import { parseTwilioStatus, verifyTwilioSignature } from '@/server/notifications/providers/twilio';
import { signFileLink, verifyFileLink } from '@/server/files/signed';
import { builtinScanner, zipListing } from '@/server/files/scan';
import { photoFileCategory } from '@/server/jobcards/items';
import { makeZip, realDocx } from '../helpers/images';

describe('safe template rendering', () => {
  it('replaces only {{placeholders}}, in one pass, and never evaluates anything', () => {
    expect(renderText('Hi {{customer_name}}, see {{secure_link}}', { customer_name: 'Alex', secure_link: 'https://x/q/abc' })).toBe('Hi Alex, see https://x/q/abc');
    // a value that itself contains a placeholder is not expanded again
    expect(renderText('{{customer_name}}', { customer_name: '{{business_phone}}', business_phone: '555' })).toBe('{{business_phone}}');
    // no expressions, no lookups: these are just text
    expect(renderText('${process.env.SECRET} {{ constructor }} <%= 1+1 %>', {})).toBe('${process.env.SECRET}  <%= 1+1 %>');
    // missing values vanish rather than printing the raw placeholder
    expect(renderText('Hello {{customer_name}}!', {})).toBe('Hello !');
  });

  it('refuses a template that uses a variable its message may not use, or is malformed', () => {
    const ok = validateTemplate('QUOTE_SENT', 'Quote {{quote_number}}', 'Hello {{customer_name}}: {{secure_link}}');
    expect(ok).toEqual([]);
    const bad = validateTemplate('QUOTE_SENT', 'x', 'Your balance is {{amount_due}} {{constructor.constructor}} {{ }}');
    expect(bad.map((p) => p.message).join(' ')).toMatch(/amount_due/);
    expect(bad.length).toBeGreaterThanOrEqual(2);
    expect(validateTemplate('QUOTE_SENT', 'x', 'Open {{secure_link').some((p) => /unfinished/.test(p.message))).toBe(true);
    expect(validateTemplate('QUOTE_SENT', '', 'body').some((p) => p.field === 'subject')).toBe(true);
    expect(validateTemplate('QUOTE_SENT', 'a\nb', 'body').some((p) => /one line/.test(p.message))).toBe(true);
    expect(validateTemplate('BOOKING_REMINDER', null, 'x'.repeat(481), 'SMS').some((p) => /480/.test(p.message))).toBe(true);
  });

  it('every event\'s own default wording only uses the variables that event is allowed', () => {
    for (const key of EVENT_KEYS) {
      const e = EVENTS[key];
      for (const [channel, t] of Object.entries(e.defaults)) {
        const problems = validateTemplate(key as EventKey, t.subject, t.body, channel as 'EMAIL' | 'SMS' | 'WHATSAPP');
        expect(problems, `${key}/${channel}`).toEqual([]);
      }
      // a text channel is declared for an event only if it has wording for it
      for (const c of e.channels) expect(e.defaults[c], `${key} declares ${c}`).toBeTruthy();
    }
    for (const key of EVENT_KEYS) for (const v of allowedVariables(key)) expect(VARIABLES[v], v).toBeTruthy();
  });

  it('previews use representative placeholders, never real data', () => {
    const vars = sampleVars('INVOICE_SENT');
    expect(Object.keys(vars)).toContain('invoice_number');
    expect(vars.customer_name).toBe('Alex Sample');
  });

  it('escapes everything it puts in HTML, and links are only made from what survives escaping', () => {
    const html = emailHtml('Hi <script>alert(1)</script> https://example.com/q/abc?a=1&b=2', { businessName: 'A&B <Motors>', signature: '<b>sig</b>' });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('A&amp;B &lt;Motors&gt;');
    expect(html).toContain('&lt;b&gt;sig&lt;/b&gt;');
    expect(html).toContain('<a href="https://example.com/q/abc?a=1&amp;b=2"');
  });

  it('keeps a customer\'s private links out of the stored history text', () => {
    const t = 'Review: https://app.example.com/q/' + 'a'.repeat(43) + ' and stop: https://app.example.com/optout/' + 'b'.repeat(60) + '.' + 'c'.repeat(43);
    const r = redactLinks(t);
    expect(r).toContain('/q/[private link]');
    expect(r).toContain('/optout/[private link]');
    expect(r).not.toMatch(/a{20}|b{20}|c{20}/);
    expect(redactLinks('https://x.test/api/public/files/' + 'z'.repeat(80))).toContain('[private link]');
  });
});

describe('phone numbers', () => {
  it('turns local numbers into E.164 using the business country, and refuses what it cannot be sure of', () => {
    expect(toE164('082 555 0100', 'ZA')).toBe('+27825550100');
    expect(toE164('+27 82 555 0100', 'ZA')).toBe('+27825550100');
    expect(toE164('0027825550100', 'ZA')).toBe('+27825550100');
    expect(toE164('27825550100', 'ZA')).toBe('+27825550100');
    expect(toE164('0825550100', 'XX')).toBeNull(); // unknown country: needs a +
    expect(toE164('12', 'ZA')).toBeNull();
    expect(toE164(null, 'ZA')).toBeNull();
  });
});

describe('service reminders are deterministic', () => {
  it('adds months without overflowing short months', () => {
    expect(addMonths(new Date('2026-01-31T00:00:00Z'), 1).toISOString().slice(0, 10)).toBe('2026-02-28');
    expect(addMonths(new Date('2026-01-01T00:00:00Z'), 6).toISOString().slice(0, 10)).toBe('2026-07-01');
    expect(addMonths(new Date('2024-01-31T00:00:00Z'), 1).toISOString().slice(0, 10)).toBe('2024-02-29');
  });

  it('works out the next service by date and by mileage', () => {
    const due = nextServiceDue({ everyKm: 10_000, everyMonths: 6, lastServiceAt: new Date('2026-01-01T00:00:00Z'), lastServiceKm: 10_000 });
    expect(due.dueKm).toBe(20_000);
    expect(due.dueDate?.toISOString().slice(0, 10)).toBe('2026-07-01');
    expect(nextServiceDue({ everyKm: null, everyMonths: 12, lastServiceAt: null, lastServiceKm: null })).toEqual({ dueDate: null, dueKm: null });
    expect(nextServiceDue({ everyKm: 10_000, everyMonths: null, lastServiceAt: null, lastServiceKm: 5_000 })).toEqual({ dueDate: null, dueKm: 15_000 });
  });

  it('is due within the lead time of the date or the mileage, whichever comes first, and stays due once overdue', () => {
    const due = nextServiceDue({ everyKm: 10_000, everyMonths: 6, lastServiceAt: new Date('2026-01-01T00:00:00Z'), lastServiceKm: 10_000 });
    const day = (s: string) => new Date(`${s}T00:00:00Z`);
    expect(reminderIsDue(due, day('2026-06-01'), 12_000, 14, 1000)).toBe(false);
    expect(reminderIsDue(due, day('2026-06-17'), 12_000, 14, 1000)).toBe(true); // 14 days before 1 July
    expect(reminderIsDue(due, day('2026-03-01'), 19_200, 14, 1000)).toBe(true); // within 1000 km of 20 000
    expect(reminderIsDue(due, day('2026-03-01'), 18_900, 14, 1000)).toBe(false);
    expect(reminderIsDue(due, day('2026-09-01'), 12_000, 14, 1000)).toBe(true); // overdue
    expect(reminderIsDue({ dueDate: null, dueKm: null }, day('2026-09-01'), 99_999, 14, 1000)).toBe(false);
    // a new service moves the due point, which is what makes the next reminder possible
    expect(dueKeyOf(due)).not.toBe(dueKeyOf(nextServiceDue({ everyKm: 10_000, everyMonths: 6, lastServiceAt: new Date('2026-07-05T00:00:00Z'), lastServiceKm: 20_100 })));
  });
});

describe('provider callbacks', () => {
  it('verifies the provider signature and refuses anything else', () => {
    const token = 'secret-token';
    const url = 'https://app.example.com/api/public/webhooks/twilio';
    const params = { MessageSid: 'SM123', MessageStatus: 'delivered', To: '+27825550100' };
    const data = url + Object.keys(params).sort().map((k) => k + (params as Record<string, string>)[k]).join('');
    const good = createHmac('sha1', token).update(data).digest('base64');
    expect(verifyTwilioSignature(token, url, params, good)).toBe(true);
    expect(verifyTwilioSignature(token, url, { ...params, MessageStatus: 'failed' }, good)).toBe(false);
    expect(verifyTwilioSignature('other', url, params, good)).toBe(false);
    expect(verifyTwilioSignature(token, url, params, 'AAAA')).toBe(false);
  });

  it('maps provider states and never invents delivery', () => {
    expect(parseTwilioStatus({ MessageSid: 'SM1', MessageStatus: 'queued' })?.state).toBe('sent');
    expect(parseTwilioStatus({ MessageSid: 'SM1', MessageStatus: 'delivered' })?.state).toBe('delivered');
    expect(parseTwilioStatus({ MessageSid: 'SM1', MessageStatus: 'read' })?.state).toBe('viewed');
    expect(parseTwilioStatus({ MessageSid: 'SM1', MessageStatus: 'undelivered', ErrorCode: '30003' })).toMatchObject({ state: 'failed' });
    expect(parseTwilioStatus({ MessageSid: 'SM1', MessageStatus: 'something-new' })).toBeNull();
    expect(parseTwilioStatus({ MessageStatus: 'sent' })).toBeNull();
  });
});

describe('signed download links', () => {
  const p = { f: 'f'.repeat(8), b: 'b'.repeat(8), u: 'u1', s: 'staff' as const };

  it('round-trips, expires, and rejects tampering', () => {
    const { token, expiresAt } = signFileLink(p, 60, 1_000_000);
    expect(verifyFileLink(token, 1_000_000 + 30_000)).toMatchObject({ f: p.f, b: p.b, u: 'u1', s: 'staff' });
    expect(expiresAt.getTime()).toBe(1_060_000);
    expect(() => verifyFileLink(token, 1_000_000 + 61_000)).toThrow(/expired/);
    const [body, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, 'base64url').toString()), b: 'other-business' })).toString('base64url');
    expect(() => verifyFileLink(`${forged}.${sig}`, 1_000_000)).toThrow(/not valid/);
    expect(() => verifyFileLink('garbage', 1_000_000)).toThrow(/not valid/);
    expect(() => verifyFileLink(`${body}.`, 1_000_000)).toThrow(/not valid/);
  });

  it('never lives longer than the maximum, whatever is asked', () => {
    const { expiresAt } = signFileLink(p, 99_999, 0);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(15 * 60_000);
    expect(signFileLink(p, 1, 0).expiresAt.getTime()).toBeGreaterThanOrEqual(30_000);
  });
});

describe('upload scanning (structural checks)', () => {
  it('flags the antivirus test signature, macros, programs inside Office files and active PDFs, and passes clean files', async () => {
    const eicar = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');
    expect((await builtinScanner.scan(eicar, 'text/plain')).status).toBe('flagged');
    expect((await builtinScanner.scan(Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/OpenAction<</S/JavaScript/JS(app.alert(1))>>>>endobj'), 'application/pdf')).status).toBe('flagged');
    expect((await builtinScanner.scan(Buffer.from('%PDF-1.4\n1 0 obj<</S/Launch/F(cmd.exe)>>endobj'), 'application/pdf')).status).toBe('flagged');
    expect((await builtinScanner.scan(Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj'), 'application/pdf')).status).toBe('clean');
    const OFFICE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    expect((await builtinScanner.scan(realDocx(), OFFICE)).status).toBe('clean');
    const macro = makeZip([{ name: '[Content_Types].xml', data: Buffer.from('x') }, { name: 'word/vbaProject.bin', data: Buffer.from('x') }]);
    expect(await builtinScanner.scan(macro, OFFICE)).toMatchObject({ status: 'flagged', reason: expect.stringMatching(/macro/) });
    const exe = makeZip([{ name: '[Content_Types].xml', data: Buffer.from('x') }, { name: 'payload/setup.exe', data: Buffer.from('MZ') }]);
    expect((await builtinScanner.scan(exe, OFFICE)).status).toBe('flagged');
    expect((await builtinScanner.scan(Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(40)]), OFFICE)).status).toBe('flagged'); // not a readable zip
    expect(zipListing(realDocx()).map((e) => e.name)).toContain('word/document.xml');
  });
});

describe('job photo categories', () => {
  it('files check-in views and repair stages as vehicle photos, evidence as diagnostic, parts as part documents', () => {
    expect(photoFileCategory('CHECK_IN_FRONT')).toBe('VEHICLE_PHOTO');
    expect(photoFileCategory('BEFORE_REPAIR')).toBe('VEHICLE_PHOTO');
    expect(photoFileCategory('DIAGNOSTIC_EVIDENCE')).toBe('DIAGNOSTIC');
    expect(photoFileCategory('PARTS')).toBe('PART_DOCUMENT');
    expect(photoFileCategory('SIGNATURE')).toBe('JOB_DOCUMENT');
  });
});
