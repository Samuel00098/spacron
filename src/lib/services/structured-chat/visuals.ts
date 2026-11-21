/**
 * Inline visuals (`::spacron-visual{file="…"}`) for structured chats.
 *
 * A terminal-backed agent gets `$SPACRON_CHAT_VISUALS_DIR` from the launcher
 * that starts its PTY. A structured chat starts no PTY, so it asks the same
 * backend for a folder (`commands/chat_visuals.rs`) and passes the variable to
 * the agent's own process; the reply is then rendered with `ChatVisual`.
 *
 * The spot is recorded per pane through the terminal store's map, so a pane
 * switched from a CLI into chat keeps the folder the CLI already had.
 */
import { invoke } from '@tauri-apps/api/core';
import { getSessionVisuals, setSessionVisuals, type ChatVisualsSpot } from '$lib/stores/terminal';

/** The visuals folder this chat's agent was started with, if any. */
export function structuredVisualsSpot(sessionId: number): ChatVisualsSpot | null {
  return getSessionVisuals(sessionId);
}

/**
 * The env a structured agent needs to write visuals, prepared once per pane.
 * Best effort: a chat still starts without it, and a reply that references a
 * visual then says it cannot be shown instead of showing a broken frame.
 */
export async function prepareStructuredVisuals(sessionId: number): Promise<Record<string, string>> {
  const existing = getSessionVisuals(sessionId);
  if (existing) return { SPACRON_CHAT_VISUALS_DIR: existing.dir };
  try {
    const spot = await invoke<ChatVisualsSpot>('chat_visuals_prepare', { key: crypto.randomUUID() });
    setSessionVisuals(sessionId, spot);
    return { SPACRON_CHAT_VISUALS_DIR: spot.dir };
  } catch {
    return {};
  }
}
