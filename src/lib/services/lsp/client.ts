/**
 * LSP client management for the code editor.
 *
 * A language server is correct autocomplete: it actually knows the project's
 * types, symbols and imports (unlike word- or AI-based completion which guess).
 * This module owns the bridge to the Rust side:
 *
 *   - `lsp_check_server` tells us whether a server binary is installed.
 *   - `lsp_start` spawns the server behind a localhost WebSocket and hands back
 *     a single-use connection token.
 *
 * We share ONE `LanguageServerClient` per (workspace root, server language) so
 * that all open files of a language talk to a single server process — spawning
 * one rust-analyzer per `.rs` file would re-index the project every time.
 */
import { invoke, Channel } from '@tauri-apps/api/core';
import { writable } from '$lib/stores/storeCompat';
import {
  LanguageServerClient,
  WebSocketTransport,
  languageServerWithTransport,
} from 'codemirror-languageserver';
import type { Extension } from '@codemirror/state';
import { showToast, dismissToast, toasts } from '$lib/stores/notification';
import { get } from '$lib/stores/storeCompat';
import { remoteTarget } from '$lib/stores/remoteWorkspace';
import { clearDiagnosticsForOwner, publishDiagnostics } from '$lib/stores/diagnostics';
import { backendInvoke } from '../backend';

/** Spacron language ids (from `detectLanguage`) that we offer LSP for. */
const SUPPORTED = new Set(['typescript', 'javascript', 'rust', 'python', 'go']);

type ServerStatus = {
  language: string;
  supported: boolean;
  available: boolean;
  command: string;
  install_hint: string;
};

type LspConnection = {
  port: number;
  token: string;
  root_uri: string;
};

type ClientEntry = {
  client: LanguageServerClient;
  transport: WebSocketTransport;
  rootUri: string;
  refs: number;
};

export type LspHandle = {
  /** CodeMirror extension wiring this document to the server. */
  extension: Extension;
  /** Detach this document; closes the shared server when the last file closes. */
  dispose: () => void;
};

/**
 * What the LSP layer is currently doing for one (root, language) pair.
 *
 * This exists because every failure used to be a `null` return plus a
 * `console.error`, which is how a completely inert integration survived several
 * releases: the Settings toggle was on, no server was running, and the app said
 * nothing. Status is recorded on every path — including the ones that are not
 * errors — so the Problems panel can always answer "is a language server
 * actually running?" instead of implying the project is clean.
 */
export type LspState =
  /** Language has no server configured, or the file has no project root. */
  | 'unsupported'
  /** Server binary isn't installed. `detail` carries the install hint. */
  | 'missing'
  /** Asked the backend for a server; socket not up yet. */
  | 'starting'
  /** Connected and initialised. */
  | 'ready'
  /** Tried and failed. `detail` carries why. */
  | 'error';

export type LspStatusEntry = {
  language: string;
  state: LspState;
  detail?: string;
};

/** Keyed by `<root>::<serverLang>`, matching the diagnostics store's owner key. */
export const lspStatus = writable<Map<string, LspStatusEntry>>(new Map());

function setStatus(key: string, entry: LspStatusEntry) {
  lspStatus.update((current) => {
    const next = new Map(current);
    next.set(key, entry);
    return next;
  });
}

function clearStatus(key: string) {
  lspStatus.update((current) => {
    if (!current.has(key)) return current;
    const next = new Map(current);
    next.delete(key);
    return next;
  });
}

/**
 * How long to wait for the bridge WebSocket to open before calling it a failure.
 * Comfortably under the backend's 30s single-use token TTL, so a timeout here
 * still leaves room to report the problem before the token expires anyway.
 */
const CONNECT_TIMEOUT_MS = 10_000;

const clients = new Map<string, ClientEntry>();
const statusCache = new Map<string, ServerStatus>();
/** Languages we've already warned the user about (missing server) this session. */
const warned = new Set<string>();
/** Languages currently being installed, to avoid double-triggering. */
const installing = new Set<string>();

/**
 * Bumped after a successful server install so open editors re-attempt LSP without
 * needing the file to be reopened. CodeEditor's load effect depends on this.
 */
export const lspReload = writable(0);

/**
 * Collapse JS/TS onto a single server: typescript-language-server serves both,
 * so one process per project handles every .ts/.tsx/.js/.jsx file.
 */
function serverLanguage(language: string): string {
  if (language === 'javascript') return 'typescript';
  return language;
}

