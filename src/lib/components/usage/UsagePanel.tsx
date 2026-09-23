import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { useStore } from '$lib/react/useStore';
import { AgentBrandMark } from '$lib/components/shared/useAgentBrand';
import {
  usageState,
  isUsagePanelOpen,
  closeUsagePanel,
  usagePanelHeight,
  setUsagePanelHeight,
  persistUsagePanelHeight,
  USAGE_PANEL_MIN_HEIGHT,
  PANEL_POLL_INTERVAL_MS,
  hasNumbers,
  type ProviderUsage,
  type UsageStatus,
} from '$lib/stores/usage';
import {
  accountsState,
  connectWebSession,
  refreshAccounts,
  isWebSessionProvider,
  type AccountsState,
} from '$lib/stores/agentAccounts';
import UsageMeter from './UsageMeter';
import AccountSwitcher from './AccountSwitcher';
import LiveTicker from '$lib/components/shared/LiveTicker';
import './UsagePanel.css';

/**
 * What to say when a provider has no numbers.
 *
 * Every one of these is a different fix, which is exactly why they are separate
 * states rather than one empty bar: "log in" and "run the CLI once" and "we
 * can't read this one" are not interchangeable advice.
 */
const STATUS_NOTE: Record<Exclude<UsageStatus, 'ok'>, string> = {
  // Defensive only: `installedProviders` in the store drops notInstalled rows
  // before they ever reach this component, so an uninstalled CLI vanishes from
  // the list entirely (see usage.ts).
  notInstalled: 'Not installed',
  signedOut: 'Not signed in',
  expired: 'Session expired. Run the CLI once to sign back in.',
  // Web-session providers get their own wording below: "run the CLI once" would
  // send the user somewhere that cannot fix it.
  notConnected: 'Connect your account to read its limits',
  // Describes what *Spacron* reads, not what the vendor offers. The earlier
  // wording ("this CLI doesn't publish a usage endpoint") was a claim about the
  // provider, and it was false for Grok and Gemini — both publish one and both
  // are now read. Never assert absence on the vendor's behalf.
  unsupported: "Signed in, but Spacron doesn't read usage for this CLI yet",
  error: 'Could not read usage',
};

/**
 * How little of the project tree a resize may leave behind, in px.
 *
 * The panel can only grow by taking from the tree above it, and the tree is
 * what the sidebar is mostly for — so the handle stops here rather than letting
 * one drag swallow it. The panel's own floor is `USAGE_PANEL_MIN_HEIGHT`, in
 * the store, so the clamp the handle applies and the clamp the stored value
 * applies cannot drift apart.
 */
const MIN_DRAWER_BODY = 96;

/** How far one arrow-key press moves the handle. */
const DRAG_KEY_STEP = 24;

