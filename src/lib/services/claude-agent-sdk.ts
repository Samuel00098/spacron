import { query } from '@anthropic-ai/claude-agent-sdk';

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
