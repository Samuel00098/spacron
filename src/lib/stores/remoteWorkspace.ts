import { writable, derived, get } from '$lib/stores/storeCompat';

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

/** A saved remote target. `url` is the `/pty` WebSocket endpoint; `token` is the
 *  pre-shared server token (offered as a `token.<TOKEN>` subprotocol). */
export type RemoteConnection = {
  id: string;
  name: string;
  url: string;
  token: string;
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

function safeConnection(raw: unknown): RemoteConnection | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.url !== 'string' || typeof r.token !== 'string') return null;
  const id = typeof r.id === 'string' && r.id ? r.id : newId();
  const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim() : hostLabel(r.url);
  return { id, name, url: r.url, token: r.token };
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
      localStorage.setItem(CONNECTIONS_KEY, JSON.stringify(list));
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

/** Add a saved remote and return its generated id. */
export function addRemoteConnection(input: { name?: string; url: string; token: string }): string {
  const id = newId();
  const conn: RemoteConnection = {
    id,
    name: input.name?.trim() || hostLabel(input.url),
    url: input.url.trim(),
    token: input.token.trim(),
  };
  remoteConnections.update((list) => [...list, conn]);
  return id;
}

export function updateRemoteConnection(id: string, patch: Partial<Omit<RemoteConnection, 'id'>>) {
  remoteConnections.update((list) =>
    list.map((c) =>
      c.id === id
        ? {
            ...c,
            ...patch,
            name: (patch.name ?? c.name).trim() || hostLabel(patch.url ?? c.url),
          }
        : c,
    ),
  );
}

export function removeRemoteConnection(id: string) {
  // Disconnecting first keeps us from leaving a live socket pointed at a target
  // that no longer exists.
  if (get(activeRemoteId) === id) void disconnectRemote();
  remoteConnections.update((list) => list.filter((c) => c.id !== id));
}

export function setConnectionStatus(status: ConnectionStatus) {
  connectionStatus.set(status);
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

  connectionStatus.set('connecting');
  // Flip `remoteTarget` first so the dial + `workspace_info` route to this remote.
  activeRemoteId.set(id);
  try {
    const { ensureRemoteConnected } = await import('$lib/services/pty-bridge-remote');
    // Fail fast if the box is unreachable rather than hanging; the socket sets
    // status to 'connected' once open.
    await ensureRemoteConnected();
    const workspace = await import('./workspace');
    await workspace.openRemoteRoot(conn);
  } catch (err) {
    console.error('Failed to connect to remote workspace:', err);
    // Roll back cleanly to Local so we don't leave a half-connected state.
    const { closeRemoteConnection } = await import('$lib/services/pty-bridge-remote');
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
 * Drop back to Local: tear down the socket and restore the local project that
 * was active before connecting.
 */
export async function disconnectRemote(): Promise<void> {
  if (!get(activeRemoteId)) return;
  try {
    const { closeRemoteConnection } = await import('$lib/services/pty-bridge-remote');
    closeRemoteConnection();
  } catch (err) {
    console.error('Failed to close remote connection:', err);
  }
  activeRemoteId.set(null);
  connectionStatus.set('disconnected');
  try {
    const workspace = await import('./workspace');
    workspace.leaveRemoteRoot();
  } catch (err) {
    console.error('Failed to leave remote workspace root:', err);
  }
}
