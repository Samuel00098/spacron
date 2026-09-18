import { describe, expect, it } from 'vitest';
import {
  BRAIN_ASK_TOOLS,
  BRAIN_READONLY_TOOLS,
  BRAIN_WRITE_TOOLS,
  brainToolSignature,
  formatBrainToolResults,
  isDoomLoop,
  parseBrainToolCalls,
  toolArgBool,
  toolArgNum,
  toolArgStrArr,
} from './brain-tools';

describe('parseBrainToolCalls', () => {
  it('parses a tool request', () => {
    const calls = parseBrainToolCalls(
      '{"tool_calls":[{"id":"1","name":"read_file","args":{"path":"package.json"}}]}',
    );
    expect(calls).toEqual([{ id: '1', name: 'read_file', args: { path: 'package.json' } }]);
  });

  it('returns null for a final answer', () => {
    expect(parseBrainToolCalls('{"reply":"Hi.","actions":[]}')).toBeNull();
  });

  it('drops unknown tools without silently dropping later valid calls', () => {
    const calls = parseBrainToolCalls(
      '{"tool_calls":[' +
        '{"name":"read_file","args":{"path":"a"}}' +
        ',{"name":"nope","args":{}}' +
        ',{"name":"list_agents","args":{}}' +
        ',{"name":"list_terminals","args":{}}' +
        ',{"name":"get_agent_output","args":{"name":"Iris"}}' +
        ',{"name":"ask_user","args":{"question":"Q?"}}' +
        ',{"name":"glob_files","args":{"pattern":"src/**"}}' +
        ',{"name":"grep_code","args":{"query":"x"}}' +
        ',{"name":"wait_for_agent","args":{"name":"Iris"}}' +
        ',{"name":"ask_question","args":{"question":"Q?"}}' +
        ',{"name":"write_file","args":{"path":"a","content":"b"}}]}',
    );
    expect(calls?.map((c) => c.name)).toEqual([
      'read_file',
      'list_agents',
      'list_terminals',
      'get_agent_output',
      'ask_user',
      'glob_files',
      'grep_code',
      'wait_for_agent',
      'ask_question',
      'write_file',
    ]);
  });

  it('tolerates fences and stray prose', () => {
    const calls = parseBrainToolCalls(
      'Sure — checking.\n```json\n{"tool_calls":[{"name":"list_agents","args":{}}]}\n```',
    );
    expect(calls?.[0].name).toBe('list_agents');
  });
});

describe('formatBrainToolResults', () => {
  it('renders ok/error results compactly', () => {
    const text = formatBrainToolResults([
      { id: '1', name: 'read_file', ok: true, output: 'hello' },
      { id: '2', name: 'list_agents', ok: false, output: 'boom' },
    ]);
    expect(text).toContain('tool_result 1 (read_file, ok)');
    expect(text).toContain('tool_result 2 (list_agents, error)');
  });
});

describe('coordinator tool families', () => {
  it('parses the new file/search/wait/question tools', () => {
    const calls = parseBrainToolCalls(
      '{"tool_calls":[' +
        '{"name":"read_project","args":{"max_files":80}}' +
        ',{"name":"glob_files","args":{"pattern":"src/**"}}' +
        ',{"name":"grep_code","args":{"query":"auth"}}' +
        ',{"name":"write_file","args":{"path":"a.md","content":"hi"}}' +
        ',{"name":"edit_file","args":{"path":"a","old_string":"x","new_string":"y"}}' +
        ',{"name":"run_command","args":{"command":"npm test"}}' +
        ',{"name":"wait_for_agent","args":{"name":"Iris"}}' +
        ',{"name":"ask_question","args":{"question":"Q?","options":["A","B"]}}]}',
    );
    expect(calls?.map((c) => c.name)).toEqual([
      'read_project',
      'glob_files',
      'grep_code',
      'write_file',
      'edit_file',
      'run_command',
      'wait_for_agent',
      'ask_question',
    ]);
  });

  it('splits read-only, write, and ask families', () => {
    for (const t of ['read_project', 'read_file', 'glob_files', 'grep_code', 'list_terminals', 'list_agents', 'get_agent_output', 'wait_for_agent'] as const) {
      expect(BRAIN_READONLY_TOOLS.has(t)).toBe(true);
      expect(BRAIN_WRITE_TOOLS.has(t)).toBe(false);
    }
    for (const t of ['write_file', 'edit_file', 'run_command'] as const) {
      expect(BRAIN_WRITE_TOOLS.has(t)).toBe(true);
      expect(BRAIN_READONLY_TOOLS.has(t)).toBe(false);
    }
    expect(BRAIN_ASK_TOOLS.has('ask_user')).toBe(true);
    expect(BRAIN_ASK_TOOLS.has('ask_question')).toBe(true);
  });

  it('detects doom loops on identical signatures', () => {
    const sig = brainToolSignature({ name: 'list_agents', args: {} });
    expect(isDoomLoop([sig, sig])).toBe(false);
    expect(isDoomLoop([sig, sig, sig])).toBe(true);
    expect(isDoomLoop([sig, sig, brainToolSignature({ name: 'list_agents', args: { x: 1 } })])).toBe(false);
  });

  it('parses numeric/boolean/string-array args', () => {
    expect(toolArgNum({ max: '25' }, 'max', 20)).toBe(25);
    expect(toolArgNum({}, 'max', 20)).toBe(20);
    expect(toolArgBool({ use_regex: 'true' }, 'use_regex', false)).toBe(true);
    expect(toolArgBool({}, 'use_regex', false)).toBe(false);
    expect(toolArgStrArr({ options: ['A', ' B ', 1, ''] }, 'options')).toEqual(['A', 'B']);
  });
});
