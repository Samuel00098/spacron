import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('$lib/stores/agentAccounts', () => ({ accountEnvFor: vi.fn(async () => ({})) }));
vi.mock('./visuals', () => ({ prepareStructuredVisuals: vi.fn(async () => ({})) }));

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { accessPolicy, chatItemFor, codexProvider, patchText } from './codex-session';

it('starts the thread and first turn with the chosen model even if the catalog omits it', async () => {
  vi.mocked(listen).mockResolvedValue(() => {});
  const responses: Record<string, unknown> = {
    'model/list': { data: [{ id: 'gpt-default', isDefault: true }] },
    'thread/start': { thread: { id: 'thread-1' } },
    'turn/start': { turn: { id: 'turn-1' } },
  };
  const requests: Array<{ method: string; params: unknown }> = [];
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === 'codex_app_server_launch') return { command: 'codex', args: [], env: {} };
    if (command === 'acp_start') return { id: 1 };
    if (command === 'acp_request' && args && 'method' in args && typeof args.method === 'string') {
      requests.push({ method: args.method, params: 'params' in args ? args.params : undefined });
      return { result: responses[args.method] ?? {} };
    }
  });

  const model = 'gpt-6.2-astra';
  await codexProvider.start(123, '/repo', { model, effort: 'high' });
  expect(codexProvider.get(123)).toMatchObject({ status: 'ready', model, effort: 'high' });
  await codexProvider.send(123, 'Review this change');
  expect(requests).toEqual(expect.arrayContaining([
    { method: 'thread/start', params: expect.objectContaining({ model }) },
    { method: 'turn/start', params: expect.objectContaining({ model, effort: 'high' }) },
  ]));
  await codexProvider.close(123);
});

// Item shapes from `codex app-server generate-ts` (0.171) and a live run.
describe('Codex thread items in the chat', () => {
  it('shows messages, reasoning and failed turns', () => {
    expect(chatItemFor({
      type: 'userMessage', id: 'u1', clientId: null,
      content: [{ type: 'text', text: 'reply with the single word pong', text_elements: [] }],
    })).toEqual({ id: 'u1', kind: 'user', text: 'reply with the single word pong' });
    expect(chatItemFor({ type: 'agentMessage', id: 'a1', text: 'pong', phase: null })).toEqual({ id: 'a1', kind: 'assistant', text: 'pong' });
    expect(chatItemFor({ type: 'reasoning', id: 'r1', summary: ['Thinking', 'More'], content: [] })?.text).toBe('Thinking\n\nMore');
    expect(chatItemFor({ type: 'hookPrompt', id: 'h1', fragments: [] })).toBeNull();
  });

  it('shows a command as a run the tool rows understand', () => {
    const item = chatItemFor({ type: 'commandExecution', id: 'c1', command: 'rg TODO src', status: 'completed', exitCode: 0, aggregatedOutput: 'a.ts:1' })!;
    expect(item.toolStatus).toBe('done');
    expect(item.toolName).toBe('shell');
    const failed = chatItemFor({ type: 'commandExecution', id: 'c2', command: 'npm test', status: 'completed', exitCode: 1 })!;
    expect(failed.toolStatus).toBe('error');
    expect(chatItemFor({ type: 'commandExecution', id: 'c3', command: 'npm test', status: 'inProgress' })!.toolStatus).toBe('running');
  });

  it('shows a file change with its diff', () => {
    const changes = [
      { path: 'src/a.ts', kind: { type: 'update', move_path: null }, diff: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n' },
      { path: 'src/b.ts', kind: { type: 'add' }, diff: 'one\ntwo\n' },
    ];
    expect(patchText(changes)).toContain('*** Update File: src/a.ts');
    const item = chatItemFor({ type: 'fileChange', id: 'f1', changes, status: 'completed' })!;
    expect(item.toolInput).toContain('*** Update File: src/a.ts');
    expect(item.toolInput).toContain('*** Add File: src/b.ts');
  });

  it('runs each access level under the matching approval policy and sandbox', () => {
    expect(accessPolicy('ask', 'C:\\w')).toMatchObject({ approvalPolicy: 'on-request', sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['C:\\w'] } });
    expect(accessPolicy('auto', 'C:\\w')).toMatchObject({ approvalPolicy: 'never', sandboxPolicy: { type: 'workspaceWrite' } });
    expect(accessPolicy('full-access', 'C:\\w')).toEqual({ approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } });
  });
});


