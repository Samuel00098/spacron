import { NextRequest, NextResponse } from 'next/server';
import { licensingMode, verifyDownloadToken } from '@/lib/license';
import { downloadUrlFor, getLatestReleaseWithAssets, PLATFORMS, Platform } from '@/lib/releases';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ platform: string }> },
) {
  const { platform } = await params;
  if (!(PLATFORMS as readonly string[]).includes(platform)) {
    return new NextResponse('Unknown platform', { status: 404 });
  }

  const mode = licensingMode();
  if (mode === 'misconfigured') {
    return NextResponse.json({ ok: false, error: 'LICENSE_SERVICE_NOT_CONFIGURED' }, { status: 503 });
  }
  if (mode === 'enforced') {
    // The page trades a license key for this short-lived token, so the key
    // itself never travels in a URL (history, logs, referrers).
    const token = new URL(request.url).searchParams.get('token') ?? '';
    if (!verifyDownloadToken(token)) {
      return NextResponse.redirect(new URL('/download', request.url));
    }
  }

  const release = await getLatestReleaseWithAssets();
  if (!release) {
    return NextResponse.json({ ok: false, error: 'NO_RELEASE' }, { status: 503 });
  }

  const response = NextResponse.redirect(downloadUrlFor(platform as Platform, release));
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}
