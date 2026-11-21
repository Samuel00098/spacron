import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

import { accessPolicy, chatItemFor, patchText } from './codex-session';

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


