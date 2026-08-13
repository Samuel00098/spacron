import { describe, expect, it } from 'vitest';
import {
  severityOfCpu,
  severityOfRamShare,
  memPercent,
  formatBytes,
  groupSessionRowsByProject,
  type ResourceState,
  type ResourceSnapshot,
  type JoinedSessionRow,
} from './resource';

function stateWith(system: ResourceSnapshot['system'] | null): ResourceState {
  return { system, sessions: [], loading: false, lastFetchedAt: 0 };
}

function row(overrides: Partial<JoinedSessionRow> & { sessionId: number }): JoinedSessionRow {
  return {
    pid: 1000 + overrides.sessionId,
    cpuPercent: 0,
    memBytes: 0,
    processCount: 1,
    alive: true,
    displayName: `Terminal ${overrides.sessionId}`,
    brandCommand: null,
    brandName: null,
    projectId: null,
    ...overrides,
  };
}

describe('severityOfCpu', () => {
  it('is normal below the warn threshold', () => {
    expect(severityOfCpu(0)).toBe('normal');
    expect(severityOfCpu(69)).toBe('normal');
    expect(severityOfCpu(null)).toBe('normal');
  });

  it('warns at 70–89', () => {
    expect(severityOfCpu(70)).toBe('warn');
    expect(severityOfCpu(89)).toBe('warn');
  });

  it('goes critical at 90', () => {
    expect(severityOfCpu(90)).toBe('critical');
    expect(severityOfCpu(120)).toBe('critical');
  });
});

describe('severityOfRamShare', () => {
  it('is normal below the warn threshold', () => {
    expect(severityOfRamShare(0)).toBe('normal');
    expect(severityOfRamShare(29.9)).toBe('normal');
    expect(severityOfRamShare(null)).toBe('normal');
  });

  it('warns at 30–49% of machine RAM', () => {
    expect(severityOfRamShare(30)).toBe('warn');
    expect(severityOfRamShare(49)).toBe('warn');
  });

  it('goes critical at half the machine', () => {
    expect(severityOfRamShare(50)).toBe('critical');
    expect(severityOfRamShare(90)).toBe('critical');
  });
});

describe('memPercent', () => {
  it('is null before the first system reading', () => {
    expect(memPercent(stateWith(null))).toBeNull();
  });

  it('reports the used share', () => {
    const state = stateWith({
      cpuPercent: 12,
      memUsedBytes: 8 * 1024 ** 3,
      memTotalBytes: 16 * 1024 ** 3,
    });
    expect(memPercent(state)).toBeCloseTo(50, 5);
  });

  it('is null when total is zero (guards a divide-by-zero)', () => {
    const state = stateWith({
      cpuPercent: 0,
      memUsedBytes: 0,
      memTotalBytes: 0,
    });
    expect(memPercent(state)).toBeNull();
  });
});

describe('formatBytes', () => {
  it('formats gigabytes', () => {
    expect(formatBytes(3.4 * 1024 ** 3)).toBe('3.4 GB');
  });

  it('formats megabytes', () => {
    expect(formatBytes(842 * 1024 ** 2)).toBe('842 MB');
  });

  it('formats kilobytes and raw bytes', () => {
    expect(formatBytes(512 * 1024)).toBe('512 KB');
    expect(formatBytes(900)).toBe('900 B');
  });

  it('does not crash on garbage', () => {
    expect(formatBytes(Number.NaN)).toBe('—');
    expect(formatBytes(-5)).toBe('—');
  });
});

describe('groupSessionRowsByProject', () => {
  const projects = new Map([
    ['alpha', { name: 'Alpha', root_path: 'C:/repos/alpha' }],
    ['beta', { name: 'Beta', root_path: 'C:/repos/beta' }],
  ]);

  it('orders open projects by tab order, then alphabetical, "Other" last', () => {
    const rows = [
      row({ sessionId: 1, projectId: 'beta' }),
      row({ sessionId: 2, projectId: null }),
      row({ sessionId: 3, projectId: 'alpha' }),
    ];
    const groups = groupSessionRowsByProject(rows, projects, ['alpha', 'beta']);
    expect(groups.map((g) => g.name)).toEqual(['Alpha', 'Beta', 'Other']);
  });

  it('puts sessions of closed projects in "Other"', () => {
    const rows = [row({ sessionId: 1, projectId: 'gone' })];
    const groups = groupSessionRowsByProject(rows, projects, []);
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe('Other');
    expect(groups[0].rows).toHaveLength(1);
  });

  it('skips empty projects (no running sessions)', () => {
    const rows = [row({ sessionId: 1, projectId: 'alpha' })];
    const groups = groupSessionRowsByProject(rows, projects, ['alpha', 'beta']);
    expect(groups.map((g) => g.name)).toEqual(['Alpha']);
  });

  it('sums CPU/RAM/processes over live rows only', () => {
    const rows = [
      row({ sessionId: 1, projectId: 'alpha', cpuPercent: 30, memBytes: 100, processCount: 2 }),
      row({ sessionId: 2, projectId: 'alpha', cpuPercent: 10, memBytes: 50, processCount: 3 }),
      row({ sessionId: 3, projectId: 'alpha', cpuPercent: 90, memBytes: 999, processCount: 9, alive: false }),
    ];
    const [group] = groupSessionRowsByProject(rows, projects, ['alpha']);
    expect(group.cpuPercent).toBe(40);
    expect(group.memBytes).toBe(150);
    expect(group.processCount).toBe(5);
  });
});
