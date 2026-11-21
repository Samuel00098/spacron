/**
 * Claude's `AskUserQuestion` tool, as it arrives over stream-json: a
 * `can_use_tool` request whose input holds 1-4 questions, each with labelled
 * options. Print mode has no UI for it, so the host answers by allowing the
 * tool with `updatedInput.answers` (question text -> chosen label).
 *
 * Verified live against the Claude CLI (2026-11-21): the request input matches
 * this shape, and answering with `answers: { <question text>: <label> }` made
 * the model report the chosen option. A malformed input falls back to the
 * generic permission card.
 */
export interface ClaudeQuestionOption {
  label: string;
  description: string | null;
}

export interface ClaudeQuestion {
  question: string;
  header: string | null;
  options: ClaudeQuestionOption[];
  multiSelect: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function isAskUserQuestion(tool: string): boolean {
  return tool === 'AskUserQuestion';
}

/** The questions to ask, or null when the input is not the shape we can render. */
export function parseAskUserQuestion(input: unknown): ClaudeQuestion[] | null {
  const raw = asRecord(input)?.questions;
  if (!Array.isArray(raw) || !raw.length) return null;
  const questions: ClaudeQuestion[] = [];
  for (const entry of raw) {
    const item = asRecord(entry);
    const question = typeof item?.question === 'string' ? item.question.trim() : '';
    const rawOptions = Array.isArray(item?.options) ? item.options : [];
    const options: ClaudeQuestionOption[] = [];
    for (const option of rawOptions) {
      const o = asRecord(option);
      const label = typeof o?.label === 'string' ? o.label.trim() : typeof option === 'string' ? option.trim() : '';
      if (!label) continue;
      options.push({ label, description: typeof o?.description === 'string' && o.description.trim() ? o.description.trim() : null });
    }
    if (!question || !options.length) return null;
    questions.push({
      question,
      header: typeof item?.header === 'string' && item.header.trim() ? item.header.trim() : null,
      options,
      multiSelect: item?.multiSelect === true,
    });
  }
  return questions;
}

/** The tool input to send back once every question has an answer. */
export function answeredInput(input: Record<string, unknown>, answers: Record<string, string>): Record<string, unknown> {
  return { ...input, answers };
}
