/**
 * The earlier conversation, for an agent that did not take part in it. A side
 * chat or fork shows the copied messages on screen, but unless the provider
 * forked its own session the new agent has never seen them, so they have to
 * travel with the first prompt.
 */

const OPEN = '<spacron-side-chat-context>';
const CLOSE = '</spacron-side-chat-context>';
const BLOCK = new RegExp(`^${OPEN}[\\s\\S]*?${CLOSE}\\s*`);
const MAX_MESSAGES = 20;
const MAX_MESSAGE_CHARS = 8_000;
const MAX_TOTAL_CHARS = 48_000;

interface ContextEntry {
  role?: string;
  kind?: string;
  text?: string | null;
  pending?: boolean;
}

/** The newest user and assistant messages as one block, or null when there are none. */
export function buildSideChatContext(entries: readonly ContextEntry[]): string | null {
  const lines: string[] = [];
  let total = 0;
  for (let i = entries.length - 1; i >= 0 && lines.length < MAX_MESSAGES; i -= 1) {
    const entry = entries[i];
    const who = entry.kind ?? entry.role;
    if (entry.pending || (who !== 'user' && who !== 'assistant')) continue;
    const text = (entry.text ?? '').split(OPEN).join('').split(CLOSE).join('').trim().slice(-MAX_MESSAGE_CHARS);
    if (!text) continue;
    if (lines.length && total + text.length > MAX_TOTAL_CHARS) break;
    total += text.length;
    lines.unshift(`${who === 'user' ? 'User' : 'Assistant'}:\n${text}`);
  }
  if (!lines.length) return null;
  return `${OPEN}\nThis chat continues from the earlier conversation below. It is here for reference.\n\n${lines.join('\n\n')}\n${CLOSE}`;
}

/**
 * Chat mode: the context block for a side chat, told apart by the parent turns
 * copied into it. Null for any other thread.
 */
export function sideChatContextFor(messages: readonly (ContextEntry & { id: string })[]): string | null {
  return messages.some((message) => message.id.includes('-sidecopy-')) ? buildSideChatContext(messages) : null;
}

export function withContext(block: string | null, prompt: string): string {
  return block ? `${block}\n\n${prompt}` : prompt;
}

/** For agents that echo the prompt back: show only what the user typed. */
export function stripSideChatContext(text: string): string {
  return text.replace(BLOCK, '');
}

// Structured panes: the block waits here until the adapter has delivered it.
const pending = new Map<number, { block: string; onSent: () => void }>();

export function setPaneContext(paneId: number, block: string, onSent: () => void): void {
  pending.set(paneId, { block, onSent });
}

export function clearPaneContext(paneId: number): void {
  pending.delete(paneId);
}

/**
 * What an adapter should put on the wire. Call `sent` once the agent has
 * accepted it; until then the next prompt carries the block again. A slash
 * command is left alone, since a prefix would stop the CLI reading it.
 */
export function paneWireText(paneId: number, text: string): { text: string; sent: () => void } {
  const waiting = pending.get(paneId);
  if (!waiting || text.startsWith('/')) return { text, sent: () => {} };
  return {
    text: text.trim() ? withContext(waiting.block, text) : waiting.block,
    sent: () => {
      if (pending.get(paneId) !== waiting) return;
      pending.delete(paneId);
      waiting.onSent();
    },
  };
}
