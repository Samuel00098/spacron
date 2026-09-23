/**
 * Computer use (docs/computer-use.md): the frontend half of the permission
 * model. Rust owns the tools, the grants, the lease and the never-targetable
 * rules; this module only
 *
 *   1. pushes the user's `Allow computer use` switch and blocked-apps list to
 *      the MCP server,
 *   2. queues the server's "may this agent see / control …?" requests for the
 *      dialog (`DesktopGrantHost`) and sends back the answer,
 *   3. turns the server's notices (e.g. "stopped by the shortcut") into toasts,
 *   4. reads grants and recent activity for Settings.
 *
 * The agent's tool call is blocked on that answer, so every request must end in
 * a response — even when the dialog is dismissed — or it would sit until the
 * server's two-minute timeout.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { get, writable } from './storeCompat';
import { computerUse, computerUseBlockedApps } from './settings';
import { playNudge } from '$lib/services/nudge';
import { showToast } from './notification';
import { setDesktopToolsAvailable } from '$lib/services/orchestrator/brain-tools';

/** Mirrors `desktop::GrantRequest` in Rust (camelCase over the wire). */
export interface DesktopGrantRequest {
  requestId: string;
  /** Set when a CLI agent asks. */
  sessionId: number | null;
  /** Set when the in-app chat asks; its grants end with the turn. */
  chatId: string | null;
  agentName: string | null;
  kind: 'window_list' | 'window' | 'control';
  windowTitle: string | null;
  process: string | null;
  /** The agent's own words. Untrusted: render as quoted text, never markup. */
  reason: string;
}

/** Oldest first. The dialog shows the head. */
export const desktopGrantQueue = writable<DesktopGrantRequest[]>([]);

let initialized = false;

export function initComputerUse(): void {
  if (initialized) return;
  initialized = true;

  // Fires immediately on subscribe, so this is also the startup push: the
  // server boots with the switch off and learns the saved value here.
  // The chat's tools follow the same switch, and only where the platform can
  // actually do it; until that is known they stay off.
  let supported = false;
  void computerUseSupported().then((ok) => {
    supported = ok;
    setDesktopToolsAvailable(ok && get(computerUse) === true);
  });

  computerUse.subscribe((on) => {
    invoke('mcp_set_computer_use', { enabled: on === true }).catch((e) => {
      console.error('[computer-use] Failed to publish the setting to the MCP server:', e);
    });
    setDesktopToolsAvailable(supported && on === true);
    // Rust declines every open request when the switch goes off; drop the
    // cards too so the dialog does not ask about something already refused.
    if (on !== true) desktopGrantQueue.set([]);
  });

  computerUseBlockedApps.subscribe((apps) => {
    invoke('mcp_desktop_set_blocked_apps', { apps: Array.isArray(apps) ? apps : [] }).catch((e) => {
      console.error('[computer-use] Failed to publish blocked apps:', e);
    });
  });

  // "Stopped by the shortcut", "the shortcut could not be registered", …
  listen<string>('mcp:desktop-notice', (event) => {
    showToast(event.payload, 'info', 6000);
  }).catch((e) => {
    console.error('[computer-use] Failed to listen for notices:', e);
  });

  listen<DesktopGrantRequest>('mcp:desktop-grant-request', (event) => {
    desktopGrantQueue.update((queue) => [...queue, event.payload]);
    // The agent is waiting on the user; the same soft cue as any other
    // "needs you" moment rather than anything louder.
    playNudge('blocked');
  }).catch((e) => {
    console.error('[computer-use] Failed to listen for grant requests:', e);
  });
}

/** Answer one request and take it off the queue. */
export function answerDesktopGrant(requestId: string, allow: boolean): void {
  desktopGrantQueue.update((queue) => queue.filter((r) => r.requestId !== requestId));
  invoke('mcp_desktop_grant_respond', { requestId, allow }).catch((e) => {
    console.error('[computer-use] Failed to answer a grant request:', e);
  });
}

/** Whether this platform can do computer use at all (Windows only for now). */
export async function computerUseSupported(): Promise<boolean> {
  try {
    return (await invoke<boolean>('mcp_computer_use_supported')) === true;
  } catch {
    return false;
  }
}

export interface DesktopGrant {
  /** Opaque; pass to `revokeDesktopGrant`. */
  caller: string;
  agent: string;
  kind: 'window_list' | 'window' | 'control';
  target: string;
}

export interface DesktopActivityEntry {
  atMs: number;
  agent: string;
  tool: string;
  window: string;
  process: string;
  detail: string;
  ok: boolean;
}

export async function fetchDesktopGrants(): Promise<DesktopGrant[]> {
  try {
    return await invoke<DesktopGrant[]>('mcp_desktop_grants');
  } catch {
    return [];
  }
}

export async function revokeDesktopGrant(caller: string): Promise<void> {
  await invoke('mcp_desktop_revoke', { caller }).catch((e) => {
    console.error('[computer-use] Failed to revoke:', e);
  });
}

export async function fetchDesktopActivity(): Promise<{ entries: DesktopActivityEntry[]; logPath: string | null }> {
  try {
    return await invoke('mcp_desktop_activity');
  } catch {
    return { entries: [], logPath: null };
  }
}
