import { getCurrentWindow } from '@tauri-apps/api/window';

export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

// Wry reports drop coordinates relative to the webview. WebView2 uses
// physical pixels, while WKWebView and WebKitGTK report logical coordinates.
export async function dropPositionToCss(pos: { x: number; y: number }): Promise<{ x: number; y: number } | null> {
  if (!isTauriRuntime()) return null;
  if (!/Windows/i.test(navigator.userAgent)) return pos;
  try {
    const scale = await getCurrentWindow().scaleFactor();
    return { x: pos.x / scale, y: pos.y / scale };
  } catch {
    return null;
  }
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

/**
 * Resizes and positions the window relative to the current display work area.
 * Default is 65% width and 85% height, positioned on the left side of the screen.
 */
export async function restoreWindowToRelativeSize(
  widthPercent = 0.65,
  heightPercent = 0.85
): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    const { getCurrentWindow, currentMonitor, primaryMonitor, LogicalSize, LogicalPosition } = await import(
      '@tauri-apps/api/window'
    );
    const win = getCurrentWindow();
    const monitor = (await currentMonitor()) ?? (await primaryMonitor());
    if (!monitor) return;

    const scaleFactor = monitor.scaleFactor || 1;
    const workArea = monitor.workArea || monitor;

    const screenWidth = workArea.size.width / scaleFactor;
    const screenHeight = workArea.size.height / scaleFactor;
    const screenX = (workArea.position?.x ?? 0) / scaleFactor;
    const screenY = (workArea.position?.y ?? 0) / scaleFactor;

    const targetWidth = Math.round(screenWidth * widthPercent);
    const targetHeight = Math.round(screenHeight * heightPercent);

    const targetX = Math.round(screenX + (screenWidth - targetWidth) / 2);
    const targetY = Math.round(screenY + (screenHeight - targetHeight) / 2);

    if (await win.isMaximized()) {
      await win.unmaximize();
    }

    await win.setSize(new LogicalSize(targetWidth, targetHeight));
    await win.setPosition(new LogicalPosition(targetX, targetY));
  } catch (err) {
    console.error('Failed to restore window to relative size:', err);
  }
}

/**
 * Repairs a window that was restored with an invalid native geometry.
 *
 * Tauri normally creates the main window at the dimensions in tauri.conf.json,
 * but Windows can occasionally hand a restarted dev window back as a tiny
 * 0x0/14x14 surface. It is technically visible, yet impossible for a user to
 * find or interact with. Do not overwrite normal user sizing; only recover
 * sizes that are well below the app's configured minimum.
 */
export async function ensureWindowUsable(): Promise<void> {
  if (!isTauriRuntime()) return;

  try {
    const win = getCurrentWindow();
    const [size, scaleFactor] = await Promise.all([win.innerSize(), win.scaleFactor()]);
    const logicalWidth = size.width / (scaleFactor || 1);
    const logicalHeight = size.height / (scaleFactor || 1);

    if (logicalWidth >= 640 && logicalHeight >= 480) return;

    await restoreWindowToRelativeSize();
    await win.show();
    await win.unminimize();
    await win.setFocus();
  } catch (err) {
    // Window recovery must never prevent the rest of the application from
    // starting if the native window API is temporarily unavailable.
    console.error('Failed to ensure a usable application window:', err);
  }
}

