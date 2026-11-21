import { rollupChanges } from '$lib/services/terminal-chat-rich';
import { describe, expect, it } from 'vitest';
import { chatItemForClaude } from './claude-session';
import { chatItemForAcpUpdate, modelsFrom } from './acp-session';
import { chatItemForPi } from './pi-session';

describe('structured driver event mappings', () => {
  it('maps Claude assistant stream-json', () => {
    expect(chatItemForClaude({ type: 'assistant', uuid: 'claude-1', message: { content: [{ type: 'text', text: 'pong' }] } })).toEqual({ id: 'claude-1', kind: 'assistant', text: 'pong' });
  });

  for (const agent of ['opencode', 'grok', 'antigravity', 'cursor', 'copilot', 'kimi', 'hermes', 'omp']) {
    it(`maps ${agent} ACP agent message chunks`, () => {
      expect(chatItemForAcpUpdate(agent, { method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'pong' }, id: `${agent}-1` } } })).toEqual({ id: `${agent}-1`, kind: 'assistant', text: 'pong' });
    });
  }

  it('maps Pi RPC assistant messages', () => {
    expect(chatItemForPi({ type: 'message', id: 'pi-1', text: 'pong' })).toEqual({ id: 'pi-1', kind: 'assistant', text: 'pong' });
  });

  it('reads the ACP v2 model config option returned for the connected account', () => {
    expect(modelsFrom({
      configOptions: [{
        configId: 'model',
        type: 'select',
        currentValue: 'account-model',
        options: [
          { value: 'account-model', name: 'Account model' },
          { value: 'fallback-model', name: 'Fallback model' },
        ],
      }],
    })).toEqual([
      { id: 'account-model', label: 'Account model', description: null, efforts: [], defaultEffort: null, isDefault: true },
      { id: 'fallback-model', label: 'Fallback model', description: null, efforts: [], defaultEffort: null, isDefault: false },
    ]);
  });

  it('keeps ACP chunks and tool updates on the same rich item', () => {
    expect(chatItemForAcpUpdate('opencode', { params: { update: { sessionUpdate: 'agent_message_chunk', content: [{ type: 'text', text: 'hel' }] } } }, 'assistant-1')).toEqual({ id: 'assistant-1', kind: 'assistant', text: 'hel' });
    expect(chatItemForAcpUpdate('opencode', { params: { update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed', content: [{ type: 'text', text: 'done' }] } } })).toMatchObject({ id: 'tool-1', kind: 'tool', toolOutput: 'done', toolStatus: 'done' });
  });

  it('maps structured ACP diffs and edit locations into the turn file summary', () => {
    const diff = chatItemForAcpUpdate('antigravity', {
      sessionUpdate: 'tool_call_update', toolCallId: 'edit', status: 'completed',
      content: [{ type: 'diff', path: 'src/edit.ts', oldText: 'before', newText: 'after' }],
    });
    const deletion = chatItemForAcpUpdate('antigravity', {
      sessionUpdate: 'tool_call', toolCallId: 'delete', status: 'completed',
      kind: 'delete', locations: [{ path: 'src/remove.ts' }],
    });
    expect(rollupChanges([diff!, deletion!])).toEqual([
      { path: 'src/edit.ts', added: 1, removed: 1, created: false, deleted: false },
      { path: 'src/remove.ts', added: 0, removed: 0, created: false, deleted: true },
    ]);
  });

  it('accepts Pi stream deltas with an explicit shared fallback id', () => {
    expect(chatItemForPi({ type: 'message_update', delta: 'hel' }, 'pi-assistant-1')).toEqual({ id: 'pi-assistant-1', kind: 'assistant', text: 'hel' });
  });
});
