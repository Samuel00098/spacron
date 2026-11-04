import { invoke } from '@tauri-apps/api/core';

export type ChatAccessMode = 'supervised' | 'auto-edits' | 'auto' | 'full-access' | 'inherit';

export type ClaudePermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk';

export interface ClaudeUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cost?: number;
}

export function claudePermissionModeForAccess(tier: ChatAccessMode): ClaudePermissionMode {
  switch (tier) {
    case 'supervised':
      return 'default';
    case 'auto-edits':
      return 'acceptEdits';
    case 'auto':
      return 'plan';
    case 'full-access':
      return 'bypassPermissions';
    case 'inherit':
    default:
      return 'default';
  }
}

export interface ClaudeAgentSdkTurnOptions {
  prompt: string;
  cwd: string;
  model?: string | null;
  permissionMode?: ClaudePermissionMode;
  abortController?: AbortController;
  /** Resume an existing Claude SDK session by ID instead of starting fresh. */
  sessionId?: string | null;
  /** Fork the resumed session into a new native session (only meaningful with sessionId). */
  forkSession?: boolean;
  onText: (text: string) => void;
  onTool?: (name: string, input: unknown) => void;
  onUsage?: (usage: ClaudeUsage) => void;
  /** Captures the SDK session id observed from init/result messages. */
  onSessionId?: (sessionId: string) => void;
}

export interface ClaudeAgentSdkTurnResult {
  text: string;
  sessionId: string | null;
}

/**
 * Run one Claude turn through the Rust-native Tauri adapter (`claude_chat_complete`).
 *
 * The `@anthropic-ai/claude-agent-sdk` npm package is Node-only and cannot run
 * inside the Tauri webview, so all Claude turns route through the Rust side
 * which spawns the user's `claude` CLI directly. This function preserves the
 * SDK-style callback interface for callers, delivering the final text once via
 * `onText` and the observed session id via `onSessionId`.
 */
export async function runClaudeAgentSdkTurn(opts: ClaudeAgentSdkTurnOptions): Promise<ClaudeAgentSdkTurnResult> {
  const nativeOpts: ClaudeNativeTurnOptions = {
    cwd: opts.cwd,
    model: opts.model ?? null,
    systemPrompt: '',
    userText: opts.prompt,
    images: [],
    effort: null,
    accessMode: null,
    sessionId: opts.sessionId ?? null,
    forkSession: opts.forkSession ?? false,
  };
  const result = await runClaudeNativeTurn(nativeOpts);
  opts.onText(result.text);
  if (result.sessionId) opts.onSessionId?.(result.sessionId);
  return { text: result.text, sessionId: result.sessionId };
}

export interface ClaudeCliTurnOptions extends Omit<ClaudeAgentSdkTurnOptions, 'abortController'> {
  signal?: AbortSignal;
}

export function parseClaudeJsonLine(line: string): {
  text?: string;
  usage?: Record<string, unknown>;
  toolName?: string;
  toolInput?: unknown;
} | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  const result = obj.result;
  if (result && typeof result === 'object') {
    const r = result as Record<string, unknown>;
    const usage = typeof r.usage === 'object' && r.usage ? (r.usage as Record<string, unknown>) : undefined;
    const text = typeof r.text === 'string' ? r.text : undefined;
    return { text, usage };
  }
  const message = obj.message;
  if (message && typeof message === 'object') {
    const m = message as Record<string, unknown>;
    const usage = typeof m.usage === 'object' && m.usage ? (m.usage as Record<string, unknown>) : undefined;
    const content = m.content;
    const textParts: string[] = [];
    let toolName: string | undefined;
    let toolInput: unknown;
    if (content && typeof content === 'object' && !Array.isArray(content)) {
      const c = content as Record<string, unknown>;
      if (typeof c.text === 'string') textParts.push(c.text);
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === 'object') {
          const b = block as Record<string, unknown>;
          if (b.type === 'text' && typeof b.text === 'string') textParts.push(b.text);
          if (b.type === 'tool_use') {
            toolName = typeof b.name === 'string' ? b.name : undefined;
            toolInput = b.input;
          }
        }
      }
    }
    return { text: textParts.join(''), usage, toolName, toolInput };
  }
  return null;
}

/** Run one Claude turn through the Rust-native Tauri adapter (`claude_chat_complete`). */
export async function runClaudeCliTurn(opts: ClaudeCliTurnOptions): Promise<string> {
  const result = await runClaudeNativeTurn({
    cwd: opts.cwd,
    model: opts.model ?? null,
    systemPrompt: '',
    userText: opts.prompt,
    images: [],
    effort: null,
    accessMode: null,
    sessionId: opts.sessionId ?? null,
    forkSession: opts.forkSession ?? false,
  });
  return result.text;
}

/** Options for a Claude turn routed through the Rust-native Tauri adapter. */
export interface ClaudeNativeTurnOptions {
  cwd: string;
  model?: string | null;
  systemPrompt: string;
  userText: string;
  images: string[];
  effort?: string | null;
  accessMode?: string | null;
  sessionId?: string | null;
  forkSession?: boolean;
}

/** Run one Claude turn through the Rust-native Tauri adapter (`claude_chat_complete`). */
export async function runClaudeNativeTurn(opts: ClaudeNativeTurnOptions): Promise<ClaudeAgentSdkTurnResult> {
  const result = await invoke<{ text: string; session_id: string | null }>('claude_chat_complete', {
    cwd: opts.cwd,
    model: opts.model ?? null,
    system_prompt: opts.systemPrompt,
    user_text: opts.userText,
    images: opts.images,
    effort: opts.effort ?? null,
    access_mode: opts.accessMode ?? null,
    session_id: opts.sessionId ?? null,
    fork_session: opts.forkSession ?? false,
  });
  return { text: result.text, sessionId: result.session_id ?? null };
}

/** Fork a Claude SDK session into a new native session, copying its transcript. */
export async function forkClaudeSession(sessionId: string, options?: {
  dir?: string;
  upToMessageId?: string;
  title?: string;
}): Promise<{ sessionId: string } | null> {
  try {
    const result = await invoke<{ text: string; session_id: string | null }>('claude_fork_session', {
      cwd: options?.dir ?? '',
      session_id: sessionId,
    });
    if (result.session_id) {
      return { sessionId: result.session_id };
    }
    return null;
  } catch {
    return null;
  }
}

/** Read the conversation messages of a Claude SDK session from its transcript. */
export async function getClaudeSessionMessages(sessionId: string, options?: {
  dir?: string;
  limit?: number;
}): Promise<Array<{ type: string; uuid: string }>> {
  // No Rust-native equivalent yet; the SDK reads local transcript files which
  // are not exposed through Tauri commands. Return empty so callers degrade
  // gracefully to replaying the transcript in the prompt.
  return [];
}

/** Read metadata for a single Claude SDK session by ID. */
export async function getClaudeSessionInfo(sessionId: string, options?: { dir?: string }): Promise<{
  summary?: string | null;
  customTitle?: string | null;
  firstPrompt?: string | null;
  lastModified?: number;
  cwd?: string | null;
  gitBranch?: string | null;
  tag?: string | null;
} | null> {
  // No Rust-native equivalent yet; the SDK reads local transcript files which
  // are not exposed through Tauri commands. Return null so callers degrade
  // gracefully.
  return null;
}
