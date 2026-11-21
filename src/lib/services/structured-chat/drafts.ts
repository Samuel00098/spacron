/**
 * The unsent message a chat pane keeps across a reload or a reconnect.
 *
 * Orca keeps draft text *and* attachments with the pane; a structured chat has
 * no PTY to hold them, so they live here. Attachments are stored as paths (the
 * scratch file and the picked file both survive a reload); previews are not
 * stored, because a data URL of a few MB does not belong in localStorage.
 */

export interface DraftAttachment {
  path: string;
  name: string;
}

export interface ChatDraft {
  text: string;
  attachments: DraftAttachment[];
}

/** Bounded so a pasted wall of text or a long list cannot fill the quota. */
const MAX_TEXT = 60_000;
const MAX_ATTACHMENTS = 12;

export function chatDraftKey(sessionId: number): string {
  return `spacron_chat_draft_${sessionId}`;
}

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** Trim a draft to what is worth keeping; null when there is nothing to keep. */
export function normalizeDraft(draft: ChatDraft): ChatDraft | null {
  const text = draft.text.slice(0, MAX_TEXT);
  const attachments = draft.attachments
    .filter((attachment) => attachment.path && attachment.name)
    .slice(0, MAX_ATTACHMENTS)
    .map((attachment) => ({ path: attachment.path, name: attachment.name }));
  if (!text.trim() && !attachments.length) return null;
  return { text, attachments };
}

export function readChatDraft(sessionId: number): ChatDraft | null {
  try {
    const raw = storage()?.getItem(chatDraftKey(sessionId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ChatDraft>;
    if (typeof parsed?.text !== 'string' || !Array.isArray(parsed.attachments)) return null;
    return normalizeDraft({ text: parsed.text, attachments: parsed.attachments as DraftAttachment[] });
  } catch {
    return null;
  }
}

/** Save, or remove the key when the draft is empty (the pane's usual state). */
export function writeChatDraft(sessionId: number, draft: ChatDraft): void {
  const store = storage();
  if (!store) return;
  const keep = normalizeDraft(draft);
  try {
    if (keep) store.setItem(chatDraftKey(sessionId), JSON.stringify(keep));
    else store.removeItem(chatDraftKey(sessionId));
  } catch {
    // Full or restricted storage: the draft simply does not outlive the pane.
  }
}

export function clearChatDraft(sessionId: number): void {
  try {
    storage()?.removeItem(chatDraftKey(sessionId));
  } catch {
    // Nothing saved.
  }
}
