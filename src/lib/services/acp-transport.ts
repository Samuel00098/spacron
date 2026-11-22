import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { get } from '$lib/stores/storeCompat';
import { remoteTarget } from '$lib/stores/remoteWorkspace';
import { backendInvoke } from '$lib/services/backend';
import { onRemoteEvent } from '$lib/services/pty-bridge-remote';

type Subscribe = <T>(name: string, handler: (event: { payload: T }) => void) => Promise<UnlistenFn>;

/**
 * On a remote workspace the agent runs on the box (spacron-server's
 * acp_bridge), so its calls go over the remote socket and its events come back
 * as remote events. Chosen once per session: a session never changes host.
 */
function chatTransport(): { call: typeof invoke; subscribe: Subscribe } {
  if (!get(remoteTarget)) return { call: invoke, subscribe: listen as unknown as Subscribe };
  return {
    call: ((cmd: string, args?: Record<string, unknown>) => backendInvoke(cmd, args)) as typeof invoke,
    subscribe: (async <T>(name: string, handler: (event: { payload: T }) => void) =>
      onRemoteEvent(name, (payload) => handler({ payload: payload as T }))) as Subscribe,
  };
}

export type AcpNotification = Record<string, unknown>;
export type AcpServerRequest = {
  requestId: string | number;
  method: string;
  params: Record<string, unknown>;
};

export interface AcpSession {
  id: number;
  request<T = Record<string, unknown>>(method: string, params: Record<string, unknown>): Promise<T>;
  onNotification(handler: (notification: AcpNotification) => void): Promise<UnlistenFn>;
  onRequest(handler: (request: AcpServerRequest) => void): Promise<UnlistenFn>;
  onStderr(handler: (text: string) => void): Promise<UnlistenFn>;
  onRawLine(handler: (text: string) => void): Promise<UnlistenFn>;
  onExit(handler: () => void): Promise<UnlistenFn>;
  respond(requestId: string | number, result: Record<string, unknown>, error?: Record<string, unknown>): Promise<void>;
  notify(method: string, params: Record<string, unknown>): Promise<void>;
  writeRaw(text: string): Promise<void>;
  close(): Promise<void>;
}

let nextRequestId = 0;

export async function openAcpSession(command: string, args: string[], cwd: string, env: Record<string, string> = {}, rawArgs?: string): Promise<AcpSession> {
  const { call, subscribe } = chatTransport();
  // Fields inside `args` keep their Rust (snake_case) names: Tauri only renames
  // a command's top-level parameters. `rawArgs` here was silently dropped and
  // `cmd.exe` started as an idle shell with no command.
  const { id } = await call<{ id: number }>('acp_start', { args: { command, args, cwd, env, raw_args: rawArgs ?? null } });
  let closed = false;
  return {
    id,
    async request<T>(method: string, params: Record<string, unknown>) {
      if (closed) throw new Error('ACP session is closed');
      const requestId = `spacron-${Date.now()}-${++nextRequestId}`;
      const response = await call<Record<string, unknown>>('acp_request', {
        id,
        requestId,
        method,
        params,
      });
      if (response.error) {
        const error = response.error as { message?: string };
        throw new Error(error.message ?? 'ACP request failed');
      }
      return response.result as T;
    },
    onNotification(handler: (notification: AcpNotification) => void) {
      return subscribe<AcpNotification>(`acp://${id}/notification`, (event) => handler(event.payload));
    },
    onRequest(handler: (request: AcpServerRequest) => void) {
      return subscribe<AcpServerRequest>(`acp://${id}/request`, (event) => handler(event.payload));
    },
    onStderr(handler: (text: string) => void) {
      return subscribe<{ text?: string }>(`acp://${id}/stderr`, (event) => {
        if (typeof event.payload.text === 'string') handler(event.payload.text);
      });
    },
    onRawLine(handler: (text: string) => void) {
      return subscribe<{ text?: string }>(`acp://${id}/raw`, (event) => {
        if (typeof event.payload.text === 'string') handler(event.payload.text);
      });
    },
    onExit(handler: () => void) {
      return subscribe<Record<string, unknown>>(`acp://${id}/exit`, () => handler());
    },
    async respond(requestId, result, error) {
      await call('acp_respond', { id, requestId, result, error: error ?? null });
    },
    async notify(method, params) {
      if (closed) return;
      await call('acp_notify', { id, method, params });
    },
    async writeRaw(text) {
      if (closed) throw new Error('ACP session is closed');
      await call('acp_write_raw', { id, text });
    },
    async close() {
      if (closed) return;
      closed = true;
      await call('acp_close', { id });
    },
  };
}

