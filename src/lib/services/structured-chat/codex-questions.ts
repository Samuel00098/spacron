/**
 * Codex's `item/tool/requestUserInput` (EXPERIMENTAL in its app-server
 * protocol; shapes taken from `codex app-server generate-json-schema`, codex-cli
 * 0.171.0). Params hold `questions[]` with an `id`, a `header`, the `question`
 * and optional `options[{label, description}]`. The response maps each question
 * id to `{ answers: string[] }`.
 *
 * Only questions with options are rendered as cards. A free-text or secret
 * question cannot be answered from an option button, so the whole request is
 * left to the caller to reject, exactly as before, rather than answered wrongly.
 */
export interface CodexQuestion {
  id: string;
  header: string;
  question: string;
  options: { label: string; description: string | null }[];
  /** Codex's `isOther`: a typed answer is accepted too. */
  allowOther: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function parseCodexQuestions(params: unknown): CodexQuestion[] | null {
  const raw = asRecord(params)?.questions;
  if (!Array.isArray(raw) || !raw.length) return null;
  const out: CodexQuestion[] = [];
  for (const entry of raw) {
    const q = asRecord(entry);
    if (!q || q.isSecret === true) return null;
    const id = typeof q.id === 'string' ? q.id : '';
    const question = typeof q.question === 'string' ? q.question.trim() : '';
    const options = (Array.isArray(q.options) ? q.options : []).flatMap((option) => {
      const o = asRecord(option);
      const label = typeof o?.label === 'string' ? o.label.trim() : '';
      return label ? [{ label, description: typeof o?.description === 'string' && o.description.trim() ? o.description.trim() : null }] : [];
    });
    if (!id || !question || !options.length) return null;
    out.push({ id, header: typeof q.header === 'string' ? q.header.trim() : '', question, options, allowOther: q.isOther === true });
  }
  return out;
}

/** The JSON-RPC result once every question is answered. */
export function codexAnswers(answers: Record<string, string[]>): { answers: Record<string, { answers: string[] }> } {
  return { answers: Object.fromEntries(Object.entries(answers).map(([id, labels]) => [id, { answers: labels }])) };
}