/** Per-document LSP languageId, derived from the extension (JSX/TSX matter). */
function languageIdForPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'ts':
    case 'mts':
    case 'cts':
      return 'typescript';
    case 'tsx':
      return 'typescriptreact';
    case 'js':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'jsx':
      return 'javascriptreact';
    case 'rs':
      return 'rust';
    case 'py':
    case 'pyi':
      return 'python';
    case 'go':
      return 'go';
    default:
      return ext;
  }
}

/** Convert an absolute OS path to a `file://` URI matching the Rust side. */
function pathToFileUri(p: string): string {
  let path = p.replace(/\\/g, '/');
  // Windows drive paths need a leading slash: C:/x -> /C:/x
  if (/^[a-zA-Z]:/.test(path)) path = `/${path}`;
  return encodeURI(`file://${path}`);
}

async function checkServer(language: string): Promise<ServerStatus> {
  const cached = statusCache.get(language);
  if (cached) return cached;
  // Route through the backend seam: with a remote workspace active this probes
  // the *remote* PATH (where the code and language servers actually live).
  const status = await backendInvoke<ServerStatus>('lsp_check_server', { language });
  statusCache.set(language, status);
  return status;
}

/**
 * Build the WebSocket URL CodeMirror's transport connects to, plus the workspace
 * `rootUri`. Local: `lsp_start` spawns a localhost bridge and returns its port +
 * a one-time token. Remote: `lsp_start` (over the shared backend socket) mints the
 * same kind of one-time token, but the server has no separate port — the `/lsp`
 * route lives on the remote target's own host, so we derive the URL from it.
 */
async function resolveLspConnection(
  root: string,
  serverLang: string,
): Promise<{ uri: string; rootUri: string }> {
  const target = get(remoteTarget);
  const conn = await backendInvoke<LspConnection>('lsp_start', { root, language: serverLang });

  if (target) {
    // The remote `/lsp` route lives on the remote host, which the app's
    // `connect-src` (`ws://127.0.0.1:*` only) forbids the WebView from dialing —
    // the same CSP block that stopped the PTY socket. Go through the backend's
    // loopback relay so the URL is one the policy allows; the relay forwards
    // bytes untouched, so the one-time token still reaches the server intact.
    const u = new URL(target.url);
    const relayPort = await invoke<number>('remote_relay_start', { url: target.url });
    u.protocol = 'ws:';
    u.hostname = '127.0.0.1';
    u.port = String(relayPort);
    u.pathname = '/lsp';
    u.search = `?token=${encodeURIComponent(conn.token)}`;
    return { uri: u.toString(), rootUri: conn.root_uri };
  }
  return {
    uri: `ws://127.0.0.1:${conn.port}/lsp?token=${conn.token}`,
    rootUri: conn.root_uri,
  };
}

/**
 * Resolve once the bridge socket is actually open, or reject with why it isn't.
 *
 * `WebSocketTransport` dials in its constructor and exposes the raw socket, but
 * never reports the outcome: on a refused connection it simply stays shut while
 * `LanguageServerClient` sits on a promise that never settles. That is the exact
 * shape of the bug this fixes — the backend spawns a server only when the socket
 * connects, so a refused socket means no server, silently and forever.
 */
