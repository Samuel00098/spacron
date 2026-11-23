import { writable, derived, get } from '$lib/stores/storeCompat';
import { invoke } from '@tauri-apps/api/core';
import { isTauriRuntime } from '$lib/utils/tauri';
// Static, not dynamic: pty-bridge.ts and backend.ts already import this module
// statically, so the `await import(...)` never split it into a separate chunk —
// it just deferred the connection helpers behind an async hop for nothing.
import {
  ensureRemoteConnected,
  closeRemoteConnection,
} from '$lib/services/pty-bridge-remote';

// Remote-workspace connection state (Step 4 of docs/remote-workspace.md — the
// "Connection UX"). This grew out of the Step 1 spike's single devtools-set
// target into a small "workspaces" model: a persisted list of saved remotes
// (plus the implicit Local default), one active connection at a time, and a
// live connection status the UI surfaces.
//
// The rest of the app still consumes exactly one thing — `remoteTarget`, the
// active connection's `{ url, token }` or null for Local. It's a *derived* store
// here (was a writable in the spike) so backend.ts / pty-bridge(-remote).ts /
// lsp/client.ts keep working unchanged: both `get(remoteTarget)` and
// `remoteTarget.subscribe(...)` behave identically.
//
// Token handling (security): the token unlocks a shell on the remote box, so it
// is deliberately NOT persisted in localStorage with the rest of the connection
// list. It lives in the OS keychain (`remote_token_set/get` commands) and is
// held in session memory only — see `tokenCache` below.

/** A saved remote target. `url` is the `/pty` WebSocket endpoint; `token` is the
 *  pre-shared server token (offered as a `token.<TOKEN>` subprotocol). */
export type RemoteConnection = {
  id: string;
  name: string;
  url: string;
  token: string;
  /** Opt-in: auto-dial this remote on app startup so a workspace whose agents are
   *  still running on the box comes back on its own — "close the laptop, reopen,
   *  they're still there." At most one remote carries this flag. Default off, so
   *  the app still boots Local unless the user asks for this. */
  reconnectOnStartup?: boolean;
};

/** Just the transport coordinates the lower layers need. */
export type RemoteTarget = { url: string; token: string };

/**
 * Lifecycle of the active connection, driven by `pty-bridge-remote`'s socket:
 *   - `disconnected` — Local mode, or a remote selected but not yet dialed.
 *   - `connecting`   — first dial of a freshly selected remote.
 *   - `connected`    — socket open, workspace attached.
 *   - `reconnecting` — socket dropped (sleep/network blip); backing off + retrying.
 *   - `error`        — gave up after repeated failures; user can retry.
 */
export type ConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'error';

const CONNECTIONS_KEY = 'spacron_remote_connections';
// Legacy single-target key from the Step 1 spike; migrated on first load.
const LEGACY_TARGET_KEY = 'spacron_remote_workspace';

// Plaintext tokens found in persisted data written by older builds. They are
// moved into the OS keychain on first hydrate and never stored again.
const pendingLegacyTokens = new Map<string, string>();

function safeConnection(raw: unknown): RemoteConnection | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.url !== 'string') return null;
  const id = typeof r.id === 'string' && r.id ? r.id : newId();
  const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim() : hostLabel(r.url);
  const legacyToken = typeof r.token === 'string' ? r.token.trim() : '';
  if (legacyToken) pendingLegacyTokens.set(id, legacyToken);
  // `token` starts empty in the store; hydrateRemoteTokens() fills it from the
  // OS keychain. It is never read back from localStorage.
  return {
    id,
    name,
    url: r.url,
    token: '',
    reconnectOnStartup: r.reconnectOnStartup === true,
  };
}

function loadConnections(): RemoteConnection[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(CONNECTIONS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map(safeConnection).filter((c): c is RemoteConnection => c !== null);
      }
    }
    // Migrate the spike's single `{ url, token }` target into the new list.
    const legacy = localStorage.getItem(LEGACY_TARGET_KEY);
    if (legacy) {
      const migrated = safeConnection(JSON.parse(legacy));
      if (migrated) {
        localStorage.setItem(CONNECTIONS_KEY, JSON.stringify([migrated]));
        localStorage.removeItem(LEGACY_TARGET_KEY);
        return [migrated];
      }
    }
  } catch {
    /* fall through to empty */
  }
  return [];
}

