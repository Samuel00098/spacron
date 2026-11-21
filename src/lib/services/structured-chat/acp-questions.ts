/**
 * Questions that ACP agents send as their own extension requests instead of a
 * permission request:
 *
 * - Grok: `_x.ai/ask_user_question`. Shape and answer VERIFIED LIVE against
 *   grok 1.0.77 (2026-11-21): reply `{ outcome: 'accepted', answers: { <question
 *   text>: <label> } }` and the model reads the choice; `{ outcome: 'skip' }`
 *   is accepted and the model asks in text instead.
 * - Cursor: `cursor/ask_question`. Read from cursor-agent 2026.11.19's source,
 *   NOT run (the account was out of plan): params `{ toolCallId, title,
 *   questions: [{ id, prompt, options: [{ id, label }], allowMultiple }] }`,
 *   reply `{ outcome: { outcome: 'answered', answers: [{ questionId,
 *   selectedOptionIds }] } }` or `{ outcome: { outcome: 'skipped', reason } }`.
 *
 * Antigravity and OpenCode send no request at all: Antigravity prints the
 * question and ends the turn, and OpenCode says its question tool "couldn't
 * display here" and asks in text, so you answer with an ordinary message.
 */
export type AcpAskKind = 'grok' | 'cursor';

export interface AcpAskQuestion {
  /** Grok keys answers by question text; Cursor by the question's own id. */
  key: string;
  header: string | null;
  text: string;
  multiple: boolean;
  options: { id: string; label: string; description: string | null }[];
}

export const GROK_ASK_METHOD = '_x.ai/ask_user_question';
export const CURSOR_ASK_METHOD = 'cursor/ask_question';

export function askKindFor(method: string): AcpAskKind | null {
  if (method === GROK_ASK_METHOD) return 'grok';
  if (method === CURSOR_ASK_METHOD) return 'cursor';
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** Null when any question has no options: it can't be answered from buttons. */
export function parseAcpQuestions(kind: AcpAskKind, params: unknown): { title: string | null; questions: AcpAskQuestion[] } | null {
  const p = asRecord(params);
  const raw = p?.questions;
  if (!Array.isArray(raw) || !raw.length) return null;
  const questions: AcpAskQuestion[] = [];
  for (const entry of raw) {
    const q = asRecord(entry);
    if (!q) return null;
    const prompt = text(kind === 'cursor' ? q.prompt : q.question);
    const options = (Array.isArray(q.options) ? q.options : []).flatMap((option, index) => {
      const o = asRecord(option);
      const label = text(o?.label);
      if (!label) return [];
      return [{ id: kind === 'cursor' ? text(o?.id) : String(index), label, description: text(o?.description) || null }];
    });
    if (!prompt || !options.length || options.some((o) => !o.id)) return null;
    const key = kind === 'cursor' ? text(q.id) : prompt;
    if (!key) return null;
    questions.push({
      key,
      header: text(q.header) || null,
      text: prompt,
      multiple: kind === 'cursor' ? q.allowMultiple === true : q.multiSelect === true,
      options,
    });
  }
  return { title: text(p?.title) || null, questions };
}

/** `answers` maps a question's key to the chosen option id. */
export function acpAskAnswer(kind: AcpAskKind, questions: AcpAskQuestion[], answers: Record<string, string>): Record<string, unknown> {
  if (kind === 'grok') {
    return {
      outcome: 'accepted',
      answers: Object.fromEntries(questions.flatMap((q) => {
        const chosen = q.options.find((o) => o.id === answers[q.key]);
        return chosen ? [[q.text, chosen.label]] : [];
      })),
    };
  }
  return {
    outcome: {
      outcome: 'answered',
      answers: questions.flatMap((q) => (answers[q.key] ? [{ questionId: q.key, selectedOptionIds: [answers[q.key]] }] : [])),
    },
  };
}

export function acpAskSkip(kind: AcpAskKind): Record<string, unknown> {
  return kind === 'grok' ? { outcome: 'skip' } : { outcome: { outcome: 'skipped', reason: 'The user skipped the questions.' } };
}
