import { invoke } from '@tauri-apps/api/core';
import { persisted } from '$lib/stores/chatViewSettings';
import { isTauriRuntime } from '$lib/utils/tauri';
import { get } from '$lib/stores/storeCompat';
import { remoteTarget } from '$lib/stores/remoteWorkspace';

/**
 * What the user wrote about themselves (Settings > Bots > About you), so bots,
 * agents and the in-app assistant know who they are working for: their name,
 * role, how they like answers, what they are building. Written by the user, never
 * learned; the assistant's learned profile (evolve.ts) is separate and sits beside it.
 *
 * Kept on this computer. Bots get it with each run (a bot on a box too); agents
 * Spacron launches here get a file path in `$SPACRON_ABOUT_YOU_FILE` and read it
 * (rule 9 of the standing brief). It is never written into a project's files.
 */
export const ABOUT_YOU_MAX = 2000;

export const aboutYou = persisted<string>('spacron_about_you_v1', '', (raw) =>
  typeof raw === 'string' ? raw.slice(0, ABOUT_YOU_MAX) : '');

/**
 * Where the text is saved for agents (`commands/about_you.rs`), or null when the
 * user wrote nothing or there is no backend. Kept in step with `aboutYou`.
 */
let aboutYouFile: string | null = null;

if (isTauriRuntime()) {
  aboutYou.subscribe((text) => {
    void invoke<string | null>('about_you_sync', { text })
      .then((path) => { aboutYouFile = path ?? null; })
      .catch(() => { aboutYouFile = null; });
  });
}

/**
 * The environment that points an agent at the file. Its standing brief tells it
 * to read the file when the variable is set. Empty on a remote box, where the
 * agent runs on another machine and the path would not exist.
 */
export function aboutYouEnv(): Record<string, string> {
  return !get(remoteTarget) && aboutYouFile ? { SPACRON_ABOUT_YOU_FILE: aboutYouFile } : {};
}

/** The text as it is handed to a model, or '' when the user wrote nothing. */
export function aboutYouContext(text: string): string {
  const clean = text.trim().slice(0, ABOUT_YOU_MAX);
  if (!clean) return '';
  return `About the user, in their own words (use it to work well with them; do not repeat it back unless asked):\n${clean}`;
}
