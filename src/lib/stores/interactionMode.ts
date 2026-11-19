import { get, writable } from '$lib/stores/storeCompat';

export type InteractionMode = 'cli' | 'chat';

const INTERACTION_MODE_KEY = 'spacron_interaction_mode';

function loadInteractionMode(): InteractionMode {
  // The app-wide Chat mode is retired: chat is now a per-terminal view
  // (`services/terminal-chat.ts`), and the title-bar switch that led here is
  // gone. A saved 'chat' would strand the user in a mode with no way out, so
  // every launch starts in 'cli' and the stale key is cleared.
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.removeItem(INTERACTION_MODE_KEY);
    } catch {
      // Restricted storage: nothing to clear.
    }
  }
  return 'cli';
}

/** The presentation mode for the main workspace. This is deliberately separate
 * from ambient layout (Focus/Split): changing how the user talks to Spacron
 * must not rewrite the user's pane arrangement. */
export const interactionMode = writable<InteractionMode>(loadInteractionMode());

export function setInteractionMode(mode: InteractionMode): void {
  // Retired: nothing may switch the workspace into the old Chat mode. Callers
  // that still ask for it (sidebar actions written for that mode) are no-ops.
  if (mode === 'chat') return;
  if (get(interactionMode) === mode) return;
  interactionMode.set(mode);
}

/**
 * Request counter for the conversational-mode voice gesture. The floating bar
 * owns the bare-Alt tap globally (it stays mounted in both modes); when that
 * gesture fires while `interactionMode === 'chat'` it increments this counter
 * instead of launching the CLI bar's own realtime call, and ChatModePanel's
 * composer consumes it. Kept here, not in the component, so the gesture owner
 * (FloatingPromptBar) and the listener (ChatModePanel) share one import.
 */
export const chatVoiceModeRequest = writable(0);
export function requestChatVoiceMode(): void {
  chatVoiceModeRequest.update((n) => n + 1);
}
