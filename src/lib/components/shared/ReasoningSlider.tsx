import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChatReasoningEffort } from '$lib/types/chat';
import { REASONING_LABELS } from '$lib/services/orchestrator/reasoning-levels';
import './ReasoningSlider.css';

export default function ReasoningSlider({ value, levels, onChange, disabled = false, defaultLabel = 'Default', dropdown = false }: {
  value: ChatReasoningEffort;
  levels: ChatReasoningEffort[];
  onChange: (value: ChatReasoningEffort) => void;
  disabled?: boolean;
  defaultLabel?: string;
  dropdown?: boolean;
}) {
  const [open, setOpen] = useState(false);
  // Which way the popover opens. Down when there is room under the trigger
  // (e.g. the chat composer centred in an empty thread), up when there is not
  // (the composer docked at the bottom).
  const [placement, setPlacement] = useState<'down' | 'up'>('down');
  const rootRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const choices: ChatReasoningEffort[] = ['default', ...levels.filter((level) => level !== 'default')];
  const index = Math.max(0, choices.indexOf(value));
  const label = value === 'default' ? defaultLabel : REASONING_LABELS[value];
  // Measure after render and before paint, so the popover never flashes on
  // the wrong side. The bounds are the nearest clipping panel when there is
  // one (the chat panel), otherwise the window.
  useLayoutEffect(() => {
    if (!open) return;
    const trigger = rootRef.current;
    const popover = popoverRef.current;
    if (!trigger || !popover) return;
    const rect = trigger.getBoundingClientRect();
    const bounds = trigger.closest('.chat-mode-panel')?.getBoundingClientRect();
    const top = bounds?.top ?? 0;
    const bottom = bounds?.bottom ?? window.innerHeight;
    const needed = popover.offsetHeight + 7 + 8;
    const spaceBelow = bottom - rect.bottom;
    const spaceAbove = rect.top - top;
    setPlacement(spaceBelow >= needed || spaceBelow >= spaceAbove ? 'down' : 'up');
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        rootRef.current?.querySelector<HTMLButtonElement>('.reasoning-slider-trigger')?.focus();
      }
    };
    document.addEventListener('pointerdown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  const slider = (
    <div className="reasoning-slider">
      <span className="reasoning-slider-value">{label}</span>
      <input
        type="range"
        min={0}
        max={choices.length - 1}
        step={1}
        value={index}
        disabled={disabled || choices.length < 2}
        onChange={(event) => onChange(choices[Number(event.target.value)])}
        aria-label="Reasoning level"
        aria-valuetext={label}
      />
      <span className="reasoning-slider-ends" aria-hidden="true"><span>Default</span><span>{REASONING_LABELS[choices.at(-1) ?? 'default']}</span></span>
    </div>
  );

  if (dropdown) return (
    <div className="reasoning-slider-dropdown" ref={rootRef}>
      <button
        type="button"
        className="reasoning-slider-trigger"
        aria-label="Reasoning level"
        aria-expanded={open}
        aria-haspopup="dialog"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{label}</span>
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="m2.5 4.5 3.5 3 3.5-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {open && (
        <div ref={popoverRef} className={`reasoning-slider-popover ${placement}`} role="dialog" aria-label="Reasoning level">
          {slider}
        </div>
      )}
    </div>
  );

  return (
    slider
  );
}
