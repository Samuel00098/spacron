/**
 * A compact text status replacing manual refresh buttons: a countdown to the
 * next auto-refresh, or a static "Live" label where the cadence is too fast to
 * count down. Label-only tickers intentionally remain static text.
 */

import { useEffect, useState } from 'react';
import './LiveTicker.css';

function formatRemaining(ms: number): string {
  const secs = Math.max(0, Math.round(ms / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rest = secs % 60;
  if (mins < 60) return rest ? `${mins}m ${rest}s` : `${mins}m`;
  const hours = Math.floor(mins / 60);
  const restMins = mins % 60;
  return restMins ? `${hours}h ${restMins}m` : `${hours}h`;
}

export default function LiveTicker({
  intervalMs,
  lastFetchedAt,
  refreshing = false,
  countdown = true,
  liveLabel = 'Live',
  labelOnly = false,
}: {
  /** How often the owning surface re-fetches, in milliseconds. */
  intervalMs: number;
  /** Unix ms of the last successful fetch; 0 before the first one lands. */
  lastFetchedAt: number;
  /** True while a refresh is in flight — shows "Updating…" instead. */
  refreshing?: boolean;
  /** Count down to the next tick; false renders a static interval label. */
  countdown?: boolean;
  /** Static label when `countdown` is false, e.g. "Live". */
  liveLabel?: string;
  /** Keep the status visually steady while the owning store refreshes itself. */
  labelOnly?: boolean;
}) {
  // A 1s tick so the countdown (and the age in the panel header) moves. Only
  // this component re-renders — the parent stays put between polls.
  const [, setNow] = useState(0);

  useEffect(() => {
    if (labelOnly) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [labelOnly]);

  let text: string;
  if (labelOnly) {
    text = liveLabel;
  } else if (refreshing) {
    text = 'Updating…';
  } else if (countdown) {
    text =
      lastFetchedAt <= 0
        ? 'Waiting for first reading…'
        : `Next update in ${formatRemaining(lastFetchedAt + intervalMs - Date.now())}`;
  } else {
    text = `${liveLabel} · updates every ${formatRemaining(intervalMs)}`;
  }

  return (
    <span className={`live-ticker${labelOnly ? ' label-only' : ''}`} title={text}>
      <span className="live-ticker-label">{text}</span>
    </span>
  );
}
