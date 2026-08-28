/** Return whether a browser reports an Apple desktop/mobile platform. */
export function isMacPlatform(platform?: string, userAgent?: string): boolean {
  const reportedPlatform = platform ?? (typeof navigator !== 'undefined' ? navigator.platform : '');
  const reportedUserAgent = userAgent ?? (typeof navigator !== 'undefined' ? navigator.userAgent : '');
  return /Mac|iPhone|iPad|iPod/i.test(reportedPlatform) || /Mac OS X/i.test(reportedUserAgent);
}

/**
 * Render the canonical shortcut syntax using the platform's familiar labels.
 * Stored bindings intentionally remain `Ctrl+...` so one shortcut works on
 * Windows/Linux and maps to Command through `matchShortcut` on macOS.
 */
export function formatShortcutLabel(shortcut: string, platform?: string, userAgent?: string): string {
  if (!isMacPlatform(platform, userAgent)) return shortcut;

  return shortcut
    .split('+')
    .map((part) => {
      const token = part.trim();
      if (token.toLowerCase() === 'ctrl' || token.toLowerCase() === 'meta') return '⌘';
      if (token.toLowerCase() === 'shift') return '⇧';
      if (token.toLowerCase() === 'alt') return '⌥';
      return token;
    })
    .join('+');
}
