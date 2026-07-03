// Clipboard helpers that work in every webview. navigator.clipboard is
// permission-gated in WebKitGTK (Linux): reads are denied outright and writes
// need a transient user activation that right-click handlers don't get, so
// copy/paste silently failed there while working fine on Windows and macOS.
// Route everything through the Tauri clipboard plugin (native, no web
// permission involved) and keep navigator.clipboard as the fallback for
// plain-browser dev sessions.
import { readImage, readText, writeImage, writeText } from '@tauri-apps/plugin-clipboard-manager';
import { isTauriRuntime } from '$lib/utils/tauri';

export async function copyTextToClipboard(text: string): Promise<void> {
  if (isTauriRuntime()) {
    await writeText(text);
    return;
  }
  await navigator.clipboard.writeText(text);
}

export async function copyPngToClipboard(pngBytes: number[] | Uint8Array): Promise<void> {
  if (isTauriRuntime()) {
    await writeImage(pngBytes);
    return;
  }
  const blob = new Blob([new Uint8Array(pngBytes)], { type: 'image/png' });
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
}

// Read a bitmap image off the system clipboard as raw RGBA. On WebKitGTK (Linux)
// the webview never surfaces clipboard images through the DOM `paste` event's
// dataTransfer, so pasting a screenshot silently did nothing; the native plugin
// is the only way to reach it. Returns null when the clipboard holds no image
// (the plugin rejects in that case) or outside a Tauri runtime.
export async function readImageFromClipboard(): Promise<{ bytes: Uint8Array; width: number; height: number } | null> {
  if (!isTauriRuntime()) return null;
  try {
    const image = await readImage();
    if (!image) return null;
    const rgba = await image.rgba();
    const { width, height } = await image.size();
    if (!width || !height || rgba.length < 4) return null;
    return { bytes: rgba instanceof Uint8Array ? rgba : new Uint8Array(rgba), width, height };
  } catch {
    return null;
  }
}

export async function readTextFromClipboard(): Promise<string> {
  if (isTauriRuntime()) {
    // The plugin rejects when the clipboard holds no text; treat that as empty
    // rather than an error so paste handlers can no-op.
    return (await readText().catch(() => '')) ?? '';
  }
  return navigator.clipboard.readText();
}
