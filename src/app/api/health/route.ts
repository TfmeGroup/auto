import { NextResponse } from 'next/server';

/** Liveness: the process is up. Does not touch dependencies (cheap enough for frequent probes). */
export const dynamic = 'force-dynamic';

export function GET() {
  return NextResponse.json({ status: 'ok' }, { headers: { 'cache-control': 'no-store' } });
}