function waitForSocket(transport: WebSocketTransport, timeoutMs: number): Promise<void> {
  const ws = (transport as unknown as { connection?: WebSocket }).connection;
  if (!ws) {
    return Promise.reject(new Error('LSP transport exposed no WebSocket to wait on'));
  }
  if (ws.readyState === WebSocket.OPEN) return Promise.resolve();
  if (ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) {
    return Promise.reject(new Error('The language server bridge closed before it opened'));
  }

  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener('open', onOpen);
      ws.removeEventListener('error', onFail);
      ws.removeEventListener('close', onFail);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    // A refused TCP connect fires `error` then `close`; either is a failure here.
    const onFail = () => {
      cleanup();
      reject(new Error('Could not reach the language server bridge (connection refused)'));
    };
    const timer = setTimeout(() => {
      cleanup();
      try {
        ws.close();
      } catch {
        /* already gone */
      }
      reject(new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s connecting to the language server bridge`));
    }, timeoutMs);

    ws.addEventListener('open', onOpen);
    ws.addEventListener('error', onFail);
    ws.addEventListener('close', onFail);
  });
}

async function getOrCreateClient(
  root: string,
  serverLang: string,
): Promise<ClientEntry> {
  const key = `${root}::${serverLang}`;
  const existing = clients.get(key);
  if (existing) {
    existing.refs += 1;
    return existing;
  }

  setStatus(key, { language: serverLang, state: 'starting' });

  const { uri, rootUri } = await resolveLspConnection(root, serverLang);
  const transport = new WebSocketTransport(uri);

  // Block until the socket is up. Until it is, the backend has not spawned
  // anything — the bridge launches the server inside its WebSocket handler — so
  // handing back a "working" handle now would be a lie.
  try {
    await waitForSocket(transport, CONNECT_TIMEOUT_MS);
  } catch (err) {
    try {
      transport.close();
    } catch {
      /* nothing to close */
    }
    throw err;
  }

  const rootName = root.split(/[\\/]/).filter(Boolean).pop() || 'workspace';

  const client = new LanguageServerClient({
    transport,
    rootUri,
    workspaceFolders: [{ uri: rootUri, name: rootName }],
    // The client carries base options; the per-document plugin overrides these.
    documentUri: rootUri,
    languageId: serverLang,
    autoClose: false,
    onClose: () => {
      // Server died or socket dropped — drop the entry so the next file reopen
      // reconnects with a fresh process. Its diagnostics go too: keeping them
      // would leave the Problems panel reporting stale problems from a server
      // that is no longer running (and no longer able to retract them).
      //
      // `delete` returning false means `releaseClient` already unregistered this
      // entry, i.e. we closed the socket on purpose because the last file shut.
      // Only an unsolicited close is a failure worth reporting.
      const wasActive = clients.delete(key);
      clearDiagnosticsForOwner(key);
      if (wasActive) {
        setStatus(key, {
          language: serverLang,
          state: 'error',
          detail: 'The language server stopped. Reopen a file to restart it.',
        });
      } else {
        clearStatus(key);
      }
    },
    onError: (err) => {
      console.error(`LSP (${serverLang}) error:`, err);
      setStatus(key, {
        language: serverLang,
        state: 'error',
        detail: (err as Error)?.message ?? String(err),
      });
    },
    // Fired once `initialize` round-trips, which is the only proof the server
    // process is alive and talking rather than merely spawned.
    onCapabilities: () => setStatus(key, { language: serverLang, state: 'ready' }),
  } as ConstructorParameters<typeof LanguageServerClient>[0]);

  // Tap `publishDiagnostics` for the Problems panel.
  //
  // `attachPlugin` is the package's documented extension point: the client fans
  // every notification out to `plugin.processNotification`. The real per-document
  // plugin renders diagnostics as inline lint markers and keeps them to itself,
  // so without this listener a problem is only visible while you are looking at
  // that exact file. Attaching here (once per shared client) rather than per
  // document means we see diagnostics for every file the server reports on.
  //
  // Safe to attach because the client is built with `autoClose: false` —
  // `detachPlugin` would otherwise close the shared server.
  const diagnosticsListener = {
    processNotification: (notification: { method?: string; params?: any }) => {
      if (notification?.method !== 'textDocument/publishDiagnostics') return;
      const params = notification.params;
      if (!params?.uri) return;
      publishDiagnostics(key, params.uri, params.diagnostics ?? []);
    },
  };
  client.attachPlugin(diagnosticsListener as never);

  const entry: ClientEntry = { client, transport, rootUri, refs: 1 };
  clients.set(key, entry);
  return entry;
}

function releaseClient(root: string, serverLang: string) {
  const key = `${root}::${serverLang}`;
  const entry = clients.get(key);
  if (!entry) return;
  entry.refs -= 1;
  if (entry.refs <= 0) {
    clients.delete(key);
    // The server is going away, so nothing can retract its diagnostics later.
    clearDiagnosticsForOwner(key);
    // Deliberate shutdown, so drop the status entry rather than marking it an
    // error — `onClose` will fire next and would otherwise report a healthy
    // teardown as a failure.
    clearStatus(key);
    try {
      entry.client.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Build an LSP extension for a document, or return null when LSP isn't available
 * (unsupported language, missing server binary, or no project root). When the
 * server isn't installed, the user is told how to install it — once per session.
 */
export async function createLspExtension(
  filePath: string,
  language: string,
  root: string | null | undefined,
): Promise<LspHandle | null> {
  if (!root || !SUPPORTED.has(language)) return null;

  const serverLang = serverLanguage(language);
  const key = `${root}::${serverLang}`;

  const status = await checkServer(language);
  if (!status.supported) {
    setStatus(key, { language: serverLang, state: 'unsupported' });
    return null;
  }
  if (!status.available) {
    // Recorded as well as toasted: the toast fires once per session, but the
    // Problems panel has to be able to explain an empty list at any point.
    setStatus(key, {
      language: serverLang,
      state: 'missing',
      detail: `${status.command} is not installed. Install it with: ${status.install_hint}`,
    });
    if (!warned.has(language)) {
      warned.add(language);
      showToast(
        `Autocomplete for ${language} needs ${status.command}.`,
        'info',
        8000,
        false,
        { label: 'Install', onClick: () => void installServer(language) },
      );
    }
    return null;
  }

  let entry: ClientEntry;
  try {
    entry = await getOrCreateClient(root, serverLang);
  } catch (err: any) {
    const detail = err?.message ?? String(err);
    console.error('Failed to start language server:', err);
    setStatus(key, { language: serverLang, state: 'error', detail });
    if (!warned.has(`start:${language}`)) {
      warned.add(`start:${language}`);
      showToast(`Could not start ${status.command}: ${detail}`, 'error', 10000);
    }
    return null;
  }

  const extension = languageServerWithTransport({
    client: entry.client,
    transport: entry.transport,
    rootUri: entry.rootUri,
    workspaceFolders: [{ uri: entry.rootUri, name: 'workspace' }],
    documentUri: pathToFileUri(filePath),
    languageId: languageIdForPath(filePath),
    allowHTMLContent: true,
  });

  let disposed = false;
  return {
    extension,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      releaseClient(root, serverLang);
    },
  };
}

/** Whether LSP autocomplete is offered for a given Spacron language id. */
export function lspSupportsLanguage(language: string): boolean {
  return SUPPORTED.has(language);
}

/** Dismiss any active toast whose message exactly matches (our progress toast). */
function dismissByMessage(message: string) {
  for (const t of get(toasts)) {
    if (t.message === message) dismissToast(t.id);
  }
}

/**
 * Install the language server for a language in the background, streaming a
 * progress toast. On success, clears the availability cache and pings open
 * editors (via `lspReload`) so autocomplete activates without reopening the file.
 */
export async function installServer(language: string): Promise<void> {
  if (installing.has(language)) return;

  const status = await checkServer(language);
  if (status.available) {
    showToast(`${status.command} is already installed.`, 'info');
    return;
  }

  // The installer streams over Tauri channels and runs on *this* machine — but a
  // remote workspace's servers must live on the remote box. Rather than install
  // to the wrong host, point the user at their remote terminal (Step 1 gave them
  // one). Auto-install over the transport is a later step.
  if (get(remoteTarget)) {
    showToast(
      `Install ${status.command} on your remote workspace: run “${status.install_hint}” in a terminal.`,
      'info',
      10000,
    );
    return;
  }

  installing.add(language);
  const progress = `Installing ${status.command}…`;
  showToast(progress, 'info', 0); // duration 0 = persists until we dismiss it

  const recent: string[] = [];
  const onOutput = new Channel<string>();
  onOutput.onmessage = (line) => {
    recent.push(line);
    if (recent.length > 50) recent.shift();
  };
  const onDone = new Channel<number>();
  const finished = new Promise<number>((resolve) => {
    onDone.onmessage = resolve;
  });

  try {
    await invoke('lsp_install_server', { language, onOutput, onDone });
  } catch (err: any) {
    installing.delete(language);
    dismissByMessage(progress);
    showToast(`Couldn't install ${status.command}: ${err?.message ?? err}`, 'error', 8000);
    return;
  }

  const code = await finished;
  installing.delete(language);
  dismissByMessage(progress);

  if (code === 0) {
    // The just-installed binary changes availability; drop cached "not found"
    // results — including the per-language status the Problems panel reads — and
    // let editors retry.
    statusCache.clear();
    warned.clear();
    lspStatus.set(new Map());
    showToast(`${status.command} installed — autocomplete is now active.`, 'success');
    lspReload.update((n) => n + 1);
  } else {
    const tail = recent.slice(-2).join(' ').slice(0, 200);
    showToast(
      `Install failed (exit ${code}). ${tail || `Try manually: ${status.install_hint}`}`,
      'error',
      10000,
    );
  }
}
