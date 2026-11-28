import { severityOf, resetAtMs, type UsageWindow } from '$lib/stores/usage';
import './UsageMeter.css';

interface Props {
  window: UsageWindow;
  /** Show the reset countdown inside the bar. */
  showReset?: boolean;
  display?: 'used' | 'left';
  /** Rate-limit reset credits the provider still has, shown beside the countdown. */
  credits?: number | null;
  now?: number;
}

/** "45m", "4h 55m", "1d 14h". */
function countdown(ms: number): string {
  const mins = Math.round(ms / 60000);
  if (mins <= 0) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * One usage window: a label and percentage over a rectangular bar.
 *
 * The solid block is the amount, the hatching is the rest, and the upright
 * marker is the pace line: where the block would end if the allowance were
 * spent evenly across the window. The countdown to the reset sits in the bar.
 */
export default function UsageMeter({ window, showReset = true, display = 'left', credits, now = Date.now() }: Props) {
  const severity = severityOf(window.usedPercent);
  const used = Math.min(100, Math.max(0, window.usedPercent));
  const percent = Math.round(display === 'used' ? used : 100 - used);

  const resetAt = resetAtMs(window);
  const reset = showReset && resetAt != null ? countdown(resetAt - now) : null;
  // Needs both the reset instant and the window's length; some providers give only one.
  let pace: number | null = null;
  if (resetAt != null && window.windowMinutes) {
    const timeLeft = Math.min(1, Math.max(0, (resetAt - now) / (window.windowMinutes * 60000)));
    pace = (display === 'used' ? 1 - timeLeft : timeLeft) * 100;
  }

  return (
    <div className="usage-meter" data-severity={severity}>
      <div className="usage-meter-heading">
        <span className="usage-meter-label" title={window.label}>
          {window.label} window
        </span>
        <span className="usage-meter-remaining">{percent}% {display}</span>
      </div>
      <div
        className="usage-meter-track"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${window.label} window: ${percent}% ${display}${reset ? `, resets in ${reset}` : ''}`}
      >
        <span className="usage-meter-fill" style={{ width: `${percent}%` }} />
        {pace != null && (
          <span className="usage-meter-pace" style={{ left: `${pace}%`, translate: `-${pace}% 0` }} title="Even pace for this window" />
        )}
        {reset && (
          <span className="usage-meter-reset" title={`Resets in ${reset}`}>
            <span aria-hidden="true">↻</span> {reset}
            {credits ? (
              <span className="usage-meter-credits" title={`${credits} reset credit${credits === 1 ? '' : 's'} available`}>
                <span aria-hidden="true">·</span>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3 7h18v3a2 2 0 0 0 0 4v3H3v-3a2 2 0 0 0 0-4z" />
                </svg>
                {credits}
              </span>
            ) : null}
          </span>
        )}
      </div>
    </div>
  );
}
