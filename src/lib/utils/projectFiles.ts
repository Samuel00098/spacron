import { invoke } from '@tauri-apps/api/core';
import { isTauriRuntime } from './tauri';
import type { FileEntry } from '$lib/types/explorer';

const cache = new Map<string, { files: FileEntry[]; ts: number }>();
const TTL = 30_000;

export async function listProjectFiles(rootPath: string): Promise<FileEntry[]> {
  const key = rootPath.replace(/\\/g, '/');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < TTL) return hit.files;
  if (!isTauriRuntime()) return [];

  const all: FileEntry[] = [];
  const queue = [key];

  while (queue.length > 0) {
    const dir = queue.pop()!;
    try {
      const entries = await invoke<FileEntry[]>('fs_read_dir', { path: dir });
      for (const e of entries) {
        const entry = { ...e, path: e.path.replace(/\\/g, '/') };
        if (entry.is_dir) queue.push(entry.path);
        all.push(entry);
      }
    } catch {
      /* skip unreadable */
    }
  }

  cache.set(key, { files: all, ts: Date.now() });
  return all;
}
