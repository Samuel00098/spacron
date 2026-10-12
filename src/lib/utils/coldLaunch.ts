/**
 * True when this page load is a fresh launch of the app, false when it is the
 * webview reloading inside a launch that is already running (dev HMR, Ctrl+R).
 *
 * sessionStorage outlives a reload but not the app process, so the marker is
 * the difference. Read once at import: StrictMode runs effects twice, and the
 * second run must not see the marker the first run just wrote.
 *
 * Only a cold launch plays the launch splash; a reload goes straight back in.
 */
const MARKER = 'spacron_launched';

function detectColdLaunch(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (window.sessionStorage.getItem(MARKER)) return false;
    window.sessionStorage.setItem(MARKER, '1');
    return true;
  } catch {
    // Storage unavailable: treat it as a fresh launch rather than resuming.
    return true;
  }
}

export const isColdLaunch = detectColdLaunch();
