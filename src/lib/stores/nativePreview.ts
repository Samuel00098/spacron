import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { writable, get } from '$lib/stores/storeCompat';
import { pushConsoleLog } from './previewConsole';

export const nativePreviewActive = writable(false);
export const nativePreviewUrl = writable('');

let initPromise: Promise<void> | null = null;

/**
 * Register the native-preview event listeners. Returns a promise that resolves
 * once both are actually registered — callers must await it before creating the
 * webview, otherwise the first console lines and the initial navigation event
 * fire before Tauri has the handlers and are lost.
 */
export function initNativePreviewListeners(): Promise<void> {
  if (initPromise) return initPromise;

  initPromise = Promise.all([
    listen<{ level: string; message: string }>('native-preview:console', (event) => {
      const { level, message } = event.payload;
      pushConsoleLog({
        level: (['log', 'info', 'warn', 'error', 'debug'].includes(level) ? level : 'log') as 'log',
        message,
        timestamp: new Date().toISOString(),
      });
    }),
    listen<string>('native-preview:navigation', (event) => {
      nativePreviewUrl.set(event.payload);
    }),
  ]).then(() => undefined);

  return initPromise;
}

export async function activateNativePreview(
  url: string,
  contentEl: HTMLElement,
): Promise<void> {
  await initNativePreviewListeners();

  await invoke('native_preview_create', { url, ...logicalBounds(contentEl) });

  nativePreviewUrl.set(url);
  nativePreviewActive.set(true);
}

/**
 * Bounds for the native child webview, in LOGICAL (CSS) pixels.
 *
 * `getBoundingClientRect()` is already in CSS pixels and the Rust side builds a
 * `LogicalPosition`/`LogicalSize`, which Tauri scales by the monitor factor
 * itself. Multiplying by `devicePixelRatio` here applied the scale factor twice,
 * so on any display above 100% the webview was oversized and offset. Only
 * correct at exactly 100% DPI, which is why it went unnoticed.
 */
function logicalBounds(el: HTMLElement): { x: number; y: number; width: number; height: number } {
  const rect = el.getBoundingClientRect();
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

/**
 * Leave native mode and remove the child webview.
 *
 * This closes rather than hides. The native webview is an OS-level overlay
 * painted on top of the panel, so if teardown fails the user keeps staring at
 * the native page while the app has already flipped back to iframe mode — the
 * toggle looks dead in the other direction. `hide` also bought nothing:
 * `native_preview_create` destroys and recreates the webview on every
 * activation, so no page state survived a toggle round-trip anyway.
 */
export async function deactivateNativePreview(): Promise<void> {
  try {
    await invoke('native_preview_close');
  } finally {
    // Always leave native mode in the store, even if the backend call failed —
    // otherwise the UI would be stuck in a mode it can't exit.
    nativePreviewActive.set(false);
  }
}

export async function destroyNativePreview(): Promise<void> {
  try {
    await invoke('native_preview_close');
  } catch {
    // Already closed
  }
  nativePreviewActive.set(false);
  nativePreviewUrl.set('');
}

export async function syncNativePreviewBounds(contentEl: HTMLElement): Promise<void> {
  if (!get(nativePreviewActive)) return;
  try {
    await invoke('native_preview_set_bounds', logicalBounds(contentEl));
  } catch {
    // Webview may have been closed
  }
}

export async function navigateNativePreview(url: string): Promise<void> {
  await invoke('native_preview_navigate', { url });
  nativePreviewUrl.set(url);
}

export async function nativePreviewEval(script: string): Promise<void> {
  await invoke('native_preview_eval', { script });
}

export async function showNativePreview(): Promise<void> {
  await invoke('native_preview_show');
  nativePreviewActive.set(true);
}
