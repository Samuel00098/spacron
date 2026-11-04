import { query } from '@anthropic-ai/claude-agent-sdk';

export interface ClaudeAgentSdkTurnOptions {
  prompt: string;
  cwd: string;
  model?: string | null;
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk';
  abortController?: AbortController;
  onText: (text: string) => void;
  onTool?: (name: string, input: unknown) => void;
  onResult?: (result: { text: string; usage?: unknown }) => void;
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
      opts.onResult?.({ text: finalText, usage: message.usage });
    }
  }
  return finalText;
}
