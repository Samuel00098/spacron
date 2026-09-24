import { describe, expect, it } from 'vitest';
import {
  agentUpdateInboxEntries,
  commandOfUpdateEntry,
  isAgentUpdateEntry,
  type AgentUpdatesState,
} from './agentUpdates';

const codex = {
  command: 'codex',
  package: '@openai/codex',
  installed: '0.150.0',
  latest: '0.156.1',
  updateAvailable: true,
};

function state(overrides: Partial<AgentUpdatesState> = {}): AgentUpdatesState {
  return { byCommand: { codex }, updating: [], checking: false, lastCheckedAt: 1000, ...overrides };
}

const noNotices = { read: [], cleared: [], firstSeen: {}, failures: [] };

describe('agentUpdateInboxEntries', () => {
  it('lists an available update as an unread update row', () => {
    const [entry] = agentUpdateInboxEntries(state(), noNotices);
    expect(entry).toMatchObject({
      id: 'agent-update:codex:0.156.1',
      kind: 'update',
      status: 'update',
      read: false,
      title: 'Update available: 0.156.1',
    });
    expect(entry.body).toContain('0.150.0 → 0.156.1');
  });

  it('keeps the first-seen time so the row does not jump on every check', () => {
    const [entry] = agentUpdateInboxEntries(state({ lastCheckedAt: 9999 }), {
      ...noNotices,
      firstSeen: { 'agent-update:codex:0.156.1': 42 },
    });
    expect(entry.ts).toBe(42);
  });

  it('drops rows that are up to date or cleared, and honours read', () => {
    expect(
      agentUpdateInboxEntries(state({ byCommand: { codex: { ...codex, updateAvailable: false } } }), noNotices),
    ).toEqual([]);
    expect(
      agentUpdateInboxEntries(state(), { ...noNotices, cleared: ['agent-update:codex:0.156.1'] }),
    ).toEqual([]);
    const [entry] = agentUpdateInboxEntries(state(), { ...noNotices, read: ['agent-update:codex:0.156.1'] });
    expect(entry.read).toBe(true);
  });

  it('a newer version is a new notice even if the old one was cleared', () => {
    const newer = { ...codex, latest: '0.157.0' };
    const entries = agentUpdateInboxEntries(state({ byCommand: { codex: newer } }), {
      ...noNotices,
      cleared: ['agent-update:codex:0.156.1'],
    });
    expect(entries.map((e) => e.id)).toEqual(['agent-update:codex:0.157.0']);
  });

  it('says so while the update runs', () => {
    const [entry] = agentUpdateInboxEntries(state({ updating: ['codex'] }), noNotices);
    expect(entry.title).toBe('Updating to 0.156.1…');
  });

  it('shows a failure as an actionable failed row', () => {
    const failure = { id: 'agent-update:failed:dsh:5', command: 'dsh', name: 'DeepSeek Harness', message: 'npm error code EBUSY', ts: 5 };
    const entries = agentUpdateInboxEntries(state({ byCommand: {} }), { ...noNotices, failures: [failure] });
    expect(entries).toEqual([
      expect.objectContaining({ id: failure.id, status: 'failed', actionable: true, body: 'npm error code EBUSY' }),
    ]);
  });
});

describe('update entry ids', () => {
  it('recovers the command from both kinds of id', () => {
    expect(commandOfUpdateEntry('agent-update:codex:0.156.1')).toBe('codex');
    expect(commandOfUpdateEntry('agent-update:failed:dsh:123')).toBe('dsh');
    expect(commandOfUpdateEntry('msg-1')).toBeNull();
    expect(isAgentUpdateEntry('agent-update:x:1')).toBe(true);
    expect(isAgentUpdateEntry('completion-1')).toBe(false);
  });
});
