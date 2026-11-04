import { query } from '@anthropic-ai/claude-agent-sdk';
import { spawn } from 'child_process';

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
  onText: (text: string) => void;
  onTool?: (name: string, input: unknown) => void;
  onUsage?: (usage: ClaudeUsage) => void;
}

export async function runClaudeAgentSdkTurn(opts: ClaudeAgentSdkTurnOptions): Promise<string> {
  const q = query({
    prompt: opts.prompt,
    options: {
      cwd: opts.cwd,
      model: opts.model && opts.model !== 'default' ? opts.model : undefined,
      permissionMode: opts.permissionMode ?? 'default',
      abortController: opts.abortController,
    },
  });

  let finalText = '';
  for await (const message of q) {
    if (message.type === 'assistant') {
      for (const block of message.message.content ?? []) {
        if (block.type === 'text') {
          finalText += block.text;
          opts.onText(finalText);
        } else if (block.type === 'tool_use') {
          opts.onTool?.(block.name, block.input);
        }
      }
    } else if (message.type === 'result') {
      const u: Record<string, unknown> | null = message.usage ?? null;
      const usage: ClaudeUsage = {
        inputTokens: u?.['input_tokens'] as number | undefined,
        outputTokens: u?.['output_tokens'] as number | undefined,
        cacheReadTokens: u?.['cache_read_input_tokens'] as number | undefined,
        cacheWriteTokens: u?.['cache_write_input_tokens'] as number | undefined,
        cost: u?.['cost'] as number | undefined,
      };
      opts.onUsage?.(usage);
    }
  }
  return finalText;
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

export async function runClaudeCliTurn(opts: ClaudeCliTurnOptions): Promise<string> {
  const args = [
    '-p',
    opts.prompt,
    '--output-format',
    'stream-json',
    '--permission-mode',
    opts.permissionMode ?? 'default',
  ];
  if (opts.model && opts.model !== 'default') args.push('--model', opts.model);
  const child = spawn('claude', args, { cwd: opts.cwd });

  let finalText = '';
  let buf = '';
  const emitText = (value: string) => {
    finalText += value;
    opts.onText(finalText);
  };

  const textStream = child.stdout as NodeJS.ReadableStream;
  textStream.on('data', (chunk: Buffer | string) => {
    buf += chunk.toString();
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      const parsed = parseClaudeJsonLine(line);
      if (!parsed) continue;
      if (parsed.text) emitText(parsed.text);
      if (parsed.usage) opts.onUsage?.({
        inputTokens: parsed.usage['input_tokens'] as number | undefined,
        outputTokens: parsed.usage['output_tokens'] as number | undefined,
        cacheReadTokens: parsed.usage['cache_read_input_tokens'] as number | undefined,
        cacheWriteTokens: parsed.usage['cache_write_input_tokens'] as number | undefined,
        cost: parsed.usage['cost'] as number | undefined,
      });
      if (parsed.toolName) opts.onTool?.(parsed.toolName, parsed.toolInput);
    }
  });

  await new Promise<void>((resolve, reject) => {
    const abort = () => { child.kill('SIGTERM'); reject(new Error('Claude CLI turn aborted')); };
    if (opts.signal) {
      opts.signal.addEventListener('abort', abort, { once: true });
    }
    child.on('error', reject);
    child.on('close', () => resolve());
    child.stderr.on('data', () => {});
  });
  if (opts.signal) {
    opts.signal.removeEventListener('abort', () => {});
  }
  return finalText;
}
