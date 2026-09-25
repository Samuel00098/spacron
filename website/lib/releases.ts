const REPO = 'Samuel00098/spacron-releases';

type Release = {
  tag_name: string;
  assets: { name?: string; browser_download_url?: string }[];
};

export type Platform = 'windows' | 'windows-arm64' | 'mac' | 'linux';

export const PLATFORMS: readonly Platform[] = ['windows', 'windows-arm64', 'mac', 'linux'];

/** The installer file each platform downloads, as Tauri names it for `version`. */
function assetNameFor(platform: Platform, version: string): string {
  switch (platform) {
    case 'windows':
      return `Spacron_${version}_x64-setup.exe`;
    case 'windows-arm64':
      return `Spacron_${version}_arm64-setup.exe`;
    case 'mac':
      return `Spacron_${version}_aarch64.dmg`;
    case 'linux':
      return `Spacron_${version}_amd64.AppImage`;
  }
}

/**
 * Where to try, in order. Windows on ARM falls back to the x64 installer, which
 * Windows runs under its built-in emulation, so an ARM laptop always gets a
 * working download even from a release that predates the native ARM64 build.
 */
const LOOKUP_ORDER: Record<Platform, readonly Platform[]> = {
  windows: ['windows'],
  'windows-arm64': ['windows-arm64', 'windows'],
  mac: ['mac'],
  linux: ['linux'],
};

async function recentReleases(): Promise<Release[]> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=10`, {
    headers: { 'User-Agent': 'spacron-website', Accept: 'application/vnd.github+json' },
    next: { revalidate: 300 },
  });
  if (!res.ok) return [];
  return (await res.json()) as Release[];
}

/**
 * The newest installer that actually exists for `platform`. Each platform is
 * resolved on its own: while a release is still building its assets land one
 * job at a time, so "the newest release with any asset" would send the other
 * platforms to files that are not there yet.
 */
export async function latestDownloadUrl(platform: Platform): Promise<string | null> {
  const releases = await recentReleases();
  for (const candidate of LOOKUP_ORDER[platform]) {
    for (const release of releases) {
      const name = assetNameFor(candidate, release.tag_name.replace(/^v/, ''));
      const asset = release.assets?.find((a) => a.name === name);
      if (asset) {
        return asset.browser_download_url ?? `https://github.com/${REPO}/releases/download/${release.tag_name}/${name}`;
      }
    }
  }
  return null;
}
