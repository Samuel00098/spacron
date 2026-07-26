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

  const { uri, rootUri } = await resolveLspConnection(root, serverLang);
  const transport = new WebSocketTransport(uri);
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
      clients.delete(key);
      clearDiagnosticsForOwner(key);
    },
    onError: (err) => console.error(`LSP (${serverLang}) error:`, err),
  });

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

  const status = await checkServer(language);
  if (!status.supported) return null;
  if (!status.available) {
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

  const serverLang = serverLanguage(language);
  let entry: ClientEntry;
  try {
    entry = await getOrCreateClient(root, serverLang);
  } catch (err: any) {
    console.error('Failed to start language server:', err);
    if (!warned.has(`start:${language}`)) {
      warned.add(`start:${language}`);
      showToast(`Could not start ${status.command}: ${err?.message ?? err}`, 'error');
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
    // results and let editors retry.
    statusCache.clear();
    warned.clear();
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
