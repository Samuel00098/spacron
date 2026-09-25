import { NextRequest, NextResponse } from 'next/server';
import { issueDownloadToken, licensingMode, unlockDevice } from '@/lib/license';
import { clientIp, rateLimited } from '@/lib/rateLimit';

export const dynamic = 'force-dynamic';

const MAX_KEY = 100;
const MAX_NAME = 64;

export async function POST(request: NextRequest) {
  const mode = licensingMode();
  if (mode !== 'enforced') {
    const error = mode === 'open' ? 'LICENSING_DISABLED' : 'LICENSE_SERVICE_NOT_CONFIGURED';
    return NextResponse.json({ ok: false, error }, { status: mode === 'open' ? 400 : 503 });
  }

  if (rateLimited(`license:${clientIp(request.headers)}`, 10, 10 * 60 * 1000)) {
    return NextResponse.json({ ok: false, error: 'RATE_LIMITED' }, { status: 429 });
  }

  let licenseKey = '';
  let instanceName = '';
  let instanceId = '';
  try {
    const body = await request.json();
    licenseKey = String(body?.licenseKey ?? '').trim();
    instanceName = String(body?.instanceName ?? '').trim();
    instanceId = String(body?.instanceId ?? '').trim();
  } catch {
    return NextResponse.json({ ok: false, error: 'BAD_REQUEST' }, { status: 400 });
  }

  if (!licenseKey || !instanceName) {
    return NextResponse.json({ ok: false, error: 'MISSING_FIELDS' }, { status: 400 });
  }
  if (licenseKey.length > MAX_KEY || instanceName.length > MAX_NAME || instanceId.length > MAX_KEY) {
    return NextResponse.json({ ok: false, error: 'BAD_REQUEST' }, { status: 400 });
  }

  const result = await unlockDevice(licenseKey, instanceName, instanceId || undefined);
  if (!result.ok) {
    const status = result.error === 'UPSTREAM_UNREACHABLE' ? 502 : 403;
    return NextResponse.json({ ok: false, error: result.error }, { status });
  }

  const { token, expiresAt } = issueDownloadToken();
  return NextResponse.json(
    { ok: true, instanceId: result.instanceId, downloadToken: token, expiresAt },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
