import { get, writable } from '$lib/stores/storeCompat';

export type InteractionMode = 'cli' | 'chat';

const INTERACTION_MODE_KEY = 'spacron_interaction_mode';

function loadInteractionMode(): InteractionMode {
  if (typeof window === 'undefined') return 'cli';
  try {
    return window.localStorage.getItem(INTERACTION_MODE_KEY) === 'chat' ? 'chat' : 'cli';
  } catch {
    return 'cli';
  }
}

/** The presentation mode for the main workspace. This is deliberately separate
 * from ambient layout (Focus/Split): changing how the user talks to Spacron
 * must not rewrite the user's pane arrangement. */
export const interactionMode = writable<InteractionMode>(loadInteractionMode());

interactionMode.subscribe((mode) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(INTERACTION_MODE_KEY, mode);
  } catch {
    // Storage can be unavailable in a restricted WebView; the live toggle
    // remains useful for the current session.
  }
});

export function setInteractionMode(mode: InteractionMode): void {
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
