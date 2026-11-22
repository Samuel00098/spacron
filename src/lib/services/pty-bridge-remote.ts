import { invoke } from '@tauri-apps/api/core';
import { get } from '$lib/stores/storeCompat';
import { remoteTarget, setConnectionStatus } from '$lib/stores/remoteWorkspace';
import type { PtyHandlers, PtySession, ShellInfo } from './pty-bridge';

// Remote transport for pty-bridge: talks to a `spacron-server` over one
// WebSocket, multiplexing many sessions by id. Mirrors the local bridge's
// contract exactly, so the terminal store is unaware of which is in use. See
// docs/remote-workspace.md ("Step 1 Scope" and "Step 4 Scope").
//
// Wire protocol: JSON text for control, binary `[kind:u8][id:u32 BE][payload]`
// for terminal output (kind 0 = live data, 1 = attach replay).
//
// Reconnect (Step 4): the socket owns a status + auto-reconnect lifecycle. The
// server keeps PTY sessions and their output buffers alive across a disconnect,
// so a dropped link (laptop sleep, network blip) is recoverable: we back off,
// re-dial, then re-attach the still-live sessions and re-arm fs-watches. On a
// reconnect we deliberately DROP the replay buffer — it's the full scrollback,
// already on screen, so re-feeding it would double-paint the pane. Live output
// simply resumes; a brief gap is dropped rather than duplicating history.

const KIND_DATA = 0;
const KIND_REPLAY = 1;

/** Reconnect backoff: start small, double each failure, cap so a long outage
 *  still retries about every 15s while a remote stays selected. */
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 15_000;

type SessionEntry = {
  handlers: PtyHandlers;
  // While non-null, live chunks are queued here instead of delivered — used by
  // attach so the buffered replay is handed off before any live output (mirrors
  // the local bridge's pendingLive handling).
  pendingLive: Uint8Array[] | null;
};

type Pending = { resolve: (value: unknown) => void; reject: (err: unknown) => void };

class RemotePtyConnection {
  readonly url: string;
  readonly token: string;
  private ws: WebSocket | null = null;
  private ready: Promise<void> | null = null;
  private reqSeq = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly sessions = new Map<number, SessionEntry>();
  // Data frames can arrive before `create` resolves us the id, so buffer any
  // output for a not-yet-registered session until its handlers are attached.
  private readonly earlyData = new Map<number, Uint8Array[]>();
  private readonly fsChangeListeners = new Set<(path: string) => void>();
  // Paths under active watch, so we can re-arm them after a reconnect (server
  // watchers are per-connection and die with the socket).
  private readonly watchedPaths = new Set<string>();
  // Sessions being silently re-attached after a reconnect; their replay frame is
  // dropped (already on screen) rather than fed to onReplay.
  private readonly reattaching = new Map<number, number>(); // reqId -> session id
  // Loopback URL standing in for `url`, once the backend relay is up (see
  // socketUrl). Null until first dial.
  private relayUrl: string | null = null;
  // Set once the caller explicitly disconnects, so an intentional socket close
  // isn't treated as a drop to reconnect from.
  private closed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoff = RECONNECT_BASE_MS;

  constructor(url: string, token: string) {
    this.url = url;
    this.token = token;
  }

  /**
   * The URL the WebView is actually allowed to dial.
   *
   * The app's `connect-src` permits `ws://127.0.0.1:*` and nothing else, so a
   * direct `ws://<remote-host>:9000/pty` is blocked by CSP before it leaves the
   * page (`securitypolicyviolation: connect-src <- ws://…`). The backend binds a
   * loopback relay to the real host and we dial that instead — same handshake,
   * same subprotocol token, same frames, but an origin the policy allows. See
   * `commands/remote_relay.rs`.
   *
   * Cached per connection: the relay is keyed by upstream host in Rust and
   * reused, so a reconnect resolves to the same port.
   */
  private async socketUrl(): Promise<string> {
    if (this.relayUrl) return this.relayUrl;
    const original = new URL(this.url);
    const port = await invoke<number>('remote_relay_start', { url: this.url });
    // Keep the path and query — the server routes on `/pty` vs `/lsp`.
    this.relayUrl = `ws://127.0.0.1:${port}${original.pathname}${original.search}`;
    return this.relayUrl;
  }

  private ensure(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Remote connection closed'));
    if (this.ready) return this.ready;
    // A pending op arriving during the reconnect backoff dials immediately
    // rather than waiting out the timer.
    return this.dial('connecting');
  }

