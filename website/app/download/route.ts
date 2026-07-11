import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  const ua = request.headers.get('user-agent') || '';

  let os: string;
  if (ua.includes('Windows')) os = 'windows';
  else if (ua.includes('Mac OS') || ua.includes('Macintosh')) os = 'mac';
  else if (ua.includes('Linux')) os = 'linux';
  else os = 'linux';

  try {
    const res = await fetch('https://api.github.com/repos/Samuel00098/spacron-releases/releases/latest', {
      headers: { 'User-Agent': 'spacron-website' },
      next: { revalidate: 300 },
    });

    if (!res.ok) {
      return NextResponse.redirect('https://github.com/Samuel00098/spacron-releases/releases/latest');
    }

    const release = await res.json();
    const tag = release.tag_name;

    const assetName: Record<string, string> = {
      windows: `Spacron_${tag.replace(/^v/, '')}_x64-setup.exe`,
      mac: `Spacron_${tag.replace(/^v/, '')}_aarch64.dmg`,
      linux: `Spacron_${tag.replace(/^v/, '')}_x86_64.AppImage`,
    };

    const downloadUrl = `https://github.com/Samuel00098/spacron-releases/releases/latest/download/${assetName[os]}`;
    return NextResponse.redirect(downloadUrl);
  } catch {
    return NextResponse.redirect('https://github.com/Samuel00098/spacron-releases/releases/latest');
  }
}
