import { get, writable } from '$lib/stores/storeCompat';
import { loadJson } from '$lib/utils/storage';

const STORAGE_KEY = 'spacron_chat_direct_mode';

/**
 * Chat mode talks to one agent directly.
 *
 * T3's model, and what Chat is: the user's message is the agent's prompt and
 * the agent's own streamed answer is the reply. When this is on, a Chat turn
 * never falls through to the orchestrator — no brain, no routing, no
 * "handing this to…" narration. Media is the one exception: `/image` and
 * `/video` call the configured provider API directly, because that is an API
 * call and not a model turn.
 *
 * Turning it off restores the old orchestrator-in-chat behaviour (the brain may
 * answer, plan and dispatch) and exists for the CLI-mode parity path and for
 * tests that still cover the brain's chat routing.
 */
export const chatDirectAgentMode = writable<boolean>(loadJson<boolean>(STORAGE_KEY, true) !== false);

chatDirectAgentMode.subscribe((enabled) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(enabled));
  } catch {}
});

export function isChatDirectMode(): boolean {
  return get(chatDirectAgentMode);
}