/** Human label for a target (`host:port`), used when the user leaves name blank. */
export function hostLabel(url: string): string {
  try {
    const u = new URL(url);
    return u.port ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    return url;
  }
}

function newId(): string {
  return `conn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** In-session token cache, hydrated from the OS keychain. Tokens never touch
 *  localStorage — the keychain is the only durable store
 *  (`remote_token_set/get` in `src-tauri/src/commands/secrets.rs`). */
const tokenCache = new Map<string, string>();
let hydratePromise: Promise<void> | null = null;

/** What gets persisted: everything except the token. */
function stripToken(c: RemoteConnection) {
  return { id: c.id, name: c.name, url: c.url, reconnectOnStartup: c.reconnectOnStartup };
}

/** Load one connection's token from the keychain into session memory. Throws if
 *  the keychain read fails so callers can decide how to surface it. */
async function hydrateToken(id: string): Promise<void> {
  if (tokenCache.has(id)) return;
  if (!isTauriRuntime()) {
    tokenCache.set(id, '');
    return;
  }
  const token = (await invoke<string | null>('remote_token_get', { id })) ?? '';
  tokenCache.set(id, token);
  remoteConnections.update((list) => list.map((c) => (c.id === id ? { ...c, token } : c)));
}

/**
 * Load every saved remote's token from the keychain into session memory, and
 * migrate any plaintext tokens left in localStorage by older builds. Safe to
 * call repeatedly; one in-flight hydration is shared by all callers.
 */
export async function hydrateRemoteTokens(): Promise<void> {
  if (hydratePromise) return hydratePromise;
  hydratePromise = (async () => {
    const list = get(remoteConnections);
    for (const [id, token] of pendingLegacyTokens) {
      try {
        await invoke('remote_token_set', { id, token });
        tokenCache.set(id, token);
        remoteConnections.update((l) => l.map((c) => (c.id === id ? { ...c, token } : c)));
      } catch (err) {
        // Keychain write failed — keep the token for this session only and
        // retry the migration on the next launch.
        console.error('[remoteWorkspace] Failed to migrate remote token to the keychain:', err);
        tokenCache.set(id, token);
      }
    }
    pendingLegacyTokens.clear();
    await Promise.all(list.map((c) => hydrateToken(c.id)));
  })();
  return hydratePromise;
}

/** A remote's token for this session, loading it from the keychain if needed. */
export async function getRemoteToken(id: string): Promise<string> {
  try {
    await hydrateToken(id);
  } catch {
    /* keychain unavailable — treat as no token */
  }
  return tokenCache.get(id) ?? '';
}

async function setRemoteToken(id: string, token: string): Promise<void> {
  await invoke('remote_token_set', { id, token });
}

/** Saved remotes (persisted). The implicit "Local" option isn't in this list. */
export const remoteConnections = writable<RemoteConnection[]>(loadConnections());

/** id of the active remote, or null for Local. Not persisted: the app always
 *  boots in Local mode and the user connects explicitly (a box may be offline,
 *  and we don't want a broken half-connected startup). */
export const activeRemoteId = writable<string | null>(null);

/** Live connection status, published by `pty-bridge-remote`'s socket lifecycle. */
export const connectionStatus = writable<ConnectionStatus>('disconnected');

if (typeof window !== 'undefined') {
  remoteConnections.subscribe((list) => {
    try {
      // Tokens are never persisted here — the OS keychain owns them.
      localStorage.setItem(CONNECTIONS_KEY, JSON.stringify(list.map(stripToken)));
    } catch {
      /* ignore persistence failures */
    }
  });
}

/** The active connection object, or null for Local. */
export const activeConnection = derived(
  [remoteConnections, activeRemoteId],
  ([list, id]) => (id ? list.find((c) => c.id === id) ?? null : null),
);

/** The transport coordinates for the active remote, or null for Local. This is
 *  the single seam the rest of the app reads. */
export const remoteTarget = derived(
  activeConnection,
  (conn): RemoteTarget | null => (conn ? { url: conn.url, token: conn.token } : null),
);

// ── CRUD ────────────────────────────────────────────────────────────────────

/** Add a saved remote and return its generated id. The token is written to the
 *  OS keychain first; if that fails the remote is not added. */
export async function addRemoteConnection(input: {
  name?: string;
  url: string;
  token: string;
}): Promise<string> {
  const id = newId();
  const conn: RemoteConnection = {
    id,
    name: input.name?.trim() || hostLabel(input.url),
    url: input.url.trim(),
    token: input.token.trim(),
  };
  await setRemoteToken(id, conn.token);
  tokenCache.set(id, conn.token);
  remoteConnections.update((list) => [...list, conn]);
  return id;
}

export async function updateRemoteConnection(
  id: string,
  patch: Partial<Omit<RemoteConnection, 'id'>>,
) {
  const rest: Partial<Omit<RemoteConnection, 'id' | 'token'>> = { ...patch };
  const nextToken = typeof patch.token === 'string' ? patch.token.trim() : null;
  if (nextToken) {
    await setRemoteToken(id, nextToken);
    tokenCache.set(id, nextToken);
  }
  remoteConnections.update((list) =>
    list.map((c) =>
      c.id === id
        ? {
            ...c,
            ...rest,
            ...(nextToken ? { token: nextToken } : {}),
            name: (patch.name ?? c.name).trim() || hostLabel(patch.url ?? c.url),
          }
        : c,
    ),
  );
}

export async function removeRemoteConnection(id: string) {
  // Disconnecting first keeps us from leaving a live socket pointed at a target
  // that no longer exists.
  if (get(activeRemoteId) === id) void disconnectRemote();
  remoteConnections.update((list) => list.filter((c) => c.id !== id));
  tokenCache.delete(id);
  try {
    await invoke('remote_token_delete', { id });
  } catch (err) {
    console.error(`[remoteWorkspace] Failed to remove keychain token for ${id}:`, err);
  }
}

export function setConnectionStatus(status: ConnectionStatus) {
  connectionStatus.set(status);
}

/**
 * Flag (or unflag) a remote to auto-reconnect on startup. At most one remote can
 * carry the flag — one active workspace at a time — so setting it on one clears
 * it on the rest.
 */
export function setReconnectOnStartup(id: string, value: boolean) {
  remoteConnections.update((list) =>
    list.map((c) => ({
      ...c,
      reconnectOnStartup: c.id === id ? value : value ? false : c.reconnectOnStartup,
    })),
  );
}

/**
 * True while the reverse tunnel that gives agents on the box the Spacron MCP
 * server is up (`remote_tunnel_open_mcp`). Agents there can then report their
 * own status, so inferred pauses no longer need to stand in for them.
 */
export const remoteMcpTunnelOpen = writable(false);

/** Open the MCP tunnel for the active remote. Failure is reported, not fatal:
 *  terminals and files still work, agents just lose the Spacron tools. */
async function openMcpTunnel(conn: RemoteConnection): Promise<void> {
  try {
    const { getMcpPort } = await import('./mcpBridge');
    const mcpPort = await getMcpPort();
    await invoke('remote_tunnel_open_mcp', { url: conn.url, token: conn.token, mcpPort });
    remoteMcpTunnelOpen.set(true);
  } catch (err) {
    remoteMcpTunnelOpen.set(false);
    console.warn('[remoteWorkspace] MCP tunnel unavailable:', err);
    const { showToast } = await import('./notification');
    showToast(`Agents on ${conn.name} won't have Spacron tools: ${(err as Error)?.message ?? String(err)}`, 'warning', 8000);
  }
}

