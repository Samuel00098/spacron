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
});
