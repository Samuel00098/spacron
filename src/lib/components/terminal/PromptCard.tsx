import { useEffect, useRef, useState } from 'react';
import type { ScreenPrompt } from '$lib/services/terminal-prompt';

/**
 * The question or approval an agent is waiting on, as a card above the chat
 * composer (Orca's ask card). Options answer with one click or their number
 * key; a "Type something." row becomes a text field answered in place.
 */
export default function PromptCard({
  prompt,
  agentLabel,
  answering,
  onAnswer,
  onDismiss,
  onOpenTerminal,
}: {
  prompt: ScreenPrompt;
  agentLabel: string;
  /** The option being sent, while its keys go through. */
  answering: number | null;
  onAnswer: (index: number, text?: string) => void;
  onDismiss: () => void;
  onOpenTerminal: () => void;
}) {
  const [text, setText] = useState('');
  const [active, setActive] = useState<number>(() => prompt.options.find((o) => o.highlighted)?.index ?? 0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const freeTextRef = useRef<HTMLInputElement | null>(null);
  const locked = answering !== null;

  // Number keys answer, arrows move, Enter chooses — while focus is in the card
  // or nowhere in particular (not while typing in the composer or a field).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (locked || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      const inCard = Boolean(target && rootRef.current?.contains(target));
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (typing && !inCard) return;
      if (target === freeTextRef.current) return;
      const option = prompt.options.find((o) => String(o.number) === event.key);
      if (option) {
        event.preventDefault();
        if (option.freeText) freeTextRef.current?.focus();
        else onAnswer(option.index);
        return;
      }
      if (!inCard) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        setActive((i) => (i + (event.key === 'ArrowDown' ? 1 : -1) + prompt.options.length) % prompt.options.length);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        onDismiss();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [locked, prompt, onAnswer, onDismiss]);

  // Arrow keys move the highlight only once the card has focus, and then focus
  // follows it; the card never takes focus from the composer on its own.
  useEffect(() => {
    if (!rootRef.current?.contains(document.activeElement)) return;
    const row = rootRef.current.querySelector<HTMLElement>(`[data-option="${active}"]`);
    if (row && !row.contains(document.activeElement)) row.focus({ preventScroll: true });
  }, [active]);

  function submitText(index: number) {
    if (!text.trim() || locked) return;
    onAnswer(index, text.trim());
  }

  return (
    <div className={`tc-ask${locked ? ' locked' : ''}`} ref={rootRef} role="group" aria-label={`${agentLabel} is asking: ${prompt.question}`}>
      <div className="tc-ask-head">
        <span className="tc-ask-pulse" aria-hidden="true" />
        <span className="tc-ask-eyebrow">{agentLabel} needs your answer</span>
        {prompt.header && <span className="tc-ask-chip">{prompt.header}</span>}
      </div>
      <div className="tc-ask-question">{prompt.question}</div>

      {prompt.multiSelect ? (
        <div className="tc-ask-note">
          This one takes several answers. Pick them in the terminal.
          <button type="button" className="tc-ask-link" onClick={onOpenTerminal}>Open terminal</button>
        </div>
      ) : (
        <div className="tc-ask-options" role="listbox" aria-label="Options">
          {prompt.options.map((option) => (option.freeText ? (
            <div
              key={option.index}
              className={`tc-ask-option free${active === option.index ? ' active' : ''}`}
              data-option={option.index}
              tabIndex={-1}
            >
              <kbd className="tc-ask-key">{option.number}</kbd>
              <input
                ref={freeTextRef}
                className="tc-ask-input"
                value={text}
                disabled={locked}
                placeholder="Type your own answer…"
                aria-label="Your own answer"
                onFocus={() => setActive(option.index)}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    submitText(option.index);
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    (e.target as HTMLInputElement).blur();
                  }
                }}
              />
              <button
                type="button"
                className="tc-ask-send"
                aria-label="Send answer"
                disabled={!text.trim() || locked}
                onClick={() => submitText(option.index)}
              >
                {answering === option.index ? <span className="tc-ask-spinner" /> : (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
                )}
              </button>
            </div>
          ) : (
            <button
              key={option.index}
              type="button"
              role="option"
              aria-selected={active === option.index}
              data-option={option.index}
              className={`tc-ask-option${active === option.index ? ' active' : ''}${answering === option.index ? ' sending' : ''}`}
              disabled={locked}
              onMouseEnter={() => setActive(option.index)}
              onFocus={() => setActive(option.index)}
              onClick={() => onAnswer(option.index)}
            >
              <kbd className="tc-ask-key">{option.number}</kbd>
              <span className="tc-ask-text">
                <span className="tc-ask-label">{option.label}</span>
                {option.description && <span className="tc-ask-desc">{option.description}</span>}
              </span>
              <span className="tc-ask-go" aria-hidden="true">
                {answering === option.index ? <span className="tc-ask-spinner" /> : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
                )}
              </span>
            </button>
          )))}
        </div>
      )}

      <div className="tc-ask-foot">
        <span className="tc-ask-hint">
          <kbd>1</kbd>–<kbd>{Math.min(9, prompt.options.length)}</kbd> to choose · <kbd>Esc</kbd> to dismiss
        </span>
        <span className="tc-ask-spacer" />
        <button type="button" className="tc-ask-link" onClick={onDismiss} disabled={locked}>Dismiss</button>
        <button type="button" className="tc-ask-link" onClick={onOpenTerminal}>Open terminal</button>
      </div>
    </div>
  );
}
