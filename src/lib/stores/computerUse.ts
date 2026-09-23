/**
 * Computer use (docs/computer-use.md): the frontend half of the permission
 * model. Rust owns the tools, the grants and the never-targetable rules; this
 * module only
 *
 *   1. pushes the user's `Allow computer use` switch to the MCP server, and
 *   2. queues the server's "may this agent see …?" requests for the dialog
 *      (`DesktopGrantHost`) and sends back the answer.
 *
 * The agent's tool call is blocked on that answer, so every request must end in
 * a response — even when the dialog is dismissed — or it would sit until the
 * server's two-minute timeout.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { writable } from './storeCompat';
import { computerUse } from './settings';
import { playNudge } from '$lib/services/nudge';

/** Mirrors `desktop::GrantRequest` in Rust (camelCase over the wire). */
export interface DesktopGrantRequest {
  requestId: string;
  sessionId: number;
  agentName: string | null;
  kind: 'window_list' | 'window';
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
  computerUse.subscribe((on) => {
    invoke('mcp_set_computer_use', { enabled: on === true }).catch((e) => {
      console.error('[computer-use] Failed to publish the setting to the MCP server:', e);
    });
    // Rust declines every open request when the switch goes off; drop the
    // cards too so the dialog does not ask about something already refused.
    if (on !== true) desktopGrantQueue.set([]);
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
