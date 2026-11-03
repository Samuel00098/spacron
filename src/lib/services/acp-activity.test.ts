import { describe, expect, it } from 'vitest';
import { activityFromAcpUpdate } from './acp-activity';

describe('ACP activity projection', () => {
  it('projects tool and file updates', () => {
    expect(activityFromAcpUpdate({
      params: { update: { sessionUpdate: 'tool_call_update', toolCall: { title: 'Edit file', path: 'src/app.ts', status: 'completed' } } },
    })).toEqual({ kind: 'file', label: 'Edit file (completed)', detail: 'src/app.ts' });
  });

  it('ignores streamed message chunks', () => {
    expect(activityFromAcpUpdate({ params: { update: { sessionUpdate: 'agent_message_chunk', content: 'hi' } } })).toBeNull();
  });
});
