/**
 * Pure helpers for the structured chat's transcript and composer: quoting a
 * selection, the prompts Up/Down recalls, filtering the model list and the
 * key an unsent draft is kept under.
 */
import type { TerminalChatItem } from '$lib/services/terminal-chat';

/** `text` as a markdown blockquote block, ready to add to the composer. */
export function quoteAsBlockquote(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  // Drop blank edge lines but keep indentation inside the quote.
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.map((line) => `> ${line}`).join('\n');
}

/** The prompts this chat sent, oldest first, without repeats of the one before. */
export function promptHistoryOf(items: TerminalChatItem[]): string[] {
  const out: string[] = [];
  for (const item of items) {
    if (item.kind !== 'user') continue;
    const text = item.text.trim();
    if (!text || text === out[out.length - 1]) continue;
    out.push(text);
  }
  return out;
}

/** Models whose id, label or description matches `query`, in catalog order. */
export function filterModels<T extends { value: string; label: string; hint?: string }>(models: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return models;
  return models.filter((model) => `${model.value} ${model.label} ${model.hint ?? ''}`.toLowerCase().includes(q));
}

/** Where a pane's unsent draft is kept between reloads. */
export function structuredDraftKey(sessionId: number): string {
  return `spacron_structured_draft_${sessionId}`;
}

/** What to keep as the saved draft: the text, or null when nothing is worth keeping. */
export function draftToPersist(text: string): string | null {
  return text.trim() ? text : null;
}