function closeTunnels(): void {
  remoteMcpTunnelOpen.set(false);
  void invoke('remote_tunnel_close_all').catch(() => { /* nothing was open */ });
}

/** The remote flagged to auto-reconnect on startup, if any. */
export function startupRemote(): RemoteConnection | null {
  return get(remoteConnections).find((c) => c.reconnectOnStartup) ?? null;
}

// ── Connect / disconnect ──────────────────────────────────────────────────────

/**
 * Make a saved remote active and point the workspace at it. Setting
 * `activeRemoteId` flips `remoteTarget`, so every file op / terminal / LSP call
 * starts routing over the socket; `openRemoteRoot()` then opens a project at the
 * server's workspace root so the file tree and editor follow. The socket itself
 * connects lazily on the first call — `pty-bridge-remote` owns the status and
 * reconnect lifecycle from there.
 */
export async function connectRemote(id: string): Promise<void> {
  const conn = get(remoteConnections).find((c) => c.id === id);
  if (!conn) return;
  if (get(activeRemoteId) === id) return;

  // The token lives in the OS keychain; load it into session memory before
  // dialing so the WS handshake has a token to present.
  try {
    await hydrateToken(id);
  } catch (err) {
    connectionStatus.set('disconnected');
    const { showToast } = await import('./notification');
    showToast(
      `Couldn't read the saved token for ${conn.name}: ${(err as Error)?.message ?? String(err)}`,
      'error',
      6000,
    );
    return;
  }

  connectionStatus.set('connecting');
  // Flip `remoteTarget` first so the dial + `workspace_info` route to this remote.
  activeRemoteId.set(id);
  try {
    // Fail fast if the box is unreachable rather than hanging; the socket sets
    // status to 'connected' once open.
    await ensureRemoteConnected();
    const workspace = await import('./workspace');
    await workspace.openRemoteRoot(conn);
    void openMcpTunnel({ ...conn, token: tokenCache.get(id) ?? conn.token });
    // Refresh the box's run times: it only knows about two weeks ahead.
    void import('$lib/services/automations/automations')
      .then(({ syncBoxAutomations }) => syncBoxAutomations())
      .catch((err) => console.warn('[remoteWorkspace] Could not sync automations to the box:', err));
    void import('$lib/services/bots/bots')
      .then(({ syncBots }) => syncBots())
      .catch((err) => console.warn('[remoteWorkspace] Could not sync bots to the box:', err));
  } catch (err) {
    console.error('Failed to connect to remote workspace:', err);
    // Roll back cleanly to Local so we don't leave a half-connected state.
    closeRemoteConnection();
    activeRemoteId.set(null);
    connectionStatus.set('disconnected');
    const { showToast } = await import('./notification');
    showToast(
      `Couldn't connect to ${conn.name}: ${(err as Error)?.message ?? String(err)}`,
      'error',
      6000,
    );
  }
}

