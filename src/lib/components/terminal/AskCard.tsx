import { useEffect, useRef, useState, type RefObject } from 'react';
import { answerLabels, type AskAnswer, type AskQuestion } from '$lib/services/structured-chat/ask';
import './AskCard.css';

/** Stroke icons on a 24px grid. */
const ICONS = {
  question: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2-3 4M12 17h.01',
  left: 'M19 12H5M12 19l-7-7 7-7',
  right: 'M5 12h14M12 5l7 7-7 7',
  down: 'M6 9l6 6 6-6',
  close: 'M18 6 6 18M6 6l12 12',
  check: 'M20 6 9 17l-5-5',
  enter: 'M9 10l-5 5 5 5M20 4v7a4 4 0 0 1-4 4H4',
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3M19 11a7 7 0 0 1-14 0M12 18v3',
};

function Icon({ name, size = 14, className }: { name: keyof typeof ICONS; size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  );
}

/** An agent's questions, docked above the composer until answered or skipped. */
export function AskCard({ questions, keysRef, onSubmit, onSkip, onDictate }: {
  questions: AskQuestion[];
  /** Where number keys and Enter are listened for (the whole chat view). */
  keysRef?: RefObject<HTMLElement | null>;
  onSubmit: (answers: AskAnswer[]) => void;
  onSkip: () => void;
  /** Dictate into whatever field has focus. Omitted hides the mic. */
  onDictate?: () => void;
}) {
  const [answers, setAnswers] = useState<AskAnswer[]>(() => questions.map(() => ({ optionIds: [], other: '' })));
  const [index, setIndex] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const otherRef = useRef<HTMLInputElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const question = questions[index];
  const answer = answers[index];
  const total = questions.length;
  const answered = answerLabels(question, answer).length > 0;

  const patch = (next: Partial<AskAnswer>) => setAnswers((list) => list.map((a, i) => (i === index ? { ...a, ...next } : a)));

  function choose(id: string) {
    if (question.multiple) {
      patch({ optionIds: answer.optionIds.includes(id) ? answer.optionIds.filter((x) => x !== id) : [...answer.optionIds, id] });
    } else {
      // One answer only: an option replaces whatever was typed.
      patch({ optionIds: [id], other: '' });
    }
  }

  function advance() {
    if (!answered) return;
    if (index < total - 1) {
      setIndex(index + 1);
      return;
    }
    const missing = questions.findIndex((q, i) => !answerLabels(q, answers[i]).length);
    if (missing >= 0) setIndex(missing);
    else onSubmit(answers);
  }

  // Paging can disable the button that had focus, which would drop it out of the
  // chat and leave the number keys dead. The first render never takes focus.
  const shownRef = useRef(index);
  useEffect(() => {
    if (shownRef.current === index) return;
    shownRef.current = index;
    cardRef.current?.focus({ preventScroll: true });
  }, [index]);

  // Re-attached each render so the handler always sees the current question.
  useEffect(() => {
    const el = keysRef?.current;
    if (!el || collapsed) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      const number = Number(event.key) - 1;
      if (Number.isInteger(number) && number >= 0 && number < question.options.length) {
        choose(question.options[number].id);
      } else if (question.allowOther && number === question.options.length) {
        otherRef.current?.focus();
      } else if (event.key === 'Enter' && answered && !target?.closest('a, button:not(.ask-card-option[aria-checked="true"])')) {
        advance();
      } else return;
      event.preventDefault();
      event.stopPropagation();
    };
    el.addEventListener('keydown', onKey, true);
    return () => el.removeEventListener('keydown', onKey, true);
  });

  return (
    <div ref={cardRef} tabIndex={-1} className="ask-card" role="group" aria-label={question.text}>
      <div className="ask-card-head">
        <Icon name="question" className="ask-card-mark" />
        <div className="ask-card-title">
          {question.header && <span className="ask-card-chip">{question.header}</span>}
          <span>{question.text}</span>
        </div>
        {total > 1 && (
          <div className="ask-card-pager">
            <button type="button" aria-label="Previous question" disabled={index === 0} onClick={() => setIndex(index - 1)}><Icon name="left" /></button>
            <span>{index + 1}/{total}</span>
            <button type="button" aria-label="Next question" disabled={index === total - 1} onClick={() => setIndex(index + 1)}><Icon name="right" /></button>
          </div>
        )}
        <button type="button" className="ask-card-icon" aria-label={collapsed ? 'Expand question' : 'Collapse question'} aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}>
          <Icon name="down" className={collapsed ? 'ask-card-flip' : undefined} />
        </button>
        <button type="button" className="ask-card-icon" aria-label="Skip" title="Skip" onClick={onSkip}><Icon name="close" /></button>
      </div>
      {!collapsed && (
        <>
          <div className="ask-card-options" role={question.multiple ? 'group' : 'radiogroup'} aria-label="Answers">
            {question.options.map((option, i) => {
              const selected = answer.optionIds.includes(option.id);
              return (
                <button
                  key={`${index}-${option.id}`}
                  type="button"
                  role={question.multiple ? 'checkbox' : 'radio'}
                  aria-checked={selected}
                  className={`ask-card-option${selected ? ' selected' : ''}`}
                  onClick={() => choose(option.id)}
                >
                  <kbd>{i + 1}</kbd>
                  <span className="ask-card-option-text">
                    <span>{option.label}</span>
                    {option.description && <small>{option.description}</small>}
                  </span>
                  {selected && <Icon name="check" className="ask-card-check" />}
                </button>
              );
            })}
          </div>
          <div className="ask-card-foot">
            {question.allowOther ? (
              <label className={`ask-card-other${answer.other.trim() ? ' selected' : ''}`}>
                <kbd>{question.options.length + 1}</kbd>
                <input
                  ref={otherRef}
                  value={answer.other}
                  placeholder="Other (write your answer)"
                  aria-label="Other answer"
                  onChange={(e) => patch({ other: e.target.value, ...(question.multiple || !e.target.value ? {} : { optionIds: [] }) })}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
                    e.preventDefault();
                    advance();
                  }}
                />
              </label>
            ) : (
              <span className="ask-card-hint">{question.multiple ? 'Choose one or more' : ''}</span>
            )}
            {question.allowOther && onDictate && (
              <button
                type="button"
                className="ask-card-icon"
                aria-label="Dictate answer"
                title="Dictate answer"
                // Keeps focus in the field, which is where dictation types.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => { otherRef.current?.focus(); onDictate(); }}
              >
                <Icon name="mic" />
              </button>
            )}
            <button type="button" className="ask-card-skip" onClick={onSkip}>Skip</button>
            <button type="button" className="ask-card-continue" disabled={!answered} onClick={advance}>
              Continue <Icon name="enter" size={12} />
            </button>
          </div>
        </>
      )}
    </div>
  );
}
