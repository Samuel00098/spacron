import { describe, expect, it } from 'vitest';
import { activityFromAcpUpdate } from './acp-activity';

describe('ACP activity projection', () => {
  it('projects tool and file updates', () => {
    expect(activityFromAcpUpdate({
      params: { update: { sessionUpdate: 'tool_call_update', toolCall: { title: 'Edit file', path: 'src/app.ts', status: 'completed' } } },
    })).toEqual({ kind: 'file', label: 'Edit file (completed)', detail: 'src/app.ts', status: 'completed' });
  });

  it('carries the tool-call id and status so updates rewrite the same row', () => {
    expect(activityFromAcpUpdate({
      params: { update: { sessionUpdate: 'tool_call', toolCall: { toolCallId: 'call-1', title: 'Run tests', status: 'in_progress' } } },
    })).toEqual({ kind: 'tool', id: 'call-1', label: 'Run tests (in_progress)', status: 'in_progress' });
  });

  it('ignores streamed message chunks', () => {
    expect(activityFromAcpUpdate({ params: { update: { sessionUpdate: 'agent_message_chunk', content: 'hi' } } })).toBeNull();
  });

  it('projects compaction, terminal, and state updates', () => {
    expect(activityFromAcpUpdate({
      params: { update: { sessionUpdate: 'compaction_started' } },
    })).toMatchObject({ kind: 'plan', label: 'Compacting conversation' });
    expect(activityFromAcpUpdate({
      params: { update: { sessionUpdate: 'terminal_update', title: 'Running tests', status: 'in_progress' } },
    })).toMatchObject({ kind: 'tool', label: 'Terminal Running tests (in_progress)' });
    expect(activityFromAcpUpdate({
      params: { update: { sessionUpdate: 'state_update', state: 'waiting' } },
    })).toMatchObject({ kind: 'status', label: 'Agent state: state update' });
  });
});
