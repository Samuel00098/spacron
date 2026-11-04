import { invoke } from '@tauri-apps/api/core';
import type { ChatMessage, ChatMessageRole, ChatMessageType } from '$lib/types/chat';
import { parseClaudeJsonLine } from './claude-agent-sdk';

export interface ClaudeSessionImportResult {
  success: boolean;
  threadId?: string;
  error?: string;
  messagesImported: number;
}

export interface ClaudeSessionParseOptions {
  /** If true, convert tool_use blocks into regular text markers */
  convertToolsToText?: boolean;
}

export function parseClaudeJsonlText(text: string, opts: ClaudeSessionParseOptions = {}): {
  messages: ChatMessage[];
  sessionId: string | null;
  toolEvents: Array<{ name: string; input: unknown }>;
} {
  const lines = text.split('\n').filter((l) => l.trim());
  const messages: ChatMessage[] = [];
  const toolEvents: Array<{ name: string; input: unknown }> = [];

  for (const line of lines) {
    const parsed = parseClaudeJsonLine(line);
    if (!parsed) continue;

    if (parsed.toolName) {
      toolEvents.push({ name: parsed.toolName, input: parsed.toolInput });
      if (opts.convertToolsToText) {
        messages.push({
          id: `import-${toolEvents.length}`,
          threadId: 'import-placeholder',
          type: 'activity' as ChatMessageType,
          role: 'assistant',
          text: `[tool:${parsed.toolName}]`,
          ts: Date.now(),
        });
      }
      continue;
    }

    // Heuristic: if text contains model info or assistant markers, treat as assistant
    let role: ChatMessageRole = 'user';
    if (parsed.text) {
      const lower = parsed.text.toLowerCase();
      if (/you are powered by|as an assistant|i am.*assistant|note:/.test(lower)) {
        role = 'assistant';
      }
    }

    messages.push({
      id: `import-${messages.length + toolEvents.length}`,
      threadId: 'import-placeholder',
      type: role === 'assistant' ? ('agent' as ChatMessageType) : ('user' as ChatMessageType),
      role,
      text: parsed.text ?? '',
      ts: Date.now(),
    });
  }

  return { messages, sessionId: null, toolEvents };
}

export async function importClaudeSessionFromFilePath(
  filePath: string,
): Promise<{ messages: ChatMessage[]; toolEvents: Array<{ name: string; input: unknown }> }> {
  const content = await invoke<string>('fs_read_file', { path: filePath });
  return parseClaudeJsonlText(content);
}

export function importClaudeSessionToThread(
  filePath: string,
  threadId?: string,
  opts: ClaudeSessionParseOptions = {},
): ClaudeSessionImportResult {
  return { success: false, error: 'Use importClaudeSessionFromFilePath instead.', messagesImported: 0 };
}