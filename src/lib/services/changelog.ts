import { invoke } from '@tauri-apps/api/core';
import { isTauriRuntime } from '$lib/utils/tauri';
import { get } from '$lib/stores/storeCompat';
import { siteUrl } from '$lib/stores/settings';

// The marketing site. VITE_SITE_URL overrides at build time; the fallback is the
// permanent *.vercel.app project URL, which keeps working even if a custom
// domain is added or changed later — so links baked into shipped builds never
// break when the domain moves.
const FALLBACK_SITE_URL = (import.meta.env.VITE_SITE_URL ?? 'https://spacron.vercel.app').replace(/\/+$/, '');

export function getChangelogUrl() {
  const userSiteUrl = get(siteUrl);
  const site = (userSiteUrl && userSiteUrl.trim() !== '') ? userSiteUrl.trim() : FALLBACK_SITE_URL;
  return `${site.replace(/\/+$/, '')}/changelog`;
}

/**
 * Opens the web changelog. Pass the release version (e.g. "0.6.4" or "v0.6.4")
 * to land directly on that release's section on the page.
 */
export async function openChangelogPage(version?: string) {
  const changelogUrl = getChangelogUrl();
  const anchor = version ? `#v${version.replace(/^v/, '')}` : '';
  const url = `${changelogUrl}${anchor}`;

  if (!isTauriRuntime()) {
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }

  await invoke('preview_open_in_browser', { url });
}
