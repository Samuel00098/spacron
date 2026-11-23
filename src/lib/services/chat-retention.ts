/**
 * Delete chats nobody has touched for a while (Settings > Chat > Delete old
 * chats; 30 days by default, or never).
 *
 * "Touched" is the last activity (`updatedAt`), not when the chat was made, so
 * a chat you still use never expires. Open chats, running chats and chats
 * waiting on you are always kept. Bots and their run history are not chats and
 * are never touched. Deletion is permanent.
 */
import { chatRetentionDays } from '$lib/stores/chatViewSettings';
import { get } from '$lib/stores/storeCompat';

const DAY_MS = 86_400_000;
const FIRST_RUN_DELAY_MS = 30_000;
const EVERY_MS = 6 * 60 * 60_000;

/** Whether a chat last active at `updatedAt` is old enough to delete. */
export function isStaleChat(updatedAt: number, cutoff: number): boolean {
  return Number.isFinite(updatedAt) && updatedAt > 0 && updatedAt < cutoff;
}

export function retentionCutoff(days: number, now = Date.now()): number | null {
  return days > 0 ? now - days * DAY_MS : null;
}

/** Delete expired chats now. Returns how many threads and sessions went. */
export async function runChatRetention(now = Date.now()): Promise<{ threads: number; sessions: number }> {
  const cutoff = retentionCutoff(get(chatRetentionDays), now);
  if (cutoff === null) return { threads: 0, sessions: 0 };
  // Loaded here, not at the top, so the app's startup does not depend on them.
  const [{ pruneChatThreads }, { pruneStructuredSessions }] = await Promise.all([
    import('$lib/stores/chatThreads'),
    import('$lib/services/structured-chat/session-store'),
  ]);
  return { threads: pruneChatThreads(cutoff), sessions: pruneStructuredSessions(cutoff) };
}

let started = false;

export function startChatRetention(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  const run = () => { void runChatRetention().catch((error) => console.warn('[chat-retention]', error)); };
  window.setTimeout(run, FIRST_RUN_DELAY_MS);
  window.setInterval(run, EVERY_MS);
  // Choosing a shorter period takes effect now, not at the next interval.
  chatRetentionDays.subscribe(() => { window.setTimeout(run, 1_000); });
}
