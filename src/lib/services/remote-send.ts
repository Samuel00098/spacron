import { invoke } from '@tauri-apps/api/core';
import { backendInvoke } from '$lib/services/backend';

/** Raw bytes per upload chunk (about 2.7 MB once base64-encoded). */
const CHUNK = 2 * 1024 * 1024;

export interface SendResult {
  /** The project's folder on the box. */
  path: string;
  /** Uncommitted files left behind on this computer. */
  uncommitted: number;
}

interface SendBundle {
  bundlePath: string;
  size: number;
  originUrl: string | null;
  branch: string | null;
  uncommitted: number;
}

/**
 * Copy a local git project to the connected box: pack its whole history into a
 * bundle here (`project_send_prepare`), upload it in chunks, and clone it into
 * `<box folder>/<name>` there with its real `origin` and current branch.
 * Unpushed commits come along; uncommitted changes do not (they are counted so
 * the caller can say so).
 */
export async function sendProjectToBox(
  localRoot: string,
  name: string,
  onProgress?: (sent: number, total: number) => void,
): Promise<SendResult> {
  const bundle = await invoke<SendBundle>('project_send_prepare', { root: localRoot });
  const uploadId = crypto.randomUUID();
  try {
    for (let offset = 0; offset < bundle.size; offset += CHUNK) {
      const data = await invoke<string>('project_send_read_chunk', { path: bundle.bundlePath, offset, length: CHUNK });
      await backendInvoke('remote_upload_chunk', { uploadId, offset, data });
      onProgress?.(Math.min(offset + CHUNK, bundle.size), bundle.size);
    }
    const cloned = await backendInvoke<{ path: string }>('remote_clone_repo', {
      uploadId,
      name,
      originUrl: bundle.originUrl,
      branch: bundle.branch,
    });
    return { path: cloned.path, uncommitted: bundle.uncommitted };
  } finally {
    void invoke('project_send_cleanup', { path: bundle.bundlePath }).catch(() => {});
  }
}

/** A folder name the box accepts, derived from a local folder's name. */
export function boxFolderName(localRoot: string): string {
  const base = localRoot.split(/[\\/]/).filter(Boolean).pop() ?? 'project';
  const safe = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+/, '').slice(0, 100);
  return safe || 'project';
}
