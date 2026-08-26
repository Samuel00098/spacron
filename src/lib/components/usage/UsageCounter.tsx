import { useEffect, useMemo, useRef } from 'react';
import { useStore } from '$lib/react/useStore';
import { useWorkspaceStore } from '$lib/stores/zustand/workspace';
import { homeScreenOpen } from '$lib/stores/layout';
import { AgentBrandMark } from '$lib/components/shared/useAgentBrand';
import {
  usageState,
  toggleUsagePanel,
  startUsagePolling,
  peakWindow,
  providerHeadlines,
  severityOf,
  shortWindowLabel,
} from '$lib/stores/usage';
import './UsageCounter.css';

/**
 * How many agents get a readout before the rest collapse into a "+N". Three is
 * where the dock stops having room; the popover has all of them.
 */
const MAX_AGENTS = 3;

/** Windows shown per agent. The list is sorted worst-first, so this keeps the constraint. */
const MAX_WINDOWS = 2;

/**
 * The agent usage readout, docked in the bottom-left corner of the window.
 *
 * Shows each signed-in agent's own numbers — brand mark, percentage, and the
 * window that percentage belongs to (`27% 5h · 6% wk`), most-constrained first.
 *
 * The window suffix is the load-bearing part. An unqualified "100%" reads like
 * a full tank when it actually means the allowance is gone; "100% mo" says
 * which allowance, and the brand mark says whose. That ambiguity is why this
 * replaced a single anonymous percentage.
 *
 * It moved out of the titlebar and into the corner because the titlebar is a row
 * of same-sized icon buttons and this is the one item there that is a *reading*
 * — it grows and shrinks with the number of agents, and every change shoved its
 * neighbours sideways. The corner gives it room to be as wide as it needs and
 * puts it where a status readout is conventionally looked for.
 *
 * Rendered as a sibling of `.app-shell` (App.tsx) so it floats over the
 * workspace rather than reserving a strip of it. That also means the shell's
 * `.agent-brand-mark` sizing rules don't reach it — see [[agent-brand-marks]] —
 * so `UsageCounter.css` sizes the inner `svg,img` itself.
 *
 * Its own component for the same reason as the inbox bell: it subscribes to a
 * store that updates on a timer, and folding that into a parent would re-render
 * that parent every poll.
 */
export default function UsageCounter() {
  const { providers, loading, lastFetchedAt } = useStore(usageState);
  const dockRef = useRef<HTMLButtonElement | null>(null);

  // Home is an overlay over the live workspace, so `workspaceId` stays set while
  // it's up. Match the titlebar's workspace-tool gate so the dock disappears on
  // the welcome and home screens rather than floating over them.
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const homeOpen = useStore(homeScreenOpen);
  const showDock = Boolean(workspaceId) && !homeOpen;

  // One owner for the schedule. Idempotent, so mounting twice is harmless, and
  // gated on the dock being live so a workspace-less window doesn't spend the
  // user's quota checking on their quota.
  useEffect(() => {
    if (showDock) startUsagePolling();
  }, [showDock]);

  const headlines = useMemo(() => providerHeadlines(providers), [providers]);
  const peak = useMemo(() => peakWindow(providers), [providers]);

  useEffect(() => {
    if (!dockRef.current) {
      document.documentElement.style.setProperty('--usage-dock-width', '0px');
      return;
    }
    const el = dockRef.current;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const width = entry.borderBoxSize?.[0]?.inlineSize ?? entry.contentRect.width;
        document.documentElement.style.setProperty('--usage-dock-width', `${Math.round(width + 8)}px`);
      }
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      document.documentElement.style.setProperty('--usage-dock-width', '0px');
    };
  }, [headlines, loading, showDock]);

  if (!showDock) return null;

  // Nothing reporting and nothing tried yet — don't flash an empty chip into
  // the corner on cold start. Once a refresh has completed the chip stays
  // reachable so the panel can explain why it's empty.
  if (headlines.length === 0 && lastFetchedAt === 0) return null;

  const severity = peak ? severityOf(peak.window.usedPercent) : 'none';
  const shown = headlines.slice(0, MAX_AGENTS);
  const hidden = headlines.length - shown.length;

  const label = peak
    ? `Agent usage: ${peak.provider.name} at ${Math.round(peak.window.usedPercent)}% of its ${peak.window.label} limit`
    : 'Agent usage';

  return (
    <button
      ref={dockRef}
      className="usage-dock"
      data-usage-toggle
      data-severity={severity}
      data-loading={loading ? 'true' : undefined}
      data-empty={headlines.length === 0 ? 'true' : undefined}
      onClick={toggleUsagePanel}
      aria-label={label}
      title={label}
    >
      {headlines.length === 0 ? (
        <svg
          width="17"
          height="17"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          {/* A code glyph — this chip is about coding-agent capacity, and with
              no numbers to show the icon has to carry that on its own. */}
          <path d="M8.5 16.5 4 12l4.5-4.5" />
          <path d="M15.5 7.5 20 12l-4.5 4.5" />
        </svg>
      ) : (
        shown.map(({ provider, windows }) => (
          <span className="usage-dock-agent" key={provider.provider}>
            <span className="usage-dock-mark" aria-hidden="true">
              <AgentBrandMark command={provider.command} name={provider.name} />
            </span>
            {windows.slice(0, MAX_WINDOWS).map((window, index) => {
              const percent = Math.round(window.usedPercent);
              const suffix = shortWindowLabel(window);
              return (
                <span
                  className="usage-dock-window"
                  key={window.label}
                  data-severity={severityOf(window.usedPercent)}
                >
                  {index > 0 && <span className="usage-dock-sep" aria-hidden="true">·</span>}
                  <span className="usage-dock-num">{percent}%</span>
                  {suffix && <span className="usage-dock-win">{suffix}</span>}
                </span>
              );
            })}
          </span>
        ))
      )}

      {hidden > 0 && (
        <span className="usage-dock-more" aria-hidden="true">
          +{hidden}
        </span>
      )}
    </button>
  );
}