function relativeAge(fetchedAt: number, now: number): string {
  const mins = Math.floor(Math.max(0, now / 1000 - fetchedAt) / 60);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

function describeCreditExpiry(expiresAtIso: string | null, now: number): string {
  if (!expiresAtIso) return 'no expiry';
  const at = Date.parse(expiresAtIso);
  if (Number.isNaN(at)) return 'expiry unavailable';
  const days = Math.ceil((at - now) / 86_400_000);
  if (days <= 0) return 'expires now';
  return `expires in ${days}d`;
}

function ProviderRow({
  provider,
  now,
  accounts,
}: {
  provider: ProviderUsage;
  now: number;
  accounts: AccountsState;
}) {
  const reporting = hasNumbers(provider);
  const note = provider.status === 'ok' ? null : STATUS_NOTE[provider.status];

  // A row that meters through a browser session and has no usable one needs a
  // button, not a sentence — "connect your account" with nothing to click is
  // the same dead end the old "no usage endpoint" copy was.
  const webLinked = isWebSessionProvider(accounts, provider.provider);
  const needsConnect =
    webLinked && (provider.status === 'notConnected' || provider.status === 'expired');
  const connecting = accounts.connecting === provider.provider;

  return (
    <li className="usage-row" data-reporting={reporting ? 'true' : 'false'}>
      <div className="usage-row-head">
        <span className="usage-row-mark" aria-hidden="true">
          <AgentBrandMark command={provider.command} name={provider.name} />
        </span>
        <span className="usage-row-name">{provider.name}</span>
        {provider.plan && <span className="usage-row-plan">{provider.plan}</span>}
        <AccountSwitcher provider={provider.provider} accounts={accounts} />
      </div>

      {provider.account && <span className="usage-row-account">{provider.account}</span>}

      {reporting ? (
        <>
          <div className="usage-row-meters">
            {provider.windows.map((window) => (
              <UsageMeter key={window.label} window={window} now={now} />
            ))}
          </div>
          {/* A reporting provider can still have something to say — spent
              overage credits, an unmetered model. Rendered under the meters
              rather than instead of them, since both are true at once. */}
          {provider.note && <p className="usage-row-note">{provider.note}</p>}
          {provider.resetCreditsAvailable != null && (
            <details className="usage-row-credits">
              <summary>
                {provider.resetCreditsAvailable === 0
                  ? 'No reset credits available'
                  : `${provider.resetCreditsAvailable} reset credit${provider.resetCreditsAvailable === 1 ? '' : 's'} available`}
              </summary>
              {provider.resetCredits.length > 0 && (
                <ul className="usage-row-credit-list">
                  {provider.resetCredits.map((credit) => (
                    <li key={credit.id}>
                      <span>{credit.resetType ?? 'Rate-limit reset'}</span>
                      <span>{describeCreditExpiry(credit.expiresAtIso, now)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </details>
          )}
        </>
      ) : (
        <p className="usage-row-note">
          {/* An expired web session says "reconnect", not the CLI advice. */}
          {needsConnect && provider.status === 'expired'
            ? 'Session expired'
            : provider.error ?? provider.note ?? note}
          {needsConnect && (
            <button
              className="usage-row-connect"
              onClick={() => void connectWebSession(provider.provider)}
              disabled={connecting}
            >
              {connecting
                ? 'Waiting for sign-in…'
                : provider.status === 'expired'
                  ? 'Reconnect'
                  : 'Connect'}
            </button>
          )}
        </p>
      )}
    </li>
  );
}

/**
 * The usage breakdown, mounted as an inline, expanding part of the Navigator.
 *
 * Scoped to usage and nothing else: the providers Spacron can read a limit for,
 * each with its meters or the reason it has none. It used to end with an "Also
 * installed" strip naming the detected CLIs that publish no usage endpoint, but
 * that answered a different question ("what's on my machine?") in a panel opened
 * to ask "how much have I got left?" — the agent inventory lives in
 * Settings → Agents, which is where it belongs.
 */
export default function UsagePanel() {
  const open = useStore(isUsagePanelOpen);
  const { providers, loading, lastFetchedAt } = useStore(usageState);
  const accounts = useStore(accountsState);
  const panelRef = useRef<HTMLDivElement>(null);
  const dragStartRef = useRef<{ y: number; height: number; maxHeight: number } | null>(null);
  const height = useStore(usagePanelHeight);

  // Accounts and linked sessions change far less often than the meters, so they
  // load when the panel opens rather than on the usage poll.
  useEffect(() => {
    if (open) void refreshAccounts();
  }, [open]);

  // Inline disclosure, not modal — must not trap Tab or swallow app shortcuts.
  // Escape and outside-click still collapse it so it behaves naturally beside
  // the footer trigger without becoming a separate floating surface.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeUsagePanel();
      }
    }
    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node | null;
      if (panelRef.current?.contains(target ?? null)) return;
      // The counter toggles on its own click; ignoring it here stops the two
      // handlers cancelling each other into a no-op.
      if (target instanceof Element && target.closest('[data-usage-toggle]')) return;
      closeUsagePanel();
    }
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [open]);

  /**
   * What the panel is now, and the most it could become.
   *
   * The panel can only take height from one place: the project tree directly
   * above it, which is the sidebar's single flexible row. So the ceiling is
   * this panel plus whatever that body can give up and stay usable. Measured
   * per gesture rather than cached, because the rail and the window are both
   * resizable underneath it.
   */
  function measure(): { height: number; max: number } {
    const panel = panelRef.current;
    if (!panel) return { height: USAGE_PANEL_MIN_HEIGHT, max: USAGE_PANEL_MIN_HEIGHT };
    const shown = panel.getBoundingClientRect().height;
    const body = panel.parentElement?.querySelector<HTMLElement>(':scope > .drawer-body');
    const spare = Math.max(0, (body?.getBoundingClientRect().height ?? 0) - MIN_DRAWER_BODY);
    return { height: shown, max: Math.max(USAGE_PANEL_MIN_HEIGHT, shown + spare) };
  }

  function onDragStart(e: ReactPointerEvent<HTMLButtonElement>) {
    if (!panelRef.current) return;
    const { height, max } = measure();
    dragStartRef.current = { y: e.clientY, height, maxHeight: max };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onDragMove(e: ReactPointerEvent<HTMLButtonElement>) {
    const start = dragStartRef.current;
    if (!start) return;
    const next = start.height + start.y - e.clientY;
    // Clamped at both ends. This used to floor at the height the drag started
    // from, which made the handle growth-only: one overshooting drag and the
    // only way back was to close the panel and reopen it.
    setUsagePanelHeight(Math.min(start.maxHeight, next));
  }

  /** The same resize from the keyboard — the handle is a real control. */
  function onDragKey(e: React.KeyboardEvent<HTMLButtonElement>) {
    const step = e.key === 'ArrowUp' ? DRAG_KEY_STEP : e.key === 'ArrowDown' ? -DRAG_KEY_STEP : 0;
    if (step === 0) return;
    e.preventDefault();
    e.stopPropagation();
    const { height: shown, max } = measure();
    setUsagePanelHeight(Math.min(max, shown + step));
    persistUsagePanelHeight();
  }

  function onDragEnd(e: ReactPointerEvent<HTMLButtonElement>) {
    const dragged = dragStartRef.current !== null;
    dragStartRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    // One write per gesture, not one per pointermove.
    if (dragged) persistUsagePanelHeight();
  }

  if (!open) return null;

  const now = Date.now();
  const reporting = providers.filter(hasNumbers);

  return (
    <section
      id="sidebar-usage-details"
      className="usage-panel"
      ref={panelRef}
      aria-label="Agent usage"
      /* One variable, not a height/max-height pair: the panel opens at this
         stored height every time, and the stylesheet owns how a short window
         trims it from there. */
      style={{ '--usage-panel-height': `${height}px` } as React.CSSProperties}
    >
      <header className="usage-head">
        <button
          className="usage-drag-handle"
          type="button"
          aria-label="Resize usage panel"
          title="Drag to resize"
          onPointerDown={onDragStart}
          onPointerMove={onDragMove}
          onPointerUp={onDragEnd}
          onPointerCancel={onDragEnd}
          onKeyDown={onDragKey}
        >
          <span aria-hidden="true" />
        </button>
        <span className="usage-title">
          <span className="usage-title-glyph" aria-hidden="true">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M4.8 15.5a8 8 0 1 1 14.4 0" />
              <path d="m12 12 4-4" />
              <circle cx="12" cy="12" r="1.25" fill="currentColor" stroke="none" />
            </svg>
          </span>
          Usage
          {lastFetchedAt > 0 && (
            <span className="usage-head-age">
              updated {relativeAge(lastFetchedAt / 1000, now)}
            </span>
          )}
        </span>
        <span className="usage-subtitle">Capacity across your coding agents</span>
        <div className="usage-head-actions">
          <LiveTicker
            intervalMs={PANEL_POLL_INTERVAL_MS}
            lastFetchedAt={lastFetchedAt}
            refreshing={loading}
            labelOnly
          />
          <button
            className="usage-close"
            onClick={closeUsagePanel}
            aria-label="Close usage"
            title="Close"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </header>

      {providers.length === 0 ? (
        <p className="usage-empty">
          No usage-capable agent CLI found. Install and sign in to Claude Code, Codex,
          Grok or Gemini and their limits will appear here.
        </p>
      ) : (
        <ul className="usage-list">
          {/* Reporting providers first — the ones with an answer lead. */}
          {[...providers]
            .sort((a, b) => Number(hasNumbers(b)) - Number(hasNumbers(a)))
            .map((provider) => (
              <ProviderRow
                key={provider.provider}
                provider={provider}
                now={now}
                accounts={accounts}
              />
            ))}
        </ul>
      )}

      {reporting.length === 0 && providers.length > 0 && (
        <p className="usage-empty">
          Nothing is reporting numbers right now. See each row above for why.
        </p>
      )}
    </section>
  );
}
