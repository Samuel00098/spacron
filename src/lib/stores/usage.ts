/**
 * Agent usage & rate-limit meters.
 *
 * Answers "why did my agent stop?" before it gets asked. The numbers come from
 * each signed-in CLI's own usage endpoint, read in Rust
 * (`src-tauri/src/commands/usage.rs`) so no access token ever reaches the
 * webview — the backend returns percentages and reset times, never credentials.
 *
 * This module owns the *schedule*; Rust owns the fetching and a 30s freshness
 * cache. Polling lives here rather than in a Rust background task for one
 * reason: the webview knows when it is hidden. A meter nobody is looking at
 * should not spend the user's rate limit checking on their rate limit, and
 * `document.hidden` is the cheapest honest signal for that.
 */

import { writable, get } from '$lib/stores/storeCompat';
import { isTauriRuntime } from '$lib/utils/tauri';

/**
 * Live cadence for every visible usage surface. The footer is always visible
 * inside a project, so it must not wait for the disclosure to open before its
 * numbers advance. Rust keeps the provider result cached for this same window,
 * preventing duplicate consumers from multiplying network requests.
 */
const POLL_INTERVAL_MS = 30 * 1000;

/**
 * Cadence while the usage panel itself is open. It deliberately matches the
 * background footer cadence now, so opening the details changes presentation,
 * not whether the underlying reading stays live.
 *
 * Paired with `CACHE_TTL` in `src-tauri/src/commands/usage.rs`, which is held at
 * 30s to match. Raising that TTL above this interval makes the extra ticks
 * no-ops rather than refreshes; lowering this interval below it does nothing at
 * all without lowering the TTL too.
 */
export const PANEL_POLL_INTERVAL_MS = 30 * 1000;

/**
 * Re-poll this soon after the window regains focus, if the last reading is
 * older. Coming back to the app is exactly when a stale meter is most likely to
 * be wrong and most likely to be looked at.
 */
const REFOCUS_STALE_MS = POLL_INTERVAL_MS;

/** Percentage at or above which a window is worth surfacing on the titlebar. */
export const WARN_PERCENT = 75;
export const CRITICAL_PERCENT = 95;

export type UsageStatus =
  | 'notInstalled'
  | 'signedOut'
  | 'expired'
  /**
   * Meters through a linked browser session (see `agentAccounts.ts`) and none
   * is linked yet. Distinct from `signedOut`: the user may well be signed in to
   * the CLI and still see this, and "log in" is the wrong advice for it.
   */
  | 'notConnected'
  | 'unsupported'
  | 'error'
  | 'ok';

export interface UsageWindow {
  label: string;
  usedPercent: number;
  windowMinutes: number | null;
  /** Anthropic hands back an ISO string… */
  resetsAtIso: string | null;
  /** …and OpenAI hands back unix seconds. Use `resetAtMs` rather than either. */
  resetsAtEpochSecs: number | null;
}

export interface ResetCredit {
  id: string;
  resetType: string | null;
  expiresAtIso: string | null;
}

export interface ProviderUsage {
  provider: string;
  /** Join key to `AI_AGENT_PRESETS` — drives the row's brand mark. */
  command: string;
  name: string;
  status: UsageStatus;
  plan: string | null;
  account: string | null;
  windows: UsageWindow[];
  resetCreditsAvailable: number | null;
  resetCredits: ResetCredit[];
  error: string | null;
  /** A non-failure explanation for an empty reading, e.g. "no metered limit". */
  note: string | null;
  fetchedAt: number;
}

export interface DetectedAgent {
  provider: string;
  command: string;
  name: string;
  installed: boolean;
  /**
   * Only meaningful when `detectsSignIn` is true. When that is false this is
   * always false and means "unknown", not "signed out".
   */
  signedIn: boolean;
  /** Whether sign-in is knowable — false for CLIs that use the OS keychain. */
  detectsSignIn: boolean;
  supportsUsage: boolean;
}

export interface UsageState {
  providers: ProviderUsage[];
  detected: DetectedAgent[];
  loading: boolean;
  /** Unix ms of the last completed refresh, or 0 if none has finished. */
  lastFetchedAt: number;
}

/**
 * Commands the detection scan found on PATH — the "installed" set.
 *
 * Every surface that offers agents (spawn picker, orchestrator run presets,
 * MCP delegate roster) filters through this, so it lives here as the single
 * source of truth rather than being re-derived in each caller.
 */
export function installedAgentCommands(state: UsageState): Set<string> {
  return new Set(state.detected.filter((d) => d.installed).map((d) => d.command));
}

/**
 * Whether the installed-command filter should apply at all.
 *
 * False inside a browser (no scan ever runs there) and before the first scan
 * completes — or after one fails, since `lastFetchedAt` is only bumped on
 * success. While false, surfaces fall back to their full roster rather than
 * hiding agents on a detection hiccup.
 */
export function haveAgentDetection(state: UsageState): boolean {
  return isTauriRuntime() && state.lastFetchedAt > 0;
}

