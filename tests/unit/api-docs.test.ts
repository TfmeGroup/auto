import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildApiDocs, endpoints } from '../../scripts/gen-api-docs';

const key = (e: { method: string; path: string }) => `${e.method} ${e.path}`;

describe('API reference', () => {
  it('is generated from the code and is up to date (run `npm run docs:api` if this fails)', () => {
    const committed = readFileSync('docs/API.md', 'utf8').replace(/\r\n/g, '\n');
    expect(committed).toBe(buildApiDocs().replace(/\r\n/g, '\n'));
  });

  it('declares access for every endpoint, and a permission for every business endpoint', () => {
    const all = endpoints();
    expect(all.length).toBeGreaterThan(350);
    expect(all.filter((e) => !['public', 'user', 'business', 'platform'].includes(e.access)).map(key)).toEqual([]);
    expect(all.filter((e) => e.access === 'business' && !e.permission).map(key)).toEqual([]);
  });

  it('the endpoints open to ANY member of a business are exactly the reviewed list (each checks what it returns itself)', () => {
    const open = endpoints().filter((e) => e.access === 'business' && e.permission === 'any member').map(key).sort();
    expect(open).toEqual([
      'DELETE /api/v1/notifications/{id}/read', // a person's own notification state
      'GET /api/v1/admin/alerts', // each alert is filtered by what the caller may act on
      'GET /api/v1/billing/entitlements', // what the plan allows; decides which screens show; no billing detail
      'GET /api/v1/business/logo', // the business's own logo
      'GET /api/v1/notifications', // the caller's own notifications
      'GET /api/v1/notifications/count',
      'GET /api/v1/team/technicians/{id}/metrics', // own figures; anyone else's need employee.view_reports (checked in the service)
      'POST /api/v1/notifications/read-all',
      'POST /api/v1/notifications/{id}/read',
    ].sort());
  });

  it('every state-changing business endpoint is blocked in read-only mode, except the reviewed list (they must work, or are not changes)', () => {
    const ungated = endpoints().filter((e) => e.access === 'business' && e.method !== 'GET' && !e.write).map(key).sort();
    expect(ungated).toEqual([
      'DELETE /api/v1/billing/downgrade', // paying, cancelling and downgrading must work when the business is suspended
      'DELETE /api/v1/notifications/{id}/read', // a person's own read state
      'POST /api/v1/billing/cancel',
      'POST /api/v1/billing/checkout',
      'POST /api/v1/billing/downgrade',
      'POST /api/v1/business/close', // closing never deletes data and stays possible
      'POST /api/v1/communication/templates/preview', // a preview; stores nothing
      'POST /api/v1/documents/generate', // returns an existing document; creating a new one is refused inside the service when read-only
      'POST /api/v1/exports', // a business can always take its data out
      'POST /api/v1/files/reconcile', // recounts usage
      'POST /api/v1/files/{id}/link', // a download link for something that already exists
      'POST /api/v1/notifications/read-all',
      'POST /api/v1/notifications/{id}/read',
      'POST /api/v1/reports/custom/run', // POST only because it carries a body; it reads
    ].sort());
  });

  it('platform endpoints are never reachable by a business role: they are declared platform-only', () => {
    const platform = endpoints().filter((e) => e.path.includes('/platform'));
    expect(platform.length).toBeGreaterThan(0);
    expect(platform.filter((e) => e.access !== 'platform').map(key)).toEqual([]);
  });
});
