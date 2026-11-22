import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '$lib/react/useStore';

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
const MAX_AGENTS = 3;

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
  const dockRef = useRef<HTMLButtonElement | null>(null);
  const [maxAgents, setMaxAgents] = useState(MAX_AGENTS);

  // One owner for the schedule. Idempotent, so mounting twice is harmless.
  // Not gated on a workspace: usage belongs to the signed-in agent accounts,
  // not to a project, and it is worth seeing before one is open.
  useEffect(() => {
    startUsagePolling();
  }, []);

  const headlines = useMemo(() => providerHeadlines(providers), [providers]);
  const peak = useMemo(() => peakWindow(providers), [providers]);

  // Dynamically adapt shown agent count to available footer width
  // so badges and percentages never collide or overlap.
  useEffect(() => {
    const el = dockRef.current;
    if (!el) return;
    const parent = el.parentElement;

    const computeMax = (containerWidth: number) => {
      // In narrow footers (<195px), show 1 agent + "+N" badge so readings remain crisp and uncrowded.
      // In mid footers (195px - 265px), show 2 agents + "+N".
      // In wide footers (>=265px), show up to MAX_AGENTS (3).
      if (containerWidth < 195) return 1;
      if (containerWidth < 265) return 2;
      return MAX_AGENTS;
    };

    const target = parent ?? el;
    const update = () => {
      const w = target.getBoundingClientRect().width;
      if (w > 0) {
        const next = computeMax(w);
        setMaxAgents((prev) => (prev !== next ? next : prev));
      }
    };

    update();
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = entry.contentRect.width;
        if (w > 0) {
          const next = computeMax(w);
          setMaxAgents((prev) => (prev !== next ? next : prev));
        }
      }
    });
    ro.observe(target);
    return () => ro.disconnect();
  }, []);

  const severity = peak ? severityOf(peak.window.usedPercent) : 'none';
  const shown = headlines.slice(0, maxAgents);
  const hidden = headlines.length - shown.length;

  const label = peak
    ? `Agent usage: ${peak.provider.name} at ${Math.round(peak.window.usedPercent)}% of its ${peak.window.label} limit`
    : 'Agent usage';

  return (
    <button
      ref={dockRef}
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
