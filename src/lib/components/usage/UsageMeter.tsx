import { severityOf, type UsageWindow, describeReset } from '$lib/stores/usage';
import './UsageMeter.css';

interface Props {
  window: UsageWindow;
  /** Show the reset time beside the percentage. Off in dense contexts like the titlebar. */
  showReset?: boolean;
  now?: number;
}

/**
 * One usage window as a labelled bar.
 *
 * The percentage is stated as text as well as drawn, because the bar alone is
 * only comparable against itself — "how close am I?" is a number question, and
 * a 4px-wide difference in fill does not answer it.
 *
 * Laid out on one line (label · bar · percent · reset) so a row of windows
 * stays as tall as its header — the compact shape the usage popup is meant to
 * have. The reset time is the least-loaded fact, so it sits at the far right,
 * small, rather than on its own line.
 */
export default function UsageMeter({ window, showReset = true, now = Date.now() }: Props) {
  const severity = severityOf(window.usedPercent);
  const reset = showReset ? describeReset(window, now) : null;
  const percent = Math.round(window.usedPercent);
  const remaining = Math.max(0, Math.round(100 - window.usedPercent));

  return (
    <div className="usage-meter" data-severity={severity}>
      <div className="usage-meter-heading">
        <span className="usage-meter-label" title={window.label}>
          {window.label} window
        </span>
        <span className="usage-meter-remaining">{remaining}% left</span>
      </div>
      <div
        className="usage-meter-track"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${window.label} window: ${remaining}% remaining`}
      >
        <span className="usage-meter-fill" style={{ width: `${remaining}%` }} />
      </div>
      {reset && (
        <span className="usage-meter-reset" title={reset}>
          {reset}
        </span>
      )}
    </div>
  );
}