/**
 * Auto-reconnect on startup (opt-in). If a saved remote is flagged
 * `reconnectOnStartup` and nothing is connected yet, dial it. This is what makes
 * "close the laptop, reopen, your agents are still running on the box" work
 * without a manual reconnect. Safe by construction: `connectRemote` fails fast
 * (10s) and rolls all the way back to Local if the box is offline, so a down
 * remote just means a normal Local boot — never a half-connected startup.
 */
export async function maybeAutoReconnectRemote(): Promise<void> {
  if (get(activeRemoteId)) return;
  // Tokens are keychain-backed; make sure the flagged remote's token is in
  // session memory before `startupRemote` hands it to the dial.
  await hydrateRemoteTokens();
  const target = startupRemote();
  if (!target) return;
  try {
    const { showToast } = await import('./notification');
    showToast(`Reconnecting to ${target.name}…`, 'info', 4000);
  } catch {
    /* toast is best-effort */
  }
  await connectRemote(target.id);
}

/**
 * Drop back to Local: tear down the socket and restore the local project that
 * was active before connecting.
 */
export async function disconnectRemote(): Promise<void> {
  if (!get(activeRemoteId)) return;
  closeTunnels();
  closeRemoteConnection();
  activeRemoteId.set(null);
  connectionStatus.set('disconnected');
  try {
    const workspace = await import('./workspace');
    workspace.leaveRemoteRoot();
  } catch (err) {
    console.error('Failed to leave remote workspace root:', err);
  }
}
