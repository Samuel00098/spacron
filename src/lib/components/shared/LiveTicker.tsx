/**
 * A "live" indicator replacing manual refresh buttons: a pulsing dot plus the
 * cadence of the surface that owns it — a countdown to the next auto-refresh,
 * or a static "Live · updates every Ns" label where the cadence is too fast to
 * count down (the resource panel's 2s poll).
 *
 * The dot is a state-carrying loop, not decoration: while it pulses the data
 * on screen is being kept fresh without the user doing anything. It is
 * therefore exempted from the global reduced-motion freeze in global.css,
 * like the reconnect dot and the fleet status dot.
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
}) {
  // A 1s tick so the countdown (and the age in the panel header) moves. Only
  // this component re-renders — the parent stays put between polls.
  const [, setNow] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  let text: string;
  if (refreshing) {
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
    <span className="live-ticker" title={text}>
      <i className="live-ticker-dot" aria-hidden="true" />
      {text}
    </span>
  );
}
