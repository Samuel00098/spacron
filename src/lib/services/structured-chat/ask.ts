/**
 * An agent's questions as the chat shows them, whatever protocol they came in
 * on. The card collects every answer first and sends them together, so the
 * user can page back and change one.
 */
export interface AskQuestion {
  header: string | null;
  text: string;
  options: { id: string; label: string; description: string | null }[];
  /** Several options may be chosen. */
  multiple: boolean;
  /** A typed answer is accepted alongside, or instead of, the options. */
  allowOther: boolean;
}

export interface AskAnswer {
  optionIds: string[];
  other: string;
}

/** The chosen labels, then the typed answer. */
export function answerLabels(question: AskQuestion, answer: AskAnswer | undefined): string[] {
  if (!answer) return [];
  const labels = question.options.filter((o) => answer.optionIds.includes(o.id)).map((o) => o.label);
  const other = question.allowOther ? answer.other.trim() : '';
  return other ? [...labels, other] : labels;
}

export function allAnswered(questions: AskQuestion[], answers: AskAnswer[] | undefined): answers is AskAnswer[] {
  return !!answers && questions.every((q, i) => answerLabels(q, answers[i]).length > 0);
}

/** The card's title in notifications and the transcript's receipt. */
export function askTitle(questions: AskQuestion[]): string {
  const more = questions.length > 1 ? ` (+${questions.length - 1} more)` : '';
  return `${questions[0]?.text ?? 'Question'}${more}`;
}
