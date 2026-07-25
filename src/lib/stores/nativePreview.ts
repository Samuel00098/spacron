import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { writable, get } from '$lib/stores/storeCompat';
import { pushConsoleLog } from './previewConsole';

export const nativePreviewActive = writable(false);
export const nativePreviewUrl = writable('');

let initialized = false;

export function initNativePreviewListeners(): void {
  if (initialized) return;
  initialized = true;

  listen<{ level: string; message: string }>('native-preview:console', (event) => {
    const { level, message } = event.payload;
    pushConsoleLog({
      level: (['log', 'info', 'warn', 'error', 'debug'].includes(level) ? level : 'log') as 'log',
      message,
      timestamp: new Date().toISOString(),
    });
  });

  listen<string>('native-preview:navigation', (event) => {
    nativePreviewUrl.set(event.payload);
  });
}

export async function activateNativePreview(
  url: string,
  contentEl: HTMLElement,
): Promise<void> {
  initNativePreviewListeners();

  const rect = contentEl.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;

  await invoke('native_preview_create', {
    url,
    x: rect.x * scale,
    y: rect.y * scale,
    width: rect.width * scale,
    height: rect.height * scale,
  });

  nativePreviewUrl.set(url);
  nativePreviewActive.set(true);
}

export async function deactivateNativePreview(): Promise<void> {
  try {
    await invoke('native_preview_hide');
  } catch {
    // Webview may already be closed
  }
  nativePreviewActive.set(false);
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
  const rect = contentEl.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  try {
    await invoke('native_preview_set_bounds', {
      x: rect.x * scale,
      y: rect.y * scale,
      width: rect.width * scale,
      height: rect.height * scale,
    });
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
