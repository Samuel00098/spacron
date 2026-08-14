import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() =>
  vi.fn(async (..._args: any[]): Promise<any> => ({
    system: { cpuPercent: 3, cpuCount: 8, memUsedBytes: 1, memTotalBytes: 2 },
    sessions: [],
  })),
);
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('$lib/utils/tauri', () => ({ isTauriRuntime: () => true }));

import {
  severityOfCpu,
  severityOfRamShare,
  severityOfSystemRam,
  memPercent,
  describeCpuShare,
  describeSystemCpu,
  formatBytes,
  groupSessionRowsByProject,
  startResourcePolling,
  stopResourcePolling,
  isResourcePanelOpen,
  POLL_INTERVAL_MS,
  IDLE_POLL_INTERVAL_MS,
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
      cpuCount: 8,
      memUsedBytes: 8 * 1024 ** 3,
      memTotalBytes: 16 * 1024 ** 3,
    });
    expect(memPercent(state)).toBeCloseTo(50, 5);
  });

  it('is null when total is zero (guards a divide-by-zero)', () => {
    const state = stateWith({
      cpuPercent: 0,
      cpuCount: 8,
      memUsedBytes: 0,
      memTotalBytes: 0,
    });
    expect(memPercent(state)).toBeNull();
  });
});

describe('severityOfSystemRam', () => {
  it('leaves an ordinary full-ish machine alone', () => {
    // The regression this exists for: the gauge borrowed the CPU thresholds
    // (70/90), so a healthy Windows desktop at 82% painted critical red.
    expect(severityOfSystemRam(70)).toBe('normal');
    expect(severityOfSystemRam(82)).toBe('normal');
  });

  it('warns only once what is left is actually running out', () => {
    expect(severityOfSystemRam(85)).toBe('warn');
    expect(severityOfSystemRam(94)).toBe('warn');
    expect(severityOfSystemRam(95)).toBe('critical');
  });

  it('is normal with no reading yet', () => {
    expect(severityOfSystemRam(null)).toBe('normal');
  });
});

describe('describeSystemCpu', () => {
  it('names the scale and the Task Manager gap', () => {
    const text = describeSystemCpu(66, 12);
    expect(text).toContain('66%');
    expect(text).toContain('12 logical processors');
    expect(text).toContain('Task Manager');
  });

  it('drops the core count when it is not known yet', () => {
    expect(describeSystemCpu(66, null)).not.toContain('logical processors');
  });

  it('says warming up before the first reading', () => {
    expect(describeSystemCpu(null, 12)).toBe('CPU — warming up');
  });
});

describe('describeCpuShare', () => {
  it('converts a machine share back into core-equivalents', () => {
    // The bug this whole normalization exists for: on a 12-thread box, one
    // core pinned is 8.3% of the machine — not the 100% sysinfo reports.
    expect(describeCpuShare(8.33, 12)).toBe('CPU 8% of machine · 1.0 of 12 cores');
    expect(describeCpuShare(50, 12)).toBe('CPU 50% of machine · 6.0 of 12 cores');
  });

  it('falls back to the share alone when the CPU count is unknown', () => {
    // Only reachable before the first snapshot lands; never show "0 cores".
    expect(describeCpuShare(25, null)).toBe('CPU 25% of machine');
    expect(describeCpuShare(25, 0)).toBe('CPU 25% of machine');
  });

  it('says unknown rather than 0% while the sampler is warming up', () => {
    expect(describeCpuShare(null, 12)).toBe('CPU unknown');
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

/**
 * The sampler walks the whole process table (~100 ms on Windows at 347
 * processes), so the cadence is not cosmetic — it is the difference between a
 * few percent of a core burning all day and not. See IDLE_POLL_INTERVAL_MS.
 */
describe('resource polling cadence', () => {
  let hidden = false;

  beforeEach(() => {
    vi.useFakeTimers();
    invoke.mockClear();
    hidden = false;
    // The suite runs on `environment: 'node'`, so there is no `document` at
    // all. `resource.ts` guards every use with `typeof document !== 'undefined'`
    // — stub the two members it touches so the hidden-tick path is reachable
    // here instead of being silently skipped.
    vi.stubGlobal('document', {
      get hidden() {
        return hidden;
      },
      addEventListener: () => {},
    });
    isResourcePanelOpen.set(false);
  });

  afterEach(() => {
    stopResourcePolling();
    isResourcePanelOpen.set(false);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('samples once immediately so the chip is not blank on open', async () => {
    startResourcePolling();
    await vi.advanceTimersByTimeAsync(0);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('uses the slow cadence while the panel is closed', async () => {
    startResourcePolling();
    await vi.advanceTimersByTimeAsync(0);
    invoke.mockClear();

    // One idle interval => exactly one sample.
    await vi.advanceTimersByTimeAsync(IDLE_POLL_INTERVAL_MS);
    expect(invoke).toHaveBeenCalledTimes(1);

    // And it is genuinely slower than the open cadence: the fast interval alone
    // must not have been enough to produce that sample.
    expect(IDLE_POLL_INTERVAL_MS).toBeGreaterThan(POLL_INTERVAL_MS);
  });

  it('does not sample at the fast cadence while the panel is closed', async () => {
    startResourcePolling();
    await vi.advanceTimersByTimeAsync(0);
    invoke.mockClear();

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('speeds up and samples at once when the panel opens', async () => {
    startResourcePolling();
    await vi.advanceTimersByTimeAsync(0);
    invoke.mockClear();

    isResourcePanelOpen.set(true);
    await vi.advanceTimersByTimeAsync(0);
    // Opening is a deliberate "tell me now" — don't make the user wait out the
    // remainder of a slow tick.
    expect(invoke).toHaveBeenCalledTimes(1);

    invoke.mockClear();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('drops back to the slow cadence when the panel closes', async () => {
    startResourcePolling();
    isResourcePanelOpen.set(true);
    await vi.advanceTimersByTimeAsync(0);

    isResourcePanelOpen.set(false);
    await vi.advanceTimersByTimeAsync(0);
    invoke.mockClear();

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(invoke).not.toHaveBeenCalled();
  });

  /**
   * Regression: the schedule is a self-rescheduling timeout, so an early
   * `return` on the hidden check would end the chain and stop polling for the
   * rest of the session after a single hidden tick.
   */
  it('keeps polling after a tick that was skipped for being hidden', async () => {
    startResourcePolling();
    await vi.advanceTimersByTimeAsync(0);
    invoke.mockClear();

    hidden = true;
    await vi.advanceTimersByTimeAsync(IDLE_POLL_INTERVAL_MS);
    expect(invoke).not.toHaveBeenCalled();

    hidden = false;
    await vi.advanceTimersByTimeAsync(IDLE_POLL_INTERVAL_MS);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('stops cleanly, leaving no timer behind', async () => {
    startResourcePolling();
    await vi.advanceTimersByTimeAsync(0);
    stopResourcePolling();
    invoke.mockClear();

    await vi.advanceTimersByTimeAsync(IDLE_POLL_INTERVAL_MS * 3);
    expect(invoke).not.toHaveBeenCalled();
  });
});
