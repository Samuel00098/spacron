import { persisted } from '$lib/stores/chatViewSettings';
import type { BotRun } from './bots';

/**
 * How much a single bot may interrupt you. Kept per bot: a bot that runs every
 * hour wants "problems only", while one you only chat with wants everything.
 *
 * `all` announces finished, failed and missed runs; `problems` only failed and
 * missed ones; `off` nothing. Bots without a saved choice use `all`, which is
 * what every bot did before this setting existed.
 */
export type BotNotifyMode = 'all' | 'problems' | 'off';

export const BOT_NOTIFY_MODES: { value: BotNotifyMode; label: string; detail: string }[] = [
  { value: 'all', label: 'Every run', detail: 'Tell me when a run finishes, fails or is missed.' },
  { value: 'problems', label: 'Only problems', detail: 'Stay quiet unless a run fails or is missed.' },
  { value: 'off', label: 'Never', detail: 'No notices for this bot. Its runs are still listed in Bots.' },
];

export const botNotifyModes = persisted<Record<string, BotNotifyMode>>('spacron_bot_notify_v1', {}, (raw) => {
  const out: Record<string, BotNotifyMode> = {};
  if (raw && typeof raw === 'object') {
    for (const [id, mode] of Object.entries(raw)) if (mode === 'problems' || mode === 'off') out[id] = mode;
  }
  return out;
});

export function setBotNotifyMode(botId: string, mode: BotNotifyMode) {
  botNotifyModes.update((all) => {
    const next = { ...all };
    if (mode === 'all') delete next[botId]; else next[botId] = mode;
    return next;
  });
}

/**
 * Whether a run's outcome should be announced.
 *
 * `watching` is true when the user is looking at that bot's chat right now with
 * the app focused. A reply to a message they just sent is already on screen, so
 * announcing it would be a toast and a system notification for something they
 * are reading. Failures still announce: those do not show up as a reply.
 */
export function shouldAnnounce(
  mode: BotNotifyMode,
  run: Pick<BotRun, 'status' | 'trigger'>,
  watching: boolean,
): boolean {
  if (mode === 'off') return false;
  const problem = run.status === 'failed' || run.status === 'missed';
  if (mode === 'problems') return problem;
  if (watching && run.trigger === 'chat' && !problem) return false;
  return true;
}

/** A reply flattened to one short line for a notice, or '' when there is none. */
export function replyPreview(reply: string | undefined, max = 140): string {
  const flat = (reply ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*_`~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1).trimEnd()}…`;
}
