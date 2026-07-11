import { invoke } from '@tauri-apps/api/core';
import { isTauriRuntime } from '$lib/utils/tauri';

// The marketing site. VITE_SITE_URL overrides at build time; the fallback is the
// permanent *.vercel.app project URL, which keeps working even if a custom
// domain is added or changed later — so links baked into shipped builds never
// break when the domain moves.
const FALLBACK_SITE_URL = (import.meta.env.VITE_SITE_URL ?? 'https://site-flame-phi.vercel.app').replace(/\/+$/, '');

let resolvedSiteUrl: string | null = null;
let detectionPromise: Promise<string> | null = null;

export async function getSiteUrl(): Promise<string> {
  // If running in browser (web demo), we can directly use the current origin
  if (!isTauriRuntime()) {
    return window.location.origin.replace(/\/+$/, '');
  }

  // If already resolved, return it
  if (resolvedSiteUrl) {
    return resolvedSiteUrl;
  }

  // If detection is already in progress, wait for it
  if (detectionPromise) {
    return detectionPromise;
  }

  // Start detection by requesting the HEAD of the fallback URL and following redirects
  detectionPromise = (async () => {
    try {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), 3500); // 3.5s timeout
      
      const res = await fetch(FALLBACK_SITE_URL, {
        method: 'HEAD',
        signal: controller.signal,
      });
      clearTimeout(id);

      if (res.url) {
        const url = new URL(res.url);
        resolvedSiteUrl = url.origin.replace(/\/+$/, '');
        return resolvedSiteUrl;
      }
    } catch (e) {
      console.warn('Failed to detect custom domain from Vercel, using fallback:', e);
    }
    resolvedSiteUrl = FALLBACK_SITE_URL;
    return resolvedSiteUrl;
  })();

  return detectionPromise;
}

/**
 * Opens the web changelog. Pass the release version (e.g. "0.6.4" or "v0.6.4")
 * to land directly on that release's section on the page.
 */
export async function openChangelogPage(version?: string) {
  const site = await getSiteUrl();
  const changelogUrl = `${site}/changelog`;
  const anchor = version ? `#v${version.replace(/^v/, '')}` : '';
  const url = `${changelogUrl}${anchor}`;

  if (!isTauriRuntime()) {
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }

  await invoke('preview_open_in_browser', { url });
}