export const usageState = writable<UsageState>({
  providers: [],
  detected: [],
  loading: false,
  lastFetchedAt: 0,
});

export const isUsagePanelOpen = writable(false);

/**
 * How tall the usage disclosure opens, in px.
 *
 * A stored preference rather than a per-open measurement, for two reasons.
 * The panel used to open at whatever height its contents and the project tree
 * left over, so it was a different size every time — and, because the tree's
 * flex basis is its own content, usually a size too short to show one agent's
 * meters whole. And the drag handle's result used to be thrown away on close,
 * so a user who sized it once had to size it again on the next open.
 *
 * Global, not per-workspace: "how much of the rail is this readout worth" is a
 * fact about the person, not about the project they happen to have open.
 */
const USAGE_HEIGHT_KEY = 'spacron_usage_panel_height';

/** Tall enough for one provider's header and both of its meters, unclipped. */
export const USAGE_PANEL_DEFAULT_HEIGHT = 320;
export const USAGE_PANEL_MIN_HEIGHT = 132;
export const USAGE_PANEL_MAX_HEIGHT = 900;

export function clampUsagePanelHeight(px: number): number {
  if (!Number.isFinite(px)) return USAGE_PANEL_DEFAULT_HEIGHT;
  return Math.round(Math.max(USAGE_PANEL_MIN_HEIGHT, Math.min(USAGE_PANEL_MAX_HEIGHT, px)));
}

function storedUsagePanelHeight(): number {
  try {
    const raw = localStorage.getItem(USAGE_HEIGHT_KEY);
    if (raw == null) return USAGE_PANEL_DEFAULT_HEIGHT;
    return clampUsagePanelHeight(Number(raw));
  } catch {
    return USAGE_PANEL_DEFAULT_HEIGHT;
  }
}

export const usagePanelHeight = writable(storedUsagePanelHeight());

/** Live update while the handle is moving — cheap, and not written to disk. */
export function setUsagePanelHeight(px: number) {
  usagePanelHeight.set(clampUsagePanelHeight(px));
}

/** Called once when a resize gesture ends, so a drag is one write, not sixty. */
export function persistUsagePanelHeight() {
  try {
    localStorage.setItem(USAGE_HEIGHT_KEY, String(get(usagePanelHeight)));
  } catch {
    /* private mode / quota — the height still holds for this session */
  }
}

export function toggleUsagePanel() {
  isUsagePanelOpen.update((open) => !open);
  // Opening the panel is a deliberate "tell me now", so top up anything stale.
  if (get(isUsagePanelOpen)) void refreshUsage();
}

export function closeUsagePanel() {
  isUsagePanelOpen.set(false);
}

/**
 * Resolve a window's reset instant to unix ms, whichever form the provider used.
 *
 * Kept here rather than in Rust deliberately: unifying an ISO-8601 string and a
 * unix integer needs a real date parser, and the webview already has a correct
 * one. Adding a date crate to the backend to duplicate `Date.parse` would be
 * the more expensive half of a trade with no upside.
 */