  /** Open the socket and wire it up. `kind` only affects the status we publish
   *  while the handshake is in flight (first connect vs. a reconnect). */
  private dial(kind: 'connecting' | 'reconnecting'): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    setConnectionStatus(kind);
    // The relay has to be up before the socket can be opened, so `ready` chains
    // off it. A relay failure (bad URL, unsupported scheme) rejects `ready` the
    // same way a failed handshake does, so callers surface it identically.
    this.ready = this.socketUrl().then(
      (target) =>
        new Promise<void>((resolve, reject) => {
          // Authenticate via subprotocol, not a `?token=` query param — keeps the
          // token out of URLs/logs, and it's the only header the browser WebSocket
          // API lets us set. The server echoes back `spacron.v1` to complete the
          // handshake. Token must be a valid WS subprotocol token (alphanumeric /
          // base64url). See spacron-server's ws_handler. The relay forwards the
          // handshake byte-for-byte, so the token still travels end-to-end.
          const ws = new WebSocket(target, ['spacron.v1', `token.${this.token}`]);
          ws.binaryType = 'arraybuffer';
          ws.onopen = () => {
            this.backoff = RECONNECT_BASE_MS;
            setConnectionStatus('connected');
            // Re-attach sessions and watches that outlived the old socket. On the
            // first connect both sets are empty, so this is a no-op.
            this.resumeSessions();
            this.rearmWatches();
            resolve();
          };
          ws.onerror = () => reject(new Error('Remote workspace WebSocket error'));
          ws.onclose = () => this.handleClose();
          ws.onmessage = (ev) => this.handleMessage(ev);
          this.ws = ws;
        }),
    );
    return this.ready;
  }

  /** Resolve once connected, or reject after `timeoutMs` — used by the explicit
   *  Connect action so a down box surfaces an error instead of hanging. */
  connectNow(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('Timed out connecting to remote workspace'));
      }, timeoutMs);
      this.ensure().then(
        () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        },
        (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  /** Explicit teardown (user disconnects / removes the target). Stops reconnect. */
  close() {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.ready = null;
  }

  private handleClose() {
    this.ws = null;
    this.ready = null;
    for (const p of this.pending.values()) p.reject(new Error('Remote workspace disconnected'));
    this.pending.clear();
    this.reattaching.clear();
    // Sessions are left in the map: the server keeps them alive across a
    // disconnect, so a later reconnect + attach can resume them.
    if (this.closed) {
      setConnectionStatus('disconnected');
      return;
    }
    // Unexpected drop — back off and retry so the workspace self-heals.
    setConnectionStatus('reconnecting');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.dial('reconnecting').catch(() => {
        // dial() rejects on this attempt's error; the socket's onclose will have
        // scheduled the next retry, so nothing more to do here.
      });
    }, this.backoff);
    this.backoff = Math.min(this.backoff * 2, RECONNECT_MAX_MS);
  }

  /** After a reconnect, re-attach every live session so its output resumes.
   *  The replay frame is suppressed (see file header) — we only want live data. */
  private resumeSessions() {
    for (const id of this.sessions.keys()) {
      const reqId = this.reqSeq++;
      this.reattaching.set(reqId, id);
      this.send({ t: 'attach', reqId, id });
    }
  }

  /** After a reconnect, re-arm every fs-watch (server watchers died with the
   *  old socket). */
  private rearmWatches() {
    for (const path of this.watchedPaths) {
      this.send({ t: 'start_watch', path });
    }
  }

  private handleMessage(ev: MessageEvent) {
    if (typeof ev.data === 'string') {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      this.handleControl(msg);
      return;
    }

    const buf = ev.data as ArrayBuffer;
    if (buf.byteLength < 5) return;
    const view = new DataView(buf);
    const kind = view.getUint8(0);
    const id = view.getUint32(1, false);
    const payload = new Uint8Array(buf, 5);

    if (kind === KIND_REPLAY) {
      // Drop the replay for a silent reconnect re-attach — the scrollback is
      // already painted, so re-feeding it would duplicate the pane's content.
      if (this.isReattaching(id)) return;
      this.sessions.get(id)?.handlers.onReplay?.(payload);
      return;
    }
    if (kind !== KIND_DATA) return;

    const entry = this.sessions.get(id);
    if (!entry) {
      const queue = this.earlyData.get(id) ?? [];
      queue.push(payload);
      this.earlyData.set(id, queue);
      return;
    }
    if (entry.pendingLive) entry.pendingLive.push(payload);
    else entry.handlers.onData(payload);
  }

  private isReattaching(id: number): boolean {
    for (const v of this.reattaching.values()) if (v === id) return true;
    return false;
  }

  private handleControl(msg: Record<string, unknown>) {
    const reqId = typeof msg.reqId === 'number' ? msg.reqId : null;
    // A reconnect re-attach isn't a pending request — its success/failure is
    // reported here instead of settling a promise.
    if (reqId !== null && this.reattaching.has(reqId)) {
      const id = this.reattaching.get(reqId)!;
      this.reattaching.delete(reqId);
      if (msg.t === 'error' || msg.t === 'invokeErr') {
        // Session vanished on the server (e.g. the server itself restarted) —
        // surface an exit so the pane doesn't linger as a zombie.
        const entry = this.sessions.get(id);
        this.sessions.delete(id);
        entry?.handlers.onExit?.(-1);
      }
      return;
    }
    switch (msg.t) {
      case 'created':
        this.settle(reqId, msg.id as number);
        break;
      case 'attached':
        this.settle(reqId, undefined);
        break;
      case 'shells':
        this.settle(reqId, msg.list);
        break;
      case 'exit': {
        const id = msg.id as number;
        this.sessions.get(id)?.handlers.onExit?.(msg.code as number);
        break;
      }
      case 'invokeOk':
        this.settle(reqId, msg.value);
        break;
      case 'invokeErr':
        if (reqId !== null) this.reject(reqId, new Error(String(msg.message ?? 'remote error')));
        break;
      case 'event': {
        // Events from processes the box runs for us (chat-view agents, see
        // remote/acp_bridge.rs), addressed by the same names Tauri events use.
        const listeners = remoteEventListeners.get(String(msg.name));
        if (listeners) for (const listener of [...listeners]) listener(msg.payload);
        break;
      }
      case 'fsChange':
        for (const listener of this.fsChangeListeners) listener(String(msg.path));
        break;
      case 'error':
        if (reqId !== null) this.reject(reqId, new Error(String(msg.message ?? 'remote error')));
        else console.error('[remote-pty]', msg.message);
        break;
    }
  }

  private settle(reqId: number | null, value: unknown) {
    if (reqId === null) return;
    const p = this.pending.get(reqId);
    this.pending.delete(reqId);
    p?.resolve(value);
  }

  private reject(reqId: number, err: unknown) {
    const p = this.pending.get(reqId);
    this.pending.delete(reqId);
    p?.reject(err);
  }

  private request<T>(reqId: number, msg: Record<string, unknown>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.set(reqId, { resolve: resolve as (v: unknown) => void, reject });
      this.send(msg);
    });
  }

  private send(msg: Record<string, unknown>) {
    this.ws?.send(JSON.stringify(msg));
  }

  // Wrap onExit so an exited session frees its backend counterpart (the server
  // keeps the PtyManager entry until an explicit close), matching the local
  // bridge's free-on-exit behavior.
  private registerSession(id: number, handlers: PtyHandlers, queueLive: boolean): SessionEntry {
    const wrapped: PtyHandlers = {
      ...handlers,
      onExit: (code) => {
        handlers.onExit?.(code);
        this.send({ t: 'close', id });
        this.sessions.delete(id);
      },
    };
    const entry: SessionEntry = { handlers: wrapped, pendingLive: queueLive ? [] : null };
    this.sessions.set(id, entry);
    return entry;
  }

  private makeSession(id: number): PtySession {
    return {
      id,
      write: (data) => {
        this.send({ t: 'write', id, data });
        return Promise.resolve();
      },
      resize: (cols, rows) => {
        this.send({ t: 'resize', id, cols, rows });
        return Promise.resolve();
      },
      close: async () => {
        this.send({ t: 'close', id });
        this.sessions.delete(id);
      },
    };
  }

  async openPty(
    cols: number,
    rows: number,
    handlers: PtyHandlers,
    cwd?: string,
    shellProgram?: string,
    env?: Record<string, string>,
  ): Promise<PtySession> {
    await this.ensure();
    const reqId = this.reqSeq++;
    const id = await this.request<number>(reqId, {
      t: 'create',
      reqId,
      cols,
      rows,
      cwd: cwd ?? null,
      shell: shellProgram ?? null,
      env: env ?? null,
    });

    const entry = this.registerSession(id, handlers, false);
    const early = this.earlyData.get(id);
    if (early) {
      this.earlyData.delete(id);
      for (const bytes of early) entry.handlers.onData(bytes);
    }
    return this.makeSession(id);
  }

  async attachPty(id: number, handlers: PtyHandlers): Promise<PtySession> {
    await this.ensure();
    const entry = this.registerSession(id, handlers, true);
    const reqId = this.reqSeq++;
    // Replay bytes are delivered to onReplay via a KIND_REPLAY frame during this
    // await; live chunks meanwhile accumulate in pendingLive.
    await this.request<void>(reqId, { t: 'attach', reqId, id });
    const queued = entry.pendingLive ?? [];
    entry.pendingLive = null;
    for (const bytes of queued) handlers.onData(bytes);
    return this.makeSession(id);
  }

  async getAvailableShells(): Promise<ShellInfo[]> {
    try {
      await this.ensure();
      const reqId = this.reqSeq++;
      return await this.request<ShellInfo[]>(reqId, { t: 'list_shells', reqId });
    } catch {
      return [];
    }
  }

  // Generic request/response call (file ops etc.) over the same socket — the
  // BackendClient seam's remote arm.
  async invoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
    await this.ensure();
    const reqId = this.reqSeq++;
    return this.request<T>(reqId, { t: 'invoke', reqId, cmd, args });
  }

  async startWatch(path: string): Promise<void> {
    this.watchedPaths.add(path);
    await this.ensure();
    this.send({ t: 'start_watch', path });
  }

  async stopWatch(path: string): Promise<void> {
    this.watchedPaths.delete(path);
    await this.ensure();
    this.send({ t: 'stop_watch', path });
  }

  onFsChange(listener: (path: string) => void): () => void {
    this.fsChangeListeners.add(listener);
    return () => this.fsChangeListeners.delete(listener);
  }
}

