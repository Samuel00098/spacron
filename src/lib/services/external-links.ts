/**
 * A link that nothing else handled would load in the app's own webview and
 * replace the whole window. Send web links to Preview instead (or to the system
 * browser, if that is what Settings > Browser says).
 */
import { openUrlInPreviewPanel } from '$lib/stores/preview';

/** The URL to open in Preview, or null to leave the click alone. */
export function externalLinkUrl(anchor: Element | null, appOrigin: string): string | null {
  const href = anchor?.getAttribute('href') ?? '';
  if (!/^https?:\/\//i.test(href) || anchor?.hasAttribute('download')) return null;
  try {
    const url = new URL(href);
    return url.origin === appOrigin ? null : url.href;
  } catch {
    return null;
  }
}

export function routeExternalLinks(): () => void {
  const onClick = (event: MouseEvent) => {
    // A component that handled its own link has already called preventDefault.
    if (event.defaultPrevented || (event.type === 'auxclick' && event.button !== 1)) return;
    const anchor = event.target instanceof Element ? event.target.closest('a') : null;
    const url = externalLinkUrl(anchor, window.location.origin);
    if (!url) return;
    event.preventDefault();
    void openUrlInPreviewPanel(url);
  };
  window.addEventListener('click', onClick);
  window.addEventListener('auxclick', onClick);
  return () => {
    window.removeEventListener('click', onClick);
    window.removeEventListener('auxclick', onClick);
  };
}