export function resetAtMs(window: UsageWindow): number | null {
  if (window.resetsAtEpochSecs != null) return window.resetsAtEpochSecs * 1000;
  if (window.resetsAtIso) {
    const parsed = Date.parse(window.resetsAtIso);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

/** "resets in 2h 14m" / "resets in 3d". Null when the provider gave no reset. */
export function describeReset(window: UsageWindow, now = Date.now()): string | null {
  const at = resetAtMs(window);
  if (at == null) return null;
  const mins = Math.round((at - now) / 60000);
  if (mins <= 0) return 'resets now';
  if (mins < 60) return `resets in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    const rest = mins % 60;
    return rest ? `resets in ${hours}h ${rest}m` : `resets in ${hours}h`;
  }
  return `resets in ${Math.floor(hours / 24)}d`;
}

/**
 * A window's length as a two-or-three character suffix: `5h`, `wk`, `mo`.
 *
 * This is what makes a bare percentage mean something. "100%" alone reads like
 * a full tank; "100% mo" says which allowance is gone and implies when it comes
 * back. Derived from the window's real length where the provider states one,
 * and from the distance to its reset otherwise — Gemini labels its buckets by
 * model and gives no length at all.
 */
export function shortWindowLabel(window: UsageWindow, now = Date.now()): string | null {
  let minutes = window.windowMinutes;

  if (minutes == null) {
    const at = resetAtMs(window);
    if (at == null) return null;
    minutes = Math.max(1, Math.round((at - now) / 60000));
  }

  if (minutes <= 90) return `${Math.max(1, Math.round(minutes / 60))}h`;
  const hours = Math.round(minutes / 60);
  // Below a day stays in hours; a full day reads better as "1d" than "24h",
  // which is what a daily quota bucket resolves to.
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days <= 1) return '1d';
  if (days <= 10) return days === 7 ? 'wk' : `${days}d`;
  if (days <= 45) return 'mo';
  return `${Math.round(days / 30)}mo`;
}

/**
 * The worst window per provider, ordered most-constrained first.
 *
 * This is what the titlebar renders. Showing one anonymous number across all
 * providers was ambiguous in both directions — it hid which agent was
 * constrained, and a lone "100%" read as "full" rather than "spent".
 */
export function providerHeadlines(
  providers: ProviderUsage[]
): { provider: ProviderUsage; windows: UsageWindow[] }[] {
  return providers
    .filter(hasNumbers)
    .map((provider) => ({
      provider,
      // Most-used first, so the constraint leads and a second window can be
      // dropped without hiding the number that matters.
      windows: [...provider.windows].sort((a, b) => b.usedPercent - a.usedPercent),
    }))
    .sort((a, b) => (b.windows[0]?.usedPercent ?? 0) - (a.windows[0]?.usedPercent ?? 0));
}

/**
 * The single window most worth showing: the highest percentage across every
 * provider reporting real numbers. Drives the chip's severity colour and the
 * accessible label.
 */
export function peakWindow(
  providers: ProviderUsage[]
): { provider: ProviderUsage; window: UsageWindow } | null {
  let peak: { provider: ProviderUsage; window: UsageWindow } | null = null;
  for (const provider of providers) {
    if (provider.status !== 'ok') continue;
    for (const window of provider.windows) {
      if (!peak || window.usedPercent > peak.window.usedPercent) {
        peak = { provider, window };
      }
    }
  }
  return peak;
}

/** Severity band for a percentage, used for the meter colour and the badge. */
export function severityOf(percent: number): 'normal' | 'warn' | 'critical' {
  if (percent >= CRITICAL_PERCENT) return 'critical';
  if (percent >= WARN_PERCENT) return 'warn';
  return 'normal';
}

/**
 * True when a provider is signed in and holding real numbers. Anything else —
 * not installed, signed out, expired, unreadable — is a different state and the
 * UI has to say which, rather than rendering an empty bar that reads as "0%".
 */
export function hasNumbers(provider: ProviderUsage): boolean {
  return provider.status === 'ok' && provider.windows.length > 0;
}

/**
 * The providers worth listing: the CLIs that are actually on this machine.
 *
 * A `notInstalled` row answers no question anyone asked the usage popup — it
 * is there only because Rust reports every provider it knows about — so it is
 * dropped here, at the single choke point every consumer reads from. That is
 * also what makes an uninstall *disappear*: the next refresh re-scans PATH,
 * the row flips to `notInstalled`, and the filter removes it before the UI
 * ever sees it.
 */
export function installedProviders(providers: ProviderUsage[]): ProviderUsage[] {
  return providers.filter((provider) => provider.status !== 'notInstalled');
}

let inFlight: Promise<void> | null = null;

/**
 * Refresh every provider. Concurrent callers share one request — the panel, the
 * titlebar and the settings tab all subscribe to this store and would otherwise
 * each kick off their own fetch on mount.
 */
export async function refreshUsage(force = false): Promise<void> {
  if (!isTauriRuntime()) return;
  if (inFlight) {
    if (!force) return inFlight;
    await inFlight;
  }

  inFlight = (async () => {
    usageState.update((s) => ({ ...s, loading: true }));
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const [providers, detected] = await Promise.all([
        invoke<ProviderUsage[]>('usage_fetch_all', { force }),
        // Force reaches the Rust side too, where it bypasses the memoized
        // sign-in probes — a forced scan is a deliberate "tell me now".
        invoke<DetectedAgent[]>('usage_detect_agents', { force }),
      ]);
      usageState.set({
        providers: installedProviders(providers),
        detected,
        loading: false,
        lastFetchedAt: Date.now(),
      });
    } catch (err) {
      // A failed refresh must not wipe the numbers already on screen — Rust
      // already falls back to its last good reading per provider, so the worst
      // case here is that the display simply doesn't advance.
      console.error('[usage] refresh failed', err);
      usageState.update((s) => ({ ...s, loading: false }));
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

let pollTimer: ReturnType<typeof setInterval> | null = null;
let listenersBound = false;

/**
 * Begin background polling. Idempotent — safe to call from any mount.
 *
 * Skips a tick while the window is hidden and catches up on focus instead, so a
 * backgrounded Spacron isn't quietly spending the user's quota all day.
 */
export function startUsagePolling(): void {
  if (!isTauriRuntime() || pollTimer) return;

  // The first visible reading should be current immediately, even if another
  // surface populated Rust's short cache just before this footer mounted.
  void refreshUsage(true);

  pollTimer = setInterval(() => {
    if (typeof document !== 'undefined' && document.hidden) return;
    void refreshUsage();
  }, POLL_INTERVAL_MS);

  if (!listenersBound && typeof document !== 'undefined') {
    listenersBound = true;
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      const { lastFetchedAt } = get(usageState);
      if (Date.now() - lastFetchedAt > REFOCUS_STALE_MS) void refreshUsage();
    });
  }
}

export function stopUsagePolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
