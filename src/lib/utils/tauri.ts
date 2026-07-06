export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

// True on the Linux desktop webview (WebKitGTK). Its CSS View Transitions
// implementation is unreliable and regularly leaves elements that carry a
// `view-transition-name` (e.g. the room dock) stuck hidden after a transition —
// which is what made the dock and floating bar vanish on layout/agent changes.
// Callers use this to fall back to an instant DOM update on Linux while keeping
// the animated transitions on Windows (WebView2) and macOS (WKWebView).
export function isWebkitGtk(): boolean {
  return typeof navigator !== 'undefined' &&
    typeof navigator.userAgent === 'string' &&
    navigator.userAgent.includes('Linux') &&
    !navigator.userAgent.includes('Android');
}

// Whether to use `document.startViewTransition` at all. Off on WebKitGTK.
export function viewTransitionsReliable(): boolean {
  return !isWebkitGtk();
}