function windowsHost(): boolean {
  // The agent runs on the box when a remote is active, and the box is not
  // this Windows machine, so no `cmd.exe` shim there.
  if (get(remoteTarget)) return false;
  return typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent);
}

/** Quote one argument for a `cmd.exe /s /c` command line. */
export function cmdQuote(arg: string): string {
  return /[\s"&|<>^()%!]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}

/** The `cmd.exe` arguments that run `command args…` with cmd's own PATH/PATHEXT lookup. */
export function windowsShimCommandLine(command: string, args: string[]): string {
  return `/d /s /c ${[command, ...args].map(cmdQuote).join(' ')}`;
}

/**
 * Start an agent CLI by bare name. On Windows most agents are npm `.cmd`
 * shims, which `CreateProcess` cannot start (and an extensionless bash script
 * of the same name sits beside them), so the line goes through `cmd.exe`,
 * which resolves `PATHEXT` exactly like a terminal would. Absolute paths and
 * other platforms spawn directly.
 */
export async function openAgentSession(command: string, args: string[], cwd: string, env: Record<string, string> = {}): Promise<AcpSession> {
  if (windowsHost() && !/^[a-z]:[\\/]|^\\\\/i.test(command)) {
    return openAcpSession('cmd.exe', [], cwd, env, windowsShimCommandLine(command, args));
  }
  return openAcpSession(command, args, cwd, env);
}

/** Collects an agent's stderr so a failure can say why, not just "stopped". */
export function stderrTail(session: AcpSession, keep = 6): { lines: string[]; text(): string | null; dispose: Promise<() => void> } {
  const lines: string[] = [];
  const dispose = session.onStderr((text) => {
    for (const line of text.split(/\r?\n/)) {
      const clean = line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim();
      if (!clean) continue;
      lines.push(clean);
      if (lines.length > keep) lines.shift();
    }
  });
  return {
    lines,
    text: () => {
      // The last meaningful line, skipping warnings that aren't the cause.
      const useful = lines.filter((line) => !/^warning\b/i.test(line));
      return (useful.at(-1) ?? lines.at(-1) ?? null)?.slice(0, 300) ?? null;
    },
    dispose,
  };
}

/** Reject when `promise` hasn't settled after `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

const ACP_CLIENT_INFO = { name: 'spacron', version: '5.1.4' };
/**
 * ACP v1 `clientCapabilities`: `fs.readTextFile`, `fs.writeTextFile` and
 * `terminal` are booleans. `terminal` used to be sent as an object, which
 * strict agents reject outright: Cursor and Grok answered `initialize` with
 * -32602 "Invalid params" (`terminal: expected boolean, received object`),
 * so their chats could never start (seen 2026-11-20).
 *
 * The default is for clients that implement `fs/*` and `terminal/*` (the
 * orchestrator's ACP chat does). A client that doesn't must say so, or the
 * agent routes its file reads and commands to it and they fail.
 */
export interface AcpClientCapabilities {
  fs: { readTextFile: boolean; writeTextFile: boolean };
  terminal: boolean;
}

const ACP_CLIENT_CAPABILITIES: AcpClientCapabilities = {
  fs: { readTextFile: true, writeTextFile: true },
  terminal: true,
};

/** For clients that answer no `fs/*` or `terminal/*` requests: the agent uses its own tools. */
export const ACP_NO_CLIENT_TOOLS: AcpClientCapabilities = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
};

/** The handshake the rest of the app consumes, whichever protocol answered. */
export interface AcpInitialization extends Record<string, unknown> {
  /** The version the agent actually selected (never the one we asked for). */
  protocolVersion: number;
  /** True when the agent negotiated v2, which adds usage, plan and state updates. */
  protocolV2: boolean;
  agentInfo: { name?: string; version?: string; title?: string } | null;
  agentCapabilities: Record<string, unknown>;
  authMethods: unknown[];
}

function handshake(result: Record<string, unknown>): AcpInitialization {
  const requested = result.protocolVersion;
  const parsed = typeof requested === 'number' ? requested : Number(requested);
  // An agent that reports nothing usable is treated as v1: v2-only behavior is
  // never assumed from a missing field.
  const protocolVersion = Number.isFinite(parsed) ? parsed : 1;
  const info = result.info ?? result.agentInfo;
  const capabilities = result.capabilities ?? result.agentCapabilities;
  return {
    ...result,
    protocolVersion,
    protocolV2: protocolVersion >= 2,
    agentInfo: info && typeof info === 'object' ? info as { name?: string; version?: string; title?: string } : null,
    agentCapabilities: capabilities && typeof capabilities === 'object' ? capabilities as Record<string, unknown> : {},
    authMethods: Array.isArray(result.authMethods) ? result.authMethods : [],
  };
}

/**
 * Negotiate ACP, preferring the v2 preview and falling back to v1.
 *
 * v2 is the same handshake with `protocolVersion: 2`, renamed `info`/
 * `capabilities` fields, and a refusal (`-32022`) carrying `{requested,
 * supported}`. Both spellings go out in one request so an agent that ignores
 * unknown fields answers immediately, and a strict v1 agent costs exactly one
 * extra round trip. The version used is whatever the agent echoes back — the
 * request never decides it.
 */
export async function initializeAcp(
  session: AcpSession,
  clientCapabilities: AcpClientCapabilities = ACP_CLIENT_CAPABILITIES,
): Promise<AcpInitialization> {
  try {
    const result = await session.request('initialize', {
      protocolVersion: 2,
      info: ACP_CLIENT_INFO,
      clientInfo: ACP_CLIENT_INFO,
      capabilities: clientCapabilities,
      clientCapabilities,
    });
    return handshake(result);
  } catch {
    const result = await session.request('initialize', {
      protocolVersion: 1,
      clientInfo: ACP_CLIENT_INFO,
      clientCapabilities,
    });
    return handshake(result);
  }
}

export async function authenticateAcp(
  session: AcpSession,
  methodId: string,
): Promise<Record<string, unknown>> {
  return session.request('authenticate', { methodId });
}

export async function createAcpNativeSession(
  session: AcpSession,
  cwd: string,
  model?: string | null,
  mcpServers: unknown[] = [],
): Promise<{ sessionId: string; modes?: unknown }> {
  return session.request<{ sessionId: string; modes?: unknown }>('session/new', {
    cwd,
    ...(model ? { mcpServers, _meta: { model } } : { mcpServers }),
  });
}

export async function loadAcpNativeSession(session: AcpSession, sessionId: string, cwd: string, mcpServers: unknown[] = []): Promise<Record<string, unknown>> {
  return session.request<Record<string, unknown>>('session/load', { sessionId, cwd, mcpServers });
}

export async function resumeAcpNativeSession(session: AcpSession, sessionId: string, cwd: string, mcpServers: unknown[] = []): Promise<Record<string, unknown>> {
  return session.request<Record<string, unknown>>('session/resume', { sessionId, cwd, mcpServers });
}

/** One inline image block of a prompt (`ContentBlock` of type `image`). */
export interface AcpPromptImage {
  mimeType: string;
  data: string;
}

/**
 * Send a turn. ACP's prompt is a list of content blocks: the text, plus one
 * `image` block per attachment the agent can actually receive. An agent that
 * only reads text still gets the prompt (unknown block types are its call).
 */
export async function promptAcpNativeSession(
  session: AcpSession,
  sessionId: string,
  text: string,
  images: readonly AcpPromptImage[] = [],
): Promise<{ stopReason?: string } | undefined> {
  const prompt: Record<string, unknown>[] = [];
  if (text.trim()) prompt.push({ type: 'text', text });
  for (const image of images) prompt.push({ type: 'image', mimeType: image.mimeType, data: image.data });
  if (!prompt.length) return;
  return session.request<{ stopReason?: string }>('session/prompt', { sessionId, prompt });
}

export async function setAcpSessionModel(
  session: AcpSession,
  sessionId: string,
  model: string,
): Promise<Record<string, unknown>> {
  return session.request<Record<string, unknown>>('session/set_model', { sessionId, modelId: model });
}

/**
 * Switch the agent's permission mode for this session.
 *
 * The mode ids come from the agent (`session/new` → `modes.availableModes`);
 * nothing is sent that the agent did not advertise.
 */
export async function setAcpSessionMode(
  session: AcpSession,
  sessionId: string,
  modeId: string,
): Promise<Record<string, unknown>> {
  return session.request<Record<string, unknown>>('session/set_mode', { sessionId, modeId });
}

export async function waitForAcpReplayIdle(
  session: AcpSession,
  timeoutMs = 10_000,
  idleGapMs = 250,
): Promise<void> {
  await new Promise<void>(async (resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = async () => {
      if (timer) clearTimeout(timer);
      if (idleTimer) clearTimeout(idleTimer);
      await unlisten();
      resolve();
    };
    const unlisten = await session.onNotification((notification) => {
      const update = notification.params && typeof notification.params === 'object'
        ? notification.params as Record<string, unknown>
        : notification;
      const nested = update.update && typeof update.update === 'object'
        ? update.update as Record<string, unknown>
        : update;
      const kind = String(nested.sessionUpdate ?? nested.type ?? '').toLowerCase().replace(/[-\s]/g, '_');
      if (kind.includes('idle') || kind.includes('complete') || kind.includes('end')) {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => void finish(), idleGapMs);
      }
    });
    timer = setTimeout(() => void finish(), timeoutMs);
  });
}
