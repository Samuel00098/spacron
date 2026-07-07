import { invoke } from '@tauri-apps/api/core';
import { get } from '$lib/stores/storeCompat';
import { remoteTarget } from '$lib/stores/remoteWorkspace';
import { backendInvokeRemote } from './pty-bridge-remote';

// The BackendClient seam (Step 2 of docs/remote-workspace.md). Request/response
// commands go through here instead of calling Tauri `invoke` directly, so that
// when a remote workspace is active they route to `spacron-server` over the same
// WebSocket the terminals use. When no remote is set this is a transparent
// pass-through to Tauri `invoke` — identical behavior, so local mode and tests
// are unaffected.
//
// Only use this for commands whose work belongs to the *workspace* (file ops,
// git, search) — the things that move when the workspace moves. OS/UI-local and
// app-data commands (notifications, theme, notes/snippets in the local config
// dir) should keep calling Tauri `invoke` directly.
export function backendInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return get(remoteTarget) ? backendInvokeRemote<T>(cmd, args ?? {}) : invoke<T>(cmd, args);
}
