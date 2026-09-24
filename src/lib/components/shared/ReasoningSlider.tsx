import type { ChatReasoningEffort } from '$lib/types/chat';
import { REASONING_LABELS } from '$lib/services/orchestrator/reasoning-levels';
import './ReasoningSlider.css';

export default function ReasoningSlider({ value, levels, onChange, disabled = false, defaultLabel = 'Default' }: {
  value: ChatReasoningEffort;
  levels: ChatReasoningEffort[];
  onChange: (value: ChatReasoningEffort) => void;
  disabled?: boolean;
  defaultLabel?: string;
}) {
  const choices: ChatReasoningEffort[] = ['default', ...levels.filter((level) => level !== 'default')];
  const index = Math.max(0, choices.indexOf(value));
  const label = value === 'default' ? defaultLabel : REASONING_LABELS[value];
  return (
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
}
