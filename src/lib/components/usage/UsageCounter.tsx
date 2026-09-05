import { useEffect, useMemo } from 'react';
import { useStore } from '$lib/react/useStore';
import { useWorkspaceStore } from '$lib/stores/zustand/workspace';
import { homeScreenOpen } from '$lib/stores/layout';
import { AgentBrandMark } from '$lib/components/shared/useAgentBrand';
import {
  usageState,
  isUsagePanelOpen,
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
const MAX_AGENTS = 2;

/** Windows shown per agent. The list is sorted worst-first, so this keeps the constraint. */
const MAX_WINDOWS = 1;

/**
 * The agent usage readout in the unified left-sidebar footer.
 *
 * Shows each signed-in agent's own numbers — brand mark, percentage, and the
 * window that percentage belongs to (`27% 5h · 6% wk`), most-constrained first.
 *
 * The window suffix is the load-bearing part. An unqualified "100%" reads like
 * a full tank when it actually means the allowance is gone; "100% mo" says
 * which allowance, and the brand mark says whose. That ambiguity is why this
 * replaced a single anonymous percentage.
 *
 * It moved out of the titlebar because the titlebar is a row of same-sized icon
 * buttons and this is the one item there that is a *reading*. The sidebar gives
 * it a stable width and keeps it beside Settings in the Navigator footer.
 *
 * `UsageCounter.css` sizes the inner `svg,img` itself so provider marks remain
 * legible in the compact footer.
 *
 * Its own component for the same reason as the inbox bell: it subscribes to a
 * store that updates on a timer, and folding that into a parent would re-render
 * that parent every poll.
 */
export default function UsageCounter() {
  const { providers, loading } = useStore(usageState);
  const panelOpen = useStore(isUsagePanelOpen);

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

  if (!showDock) return null;

  const severity = peak ? severityOf(peak.window.usedPercent) : 'none';
  const shown = headlines.slice(0, MAX_AGENTS);
  const hidden = headlines.length - shown.length;

  const label = peak
    ? `Agent usage: ${peak.provider.name} at ${Math.round(peak.window.usedPercent)}% of its ${peak.window.label} limit`
    : 'Agent usage';

  return (
    <button
      className="usage-dock usage-dock-sidebar"
      data-usage-toggle
      data-severity={severity}
      data-loading={loading ? 'true' : undefined}
      data-empty={headlines.length === 0 ? 'true' : undefined}
      data-open={panelOpen ? 'true' : undefined}
      onClick={toggleUsagePanel}
      aria-label={label}
      aria-expanded={panelOpen}
      aria-controls="sidebar-usage-details"
      title={label}
    >
      {headlines.length === 0 ? (
        <>
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
          <span className="usage-dock-empty-label">Usage</span>
        </>
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
      <svg className="usage-dock-caret" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="m6 9 6 6 6-6" />
      </svg>
    </button>
  );
}
