import { useEffect } from 'react';
import { useStore } from '$lib/react/useStore';
import { useWorkspaceStore } from '$lib/stores/zustand/workspace';
import { homeScreenOpen } from '$lib/stores/layout';
import {
  resourceState,
  toggleResourcePanel,
  startResourcePolling,
  stopResourcePolling,
  peakCpuPercent,
  severityOfCpu,
  memPercent,
} from '$lib/stores/resource';
import './ResourceChip.css';

/**
 * The resource reading, docked in the titlebar as a fixed-width chip.
 *
 * Shows machine CPU% and RAM% in tabular digits so the chip never changes
 * width — the titlebar is a row of same-sized controls and a reading that
 * grows and shrinks (like the agent usage dock did) shoves its neighbours.
 * Severity colour comes from CPU alone: RAM is worth showing but not worth
 * turning the bar red at 90%.
 *
 * Its own component for the same reason as the inbox bell: it subscribes to a
 * store that updates on a timer, and folding that into the titlebar would
 * re-render the whole window chrome every two seconds.
 */
export default function ResourceChip() {
  const state = useStore(resourceState);
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const homeOpen = useStore(homeScreenOpen);
  const showChip = Boolean(workspaceId) && !homeOpen;

  // One owner for the schedule: start while the chip is live, stop when it
  // hides (welcome/home screen, workspace closed) so a 2s timer isn't sampling
  // a machine nobody is looking at. `startResourcePolling` is idempotent.
  useEffect(() => {
    if (showChip) startResourcePolling();
    return () => stopResourcePolling();
  }, [showChip]);

  if (!showChip) return null;

  const cpu = peakCpuPercent(state);
  const mem = memPercent(state);
  const severity = severityOfCpu(cpu);
  // Live sessions on this machine — the "how many agents are actually running"
  // half of the blend. Counts alive rows only, so a dead shell vanishes.
  const runningSessions = state.sessions.filter((s) => s.alive).length;

  const label =
    cpu != null
      ? `Machine load — CPU ${Math.round(cpu)}%, RAM ${mem != null ? Math.round(mem) : '?'}%`
      : 'Machine load';

  return (
    <button
      className="resource-chip"
      data-resource-toggle
      data-severity={severity}
      onClick={toggleResourcePanel}
      aria-label={label}
      title={label}
    >
      <svg
        className="resource-chip-icon"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
      </svg>
      <span className="resource-chip-num">
        {cpu != null ? `${Math.round(cpu)}%` : '–'}
      </span>
      <span className="resource-chip-sep" aria-hidden="true">·</span>
      <span className="resource-chip-num resource-chip-mem">
        {mem != null ? `${Math.round(mem)}%` : '–'}
      </span>
      {runningSessions > 0 && (
        <span className="resource-chip-count" aria-hidden="true">
          {runningSessions}
        </span>
      )}
    </button>
  );
}
