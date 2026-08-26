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
  if (!get(remoteTarget)) return invoke<T>(cmd, args);
  return backendInvokeRemote<T>(cmd, args ?? {}).catch((err: unknown) => {
    // A command routed here that the server has no arm for comes back as
    // `unsupported remote command: <name>`. That string is the signature of a
    // *routing* mistake, not a runtime failure: something app-local was sent to
    // the box. It is worth shouting about because the callers of this function
    // overwhelmingly catch-and-log, so the mistake otherwise presents as a
    // feature quietly doing nothing — which is exactly how the whole
    // orchestrator came up empty against a remote for as long as
    // `project_state_*` was routed through here.
    //
    // Still rethrown: the caller's own handling is unchanged, this only makes
    // sure the reason is visible rather than swallowed into a generic log line.
    if (String((err as { message?: string })?.message ?? err).includes('unsupported remote command')) {
      console.error(
        `[backend] "${cmd}" was routed to the remote workspace, which has no handler for it. ` +
          `If this command is app-local (app data, OS/UI state), it must call Tauri \`invoke\` ` +
          `directly instead of \`backendInvoke\`. If it is workspace work, add it to ` +
          `\`dispatch_invoke\` in src-tauri/src/remote/mod.rs.`,
      );
    }
    throw err;
  });
}
