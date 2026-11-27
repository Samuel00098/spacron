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
 * Antigravity and OpenCode send no request at all. Antigravity reports an
 * `ask_question` tool call, prints the question and ends the turn (seen live,
 * agy 1.5.18), so its card is built from that call and the choice goes back as
 * the next message. OpenCode and the rest are in `acp-elicitation.ts`.
 */
import { answerLabels, type AskAnswer, type AskQuestion } from './ask';

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

/** The card's view of a question. Grok takes typed answers (seen live, grok 1.0.92); Cursor only option ids. */
export function acpAskCard(kind: AcpAskKind | 'antigravity', questions: AcpAskQuestion[]): AskQuestion[] {
  return questions.map((q) => ({ header: q.header, text: q.text, options: q.options, multiple: q.multiple, allowOther: kind !== 'cursor' }));
}

/** `answers` is in the same order as `questions`. */
export function acpAskAnswer(kind: AcpAskKind, questions: AcpAskQuestion[], answers: AskAnswer[]): Record<string, unknown> {
  if (kind === 'grok') {
    const card = acpAskCard(kind, questions);
    return {
      outcome: 'accepted',
      answers: Object.fromEntries(questions.map((q, i) => [q.text, answerLabels(card[i], answers[i]).join(', ')])),
    };
  }
  return {
    outcome: {
      outcome: 'answered',
      answers: questions.map((q, i) => ({ questionId: q.key, selectedOptionIds: answers[i]?.optionIds ?? [] })),
    },
  };
}

export function acpAskSkip(kind: AcpAskKind): Record<string, unknown> {
  return kind === 'grok' ? { outcome: 'skip' } : { outcome: { outcome: 'skipped', reason: 'The user skipped the questions.' } };
}

/** The questions of an Antigravity `ask_question` tool call, or null for any other update. */
export function parseAntigravityAsk(update: unknown): AcpAskQuestion[] | null {
  const u = asRecord(update);
  if (!u || u.name !== 'ask_question') return null;
  const raw = asRecord(u.rawInput ?? u.args)?.questions;
  if (!Array.isArray(raw) || !raw.length) return null;
  const questions: AcpAskQuestion[] = [];
  for (const entry of raw) {
    const q = asRecord(entry);
    const prompt = text(q?.question);
    const options = (Array.isArray(q?.options) ? q.options : []).flatMap((option, index) => {
      const label = text(option) || text(asRecord(option)?.label);
      return label ? [{ id: String(index), label, description: null }] : [];
    });
    if (!prompt || !options.length) return null;
    questions.push({ key: prompt, header: null, text: prompt, multiple: q?.is_multi_select === true, options });
  }
  return questions;
}

/** The message that answers questions asked in a turn that already ended. */
export function askReplyText(questions: AcpAskQuestion[], answers: AskAnswer[]): string {
  const card = acpAskCard('antigravity', questions);
  const lines = questions.map((q, i) => ({ question: q.text, label: answerLabels(card[i], answers[i]).join(', ') }));
  return lines.length === 1 ? lines[0].label : lines.map((l) => `${l.question} ${l.label}`).join('\n');
}
