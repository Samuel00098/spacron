const REPO = 'Samuel00098/spacron-releases';

export type Release = {
  tag_name: string;
  assets: unknown[];
};

export type Platform = 'windows' | 'mac' | 'linux';

export const PLATFORMS: readonly Platform[] = ['windows', 'mac', 'linux'];

export async function getLatestReleaseWithAssets(): Promise<Release | null> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=5`, {
    headers: { 'User-Agent': 'spacron-website', Accept: 'application/vnd.github+json' },
    next: { revalidate: 300 },
  });

  if (!res.ok) return null;

  const releases = (await res.json()) as Release[];
  for (const release of releases) {
    if (release.assets && release.assets.length > 0) {
      return release;
    }
  }
  return null;
}

export function downloadUrlFor(platform: Platform, release: Release): string {
  const version = release.tag_name.replace(/^v/, '');
  const assetName: Record<Platform, string> = {
    windows: `Spacron_${version}_x64-setup.exe`,
    mac: `Spacron_${version}_aarch64.dmg`,
    linux: `Spacron_${version}_amd64.AppImage`,
  };
  return `https://github.com/${REPO}/releases/download/${release.tag_name}/${assetName[platform]}`;
}