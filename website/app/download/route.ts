import { NextRequest, NextResponse } from 'next/server';

const REPO = 'Samuel00098/spacron-releases';
const FALLBACK_URL = `https://github.com/${REPO}/releases/latest`;

async function getLatestReleaseWithAssets() {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=5`, {
    headers: { 'User-Agent': 'spacron-website', Accept: 'application/vnd.github+json' },
    next: { revalidate: 300 },
  });

  if (!res.ok) return null;

  const releases = await res.json();
  for (const release of releases) {
    if (release.assets && release.assets.length > 0) {
      return release;
    }
  }
  return null;
}

export async function GET(request: NextRequest) {
  const ua = request.headers.get('user-agent') || '';

  let os: string;
  if (ua.includes('Windows')) os = 'windows';
  else if (ua.includes('Mac OS') || ua.includes('Macintosh')) os = 'mac';
  else if (ua.includes('Linux')) os = 'linux';
  else os = 'linux';

  try {
    const release = await getLatestReleaseWithAssets();
    if (!release) {
      return NextResponse.redirect(FALLBACK_URL);
    }

    const tag = release.tag_name;
    const version = tag.replace(/^v/, '');

    const assetName: Record<string, string> = {
      windows: `Spacron_${version}_x64-setup.exe`,
      mac: `Spacron_${version}_aarch64.dmg`,
      linux: `Spacron_${version}_amd64.AppImage`,
    };

    const downloadUrl = `https://github.com/${REPO}/releases/download/${tag}/${assetName[os]}`;
    return NextResponse.redirect(downloadUrl);
  } catch {
    return NextResponse.redirect(FALLBACK_URL);
  }
}
