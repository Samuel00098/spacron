import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

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
  onExit(handler: () => void): Promise<UnlistenFn>;
  respond(requestId: string | number, result: Record<string, unknown>, error?: Record<string, unknown>): Promise<void>;
  notify(method: string, params: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
}

let nextRequestId = 0;

export async function openAcpSession(command: string, args: string[], cwd: string): Promise<AcpSession> {
  const { id } = await invoke<{ id: number }>('acp_start', { args: { command, args, cwd } });
  let closed = false;
  return {
    id,
    async request<T>(method: string, params: Record<string, unknown>) {
      if (closed) throw new Error('ACP session is closed');
      const requestId = `spacron-${Date.now()}-${++nextRequestId}`;
      const response = await invoke<Record<string, unknown>>('acp_request', {
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
      return listen<AcpNotification>(`acp://${id}/notification`, (event) => handler(event.payload));
    },
    onRequest(handler: (request: AcpServerRequest) => void) {
      return listen<AcpServerRequest>(`acp://${id}/request`, (event) => handler(event.payload));
    },
    onStderr(handler: (text: string) => void) {
      return listen<{ text?: string }>(`acp://${id}/stderr`, (event) => {
        if (typeof event.payload.text === 'string') handler(event.payload.text);
      });
    },
    onExit(handler: () => void) {
      return listen<Record<string, unknown>>(`acp://${id}/exit`, () => handler());
    },
    async respond(requestId, result, error) {
      await invoke('acp_respond', { id, requestId, result, error: error ?? null });
    },
    async notify(method, params) {
      if (closed) return;
      await invoke('acp_notify', { id, method, params });
    },
    async close() {
      if (closed) return;
      closed = true;
      await invoke('acp_close', { id });
    },
  };
}

const ACP_CLIENT_INFO = { name: 'spacron', version: '5.1.3' };
const ACP_CLIENT_CAPABILITIES = {
  fs: { readTextFile: true, writeTextFile: true },
  terminal: { create: true, output: true, release: true, waitForExit: true },
  mcp: { http: true, sse: true, stdio: true },
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
export async function initializeAcp(session: AcpSession): Promise<AcpInitialization> {
  try {
    const result = await session.request('initialize', {
      protocolVersion: 2,
      info: ACP_CLIENT_INFO,
      clientInfo: ACP_CLIENT_INFO,
      capabilities: ACP_CLIENT_CAPABILITIES,
      clientCapabilities: ACP_CLIENT_CAPABILITIES,
    });
    return handshake(result);
  } catch {
    const result = await session.request('initialize', {
      protocolVersion: 1,
      clientInfo: ACP_CLIENT_INFO,
      clientCapabilities: ACP_CLIENT_CAPABILITIES,
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

export async function promptAcpNativeSession(
  session: AcpSession,
  sessionId: string,
  text: string,
): Promise<void> {
  await session.request('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text }],
  });
}

export async function setAcpSessionModel(
  session: AcpSession,
  sessionId: string,
  model: string,
): Promise<void> {
  await session.request('session/set_model', { sessionId, modelId: model });
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
): Promise<void> {
  await session.request('session/set_mode', { sessionId, modeId });
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
