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
