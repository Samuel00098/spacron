// Clipboard helpers that work in every webview. navigator.clipboard is
// permission-gated in WebKitGTK (Linux): reads are denied outright and writes
// need a transient user activation that right-click handlers don't get, so
// copy/paste silently failed there while working fine on Windows and macOS.
// Route everything through the Tauri clipboard plugin (native, no web
// permission involved) and keep navigator.clipboard as the fallback for
// plain-browser dev sessions.
import { readText, writeImage, writeText } from '@tauri-apps/plugin-clipboard-manager';
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

export async function readTextFromClipboard(): Promise<string> {
  if (isTauriRuntime()) {
    // The plugin rejects when the clipboard holds no text; treat that as empty
    // rather than an error so paste handlers can no-op.
    return (await readText().catch(() => '')) ?? '';
  }
  return navigator.clipboard.readText();
}
