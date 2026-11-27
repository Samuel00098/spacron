import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '$lib/react/useStore';
import { AgentBrandMark } from '$lib/components/shared/useAgentBrand';
import {
  usageState,
  isUsagePanelOpen,
  closeUsagePanel,
  usagePanelHeight,
  setUsagePanelHeight,
  persistUsagePanelHeight,
  refreshUsage,
  severityOf,
  describeReset,
  USAGE_PANEL_MIN_HEIGHT,
  hasNumbers,
  type ProviderUsage,
  type UsageStatus,
} from '$lib/stores/usage';
import {
  accountsState,
  accountsFor,
  connectWebSession,
  refreshAccounts,
  isWebSessionProvider,
  type AccountsState,
} from '$lib/stores/agentAccounts';
import UsageMeter from './UsageMeter';
import AccountSwitcher from './AccountSwitcher';
import { openSettings } from '$lib/stores/layout';
import './UsagePanel.css';

const DRAG_KEY_STEP = 24;

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
  density,
  display,
  onOpen,
}: {
  provider: ProviderUsage;
  now: number;
  accounts: AccountsState;
  density: 'compact' | 'detailed';
  display: 'used' | 'left';
  onOpen: (provider: ProviderUsage, rect: DOMRect) => void;
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
  const headline = [...provider.windows].sort((a, b) => b.usedPercent - a.usedPercent)[0];
  const percent = headline ? Math.round(headline.usedPercent) : null;
  const reset = headline ? describeReset(headline, now)?.replace(/^resets in /, '') : null;

  return (
    <li className="usage-row" data-reporting={reporting ? 'true' : 'false'}>
      <div className="usage-row-head">
        <button className="usage-row-open" type="button" onClick={(event) => onOpen(provider, event.currentTarget.getBoundingClientRect())} aria-label={`Show ${provider.name} usage details`}>
          <span className="usage-row-mark" aria-hidden="true">
            <AgentBrandMark command={provider.command} name={provider.name} />
          </span>
          <span className="usage-row-name">{provider.name}</span>
          {provider.plan && <span className="usage-row-plan">{provider.plan}</span>}
          {reporting ? (
            <span className="usage-row-summary" data-severity={headline ? severityOf(headline.usedPercent) : undefined}>
              <span className="usage-row-reset" title={reset ? `Resets in ${reset}` : 'Reset time unavailable'}>{reset ?? '—'}</span>
              <span className="usage-row-mini-track" aria-hidden="true"><span style={{ width: `${Math.max(0, Math.min(100, percent ?? 0))}%` }} /></span>
              <span className="usage-row-percent">{display === 'used' ? percent : Math.max(0, 100 - (percent ?? 0))}%</span>
            </span>
          ) : (
            <span className="usage-row-summary unpopulated" aria-hidden="true">
              <span className="usage-row-reset">—</span>
              <span className="usage-row-mini-track"><span style={{ width: '0%' }} /></span>
              <span className="usage-row-percent">—%</span>
            </span>
          )}
        </button>
        <div className="usage-row-account-slot">
          <AccountSwitcher provider={provider.provider} accounts={accounts} />
        </div>
      </div>

      {/* The switcher already names the active account; repeating it here
          showed the same email twice. */}
      {provider.account && accountsFor(accounts, provider.provider).length === 0 && (
        <span className="usage-row-account">{provider.account}</span>
      )}

      {reporting ? density === 'detailed' ? (
        <>
          <div className="usage-row-meters">
            {provider.windows.map((window) => (
              <UsageMeter key={window.label} window={window} display={display} now={now} />
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
      ) : null : (
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
  const [density, setDensity] = useState<'compact' | 'detailed'>('compact');
  const [display, setDisplay] = useState<'used' | 'left'>('used');
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);
  const [detailPosition, setDetailPosition] = useState<{ top: number; left: number } | null>(null);
  const [panelPosition, setPanelPosition] = useState<{ top: number; left: number } | null>(null);
  const [sortDescending, setSortDescending] = useState(true);

  // Accounts and linked sessions change far less often than the meters, so they
  // load when the panel opens rather than on the usage poll.
  useEffect(() => {
    if (open) void refreshAccounts();
  }, [open]);

  // Placed before the first paint: a passive effect let one frame show at the
  // stylesheet's top-left default before the panel jumped down to the footer.
  useLayoutEffect(() => {
    if (!open) return;
    const placePanel = () => {
      const rect = document.querySelector<HTMLElement>('[data-usage-toggle]')?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(440, window.innerWidth - 24);
      const panelHeight = Math.min(Math.max(height, 420), window.innerHeight - 24);
      setPanelPosition({
        top: Math.max(12, rect.top - panelHeight - 8),
        left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
      });
    };
    placePanel();
    window.addEventListener('resize', placePanel);
    window.addEventListener('scroll', placePanel, true);
    return () => {
      window.removeEventListener('resize', placePanel);
      window.removeEventListener('scroll', placePanel, true);
    };
  }, [open, height]);

  // Inline disclosure, not modal — must not trap Tab or swallow app shortcuts.
  // Escape and outside-click still collapse it so it behaves naturally beside
  // the footer trigger without becoming a separate floating surface.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (selectedProviderId) setSelectedProviderId(null);
        else closeUsagePanel();
      }
    }
    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node | null;
      const element = target instanceof Element ? target : null;
      if (element?.closest('[data-usage-detail], [data-usage-detail-trigger]')) return;
      setSelectedProviderId(null);
      if (panelRef.current?.contains(target ?? null)) return;
      // The counter toggles on its own click; ignoring it here stops the two
      // handlers cancelling each other into a no-op.
      if (element?.closest('[data-usage-toggle]')) return;
      closeUsagePanel();
    }
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [open, selectedProviderId]);

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
    return { height: shown, max: Math.max(USAGE_PANEL_MIN_HEIGHT, window.innerHeight - 24) };
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

  function openProviderDetails(provider: ProviderUsage, row: DOMRect) {
    const panel = panelRef.current?.getBoundingClientRect();
    const width = Math.min(420, window.innerWidth - 24);
    const left = Math.min((panel?.right ?? row.right) + 10, window.innerWidth - width - 12);
    const top = Math.max(12, Math.min(row.top - 48, window.innerHeight - 480));
    setDetailPosition({ top, left: Math.max(12, left) });
    setSelectedProviderId(provider.provider);
  }

  if (!open) return null;

  const now = Date.now();
  const reporting = providers.filter(hasNumbers);
  const sortedProviders = [...providers].sort((a, b) => {
    const reportingOrder = Number(hasNumbers(b)) - Number(hasNumbers(a));
    if (reportingOrder !== 0) return reportingOrder;
    const aUsed = Math.max(0, ...a.windows.map((window) => window.usedPercent));
    const bUsed = Math.max(0, ...b.windows.map((window) => window.usedPercent));
    const aValue = display === 'used' ? aUsed : 100 - aUsed;
    const bValue = display === 'used' ? bUsed : 100 - bUsed;
    return (sortDescending ? bValue - aValue : aValue - bValue) || a.name.localeCompare(b.name);
  });
  const selectedProvider = providers.find((provider) => provider.provider === selectedProviderId) ?? null;
  const selectedAccounts = selectedProvider ? accountsFor(accounts, selectedProvider.provider) : [];

  const panel = (
    <section
      id="sidebar-usage-details"
      className="usage-panel"
      ref={panelRef}
      aria-label="Agent usage"
      /* One variable, not a height/max-height pair: the panel opens at this
         stored height every time, and the stylesheet owns how a short window
         trims it from there. */
      style={{ '--usage-panel-height': `${height}px`, ...(panelPosition ?? {}) } as React.CSSProperties}
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
        <div className="usage-toolbar">
          <div className="usage-toolbar-title">
            <span>Usage</span><span className="usage-toolbar-separator">·</span><span className="usage-toolbar-scope">all agents</span>
            <button className="usage-refresh" type="button" onClick={() => void refreshUsage(true)} disabled={loading} aria-label="Refresh usage" title={lastFetchedAt ? `Updated ${relativeAge(lastFetchedAt / 1000, now)} · refresh now` : 'Refresh usage'}>
              <svg className={loading ? 'is-spinning' : undefined} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M20 7v5h-5M4 17v-5h5" /><path d="M5.6 9A7 7 0 0 1 18 6l2 2M4 16l2 2a7 7 0 0 0 12.4-3" />
              </svg>
            </button>
          </div>
          <button className="usage-sort" type="button" onClick={() => { setDisplay((value) => value === 'used' ? 'left' : 'used'); setSortDescending(true); }} aria-label={`Show ${display === 'used' ? 'remaining' : 'used'} usage`} title="Switch between used and remaining usage">
            {display === 'used' ? 'Used' : 'Left'} <span aria-hidden="true">↕</span>
          </button>
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
        <div className="usage-density" role="group" aria-label="Usage display density">
          <button type="button" className={density === 'detailed' ? 'active' : undefined} aria-pressed={density === 'detailed'} onClick={() => setDensity('detailed')}>Detailed</button>
          <button type="button" className={density === 'compact' ? 'active' : undefined} aria-pressed={density === 'compact'} onClick={() => setDensity('compact')}>Compact</button>
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
          {sortedProviders.map((provider) => (
              <ProviderRow
                key={provider.provider}
                provider={provider}
                now={now}
                accounts={accounts}
                density={density}
                display={display}
                onOpen={openProviderDetails}
              />
          ))}
        </ul>
      )}

      {reporting.length === 0 && providers.length > 0 && (
        <p className="usage-empty">
          Nothing is reporting numbers right now. See each row above for why.
        </p>
      )}
      <footer className="usage-panel-footer">
        <button type="button" onClick={() => { closeUsagePanel(); openSettings('stats'); }}>
          Usage details &amp; history <span aria-hidden="true">›</span>
        </button>
        <button type="button" onClick={() => { closeUsagePanel(); openSettings('models'); }}>
          Manage Accounts… <span aria-hidden="true">›</span>
        </button>
      </footer>
      {selectedProvider && detailPosition && typeof document !== 'undefined' && createPortal(
        <aside
          className="usage-detail-popover"
          data-usage-detail
          role="dialog"
          aria-label={`${selectedProvider.name} usage details`}
          style={{ top: detailPosition.top, left: detailPosition.left }}
        >
          <header className="usage-detail-head">
            <span className="usage-detail-mark"><AgentBrandMark command={selectedProvider.command} name={selectedProvider.name} /></span>
            <span className="usage-detail-provider">{selectedProvider.name}{selectedProvider.plan ? ` · ${selectedProvider.plan}` : ''}</span>
            <span className="usage-detail-updated">{lastFetchedAt > 0 ? `Updated ${relativeAge(lastFetchedAt / 1000, now)}` : ''}</span>
            <button className="usage-detail-close" type="button" onClick={() => setSelectedProviderId(null)} aria-label="Close usage details">×</button>
          </header>
          {selectedProvider.account && <p className="usage-detail-account-label">{selectedProvider.account}</p>}
          {hasNumbers(selectedProvider) ? (
            <div className="usage-detail-meters">
              {selectedProvider.windows.map((window) => <UsageMeter key={window.label} window={window} display={display} now={now} />)}
              {selectedProvider.note && <p className="usage-row-note">{selectedProvider.note}</p>}
            </div>
          ) : (
            <p className="usage-detail-status">{selectedProvider.error ?? selectedProvider.note ?? (selectedProvider.status === 'ok' ? 'No usage data available' : STATUS_NOTE[selectedProvider.status])}</p>
          )}
          {selectedProvider.resetCreditsAvailable != null && (
            <details className="usage-row-credits usage-detail-credits">
              <summary>{selectedProvider.resetCreditsAvailable === 0 ? 'No reset credits available' : `${selectedProvider.resetCreditsAvailable} reset credits`}</summary>
              {selectedProvider.resetCredits.length > 0 && (
                <ul className="usage-row-credit-list">
                  {selectedProvider.resetCredits.map((credit) => <li key={credit.id}><span>{credit.resetType ?? 'Rate-limit reset'}</span><span>{describeCreditExpiry(credit.expiresAtIso, now)}</span></li>)}
                </ul>
              )}
            </details>
          )}
          {selectedAccounts.length > 0 && (
            <section className="usage-detail-accounts">
              <div className="usage-detail-section-head"><span aria-hidden="true" /><span>Accounts</span><span>{display === 'used' ? 'Used' : 'Left'}</span></div>
              {selectedAccounts.map((account) => (
                <div className={`usage-detail-account${account.active ? ' active' : ''}`} key={account.id}>
                  <span aria-hidden="true">{account.active ? '✓' : ''}</span>
                  <span>{account.id === 'default' ? 'System default' : account.label}</span>
                  {account.active && <span>{Math.round(display === 'used' ? Math.max(0, ...selectedProvider.windows.map((window) => window.usedPercent)) : Math.min(100, ...selectedProvider.windows.map((window) => 100 - window.usedPercent)))}%</span>}
                </div>
              ))}
              <div className="usage-detail-manage"><button type="button" className="usage-detail-manage-link" onClick={() => { setSelectedProviderId(null); closeUsagePanel(); openSettings('models'); }}>Manage Accounts…</button><AccountSwitcher provider={selectedProvider.provider} accounts={accounts} /></div>
            </section>
          )}
        </aside>,
        document.body,
      )}
    </section>
  );
  return typeof document !== 'undefined' ? createPortal(panel, document.body) : null;
}
