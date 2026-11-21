/**
 * Image attachments for structured chats.
 *
 * The composer hands a provider the *paths* of attached images (the file the
 * user picked, or the scratch copy `save_pasted_image` wrote). Codex takes a
 * path (`localImage`), but ACP's `session/prompt` and Claude's stream-json take
 * the bytes inline as base64. Both read the file through `chat_image_preview`
 * (the same image-only, size-capped reader the composer's thumbnails use), so
 * what the model receives is exactly what the chip showed.
 */
import { invoke } from '@tauri-apps/api/core';

const DATA_URL = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i;

/** One image the provider receives inline. */
export interface InlineImage {
  mimeType: string;
  data: string;
}

/** Decode an `image/*` data URL into its media type and base64 bytes, or null. */
export function parseImageDataUrl(url: string): InlineImage | null {
  const match = DATA_URL.exec(url.trim());
  if (!match) return null;
  const data = match[2].replace(/\s+/g, '');
  return data ? { mimeType: match[1].toLowerCase(), data } : null;
}

/**
 * One attached image as a data URL. An already-inline image passes through; a
 * path is read by the backend, which refuses anything that is not a readable
 * image under its size cap, and then this is null (never a half attachment).
 */
export async function imageDataUrlFor(path: string): Promise<string | null> {
  if (path.startsWith('data:')) return parseImageDataUrl(path) ? path : null;
  try {
    return await invoke<string>('chat_image_preview', { path });
  } catch {
    return null;
  }
}

/** Every attachment that can really be inlined, in the order they were added. */
export async function imageDataUrlsFor(paths: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const path of paths) {
    const url = await imageDataUrlFor(path);
    if (url) out.push(url);
  }
  return out;
}

/** The ACP `image` content blocks for those data URLs. */
export function acpImageBlocks(dataUrls: readonly string[]): InlineImage[] {
  return dataUrls
    .map(parseImageDataUrl)
    .filter((image): image is InlineImage => image !== null);
}

/**
 * Paths from a drop: one per line, trimmed, with the quotes a file manager or
 * the explorer adds around paths that contain spaces.
 */
export function parseDroppedPaths(text: string): string[] {
  const out: string[] = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const value = raw.trim().replace(/^"(.*)"$/, '$1').trim();
    if (value && !out.includes(value)) out.push(value);
  }
  return out;
}