let conn: RemotePtyConnection | null = null;

/** Module-level so a subscription outlives a reconnect's new connection object. */
const remoteEventListeners = new Map<string, Set<(payload: unknown) => void>>();

/** Subscribe to a named event from the box. Returns the unsubscribe function. */
export function onRemoteEvent(name: string, listener: (payload: unknown) => void): () => void {
  let set = remoteEventListeners.get(name);
  if (!set) remoteEventListeners.set(name, (set = new Set()));
  set.add(listener);
  return () => {
    set!.delete(listener);
    if (!set!.size) remoteEventListeners.delete(name);
  };
}

function activeConn(): RemotePtyConnection {
  const target = get(remoteTarget);
  if (!target) throw new Error('No remote workspace target configured');
  if (!conn || conn.url !== target.url || conn.token !== target.token) {
    // Switching targets: tear down the old socket (and its reconnect loop) first.
    conn?.close();
    conn = new RemotePtyConnection(target.url, target.token);
  }
  return conn;
}

/** Dial the active remote and wait for the socket (used by the explicit Connect
 *  action). Rejects on timeout so a down box surfaces an error. */
export function ensureRemoteConnected(timeoutMs = 10_000): Promise<void> {
  return activeConn().connectNow(timeoutMs);
}

/** Explicitly disconnect: closes the socket and stops the reconnect loop. Safe
 *  to call when nothing is connected. */
export function closeRemoteConnection(): void {
  conn?.close();
  conn = null;
}

export function openPtyRemote(
  cols: number,
  rows: number,
  handlers: PtyHandlers,
  cwd?: string,
  shellProgram?: string,
  env?: Record<string, string>,
): Promise<PtySession> {
  return activeConn().openPty(cols, rows, handlers, cwd, shellProgram, env);
}

export function attachPtyRemote(id: number, handlers: PtyHandlers): Promise<PtySession> {
  return activeConn().attachPty(id, handlers);
}

export function getAvailableShellsRemote(): Promise<ShellInfo[]> {
  return activeConn().getAvailableShells();
}

export function backendInvokeRemote<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  return activeConn().invoke<T>(cmd, args);
}

export function startWatchRemote(path: string): Promise<void> {
  return activeConn().startWatch(path);
}

export function stopWatchRemote(path: string): Promise<void> {
  return activeConn().stopWatch(path);
}

export function onFsChangeRemote(listener: (path: string) => void): () => void {
  return activeConn().onFsChange(listener);
}
