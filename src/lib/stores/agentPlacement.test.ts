import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from '$lib/stores/storeCompat';

// The store only reads the "isolate agents by default" flag; stub it so the test
// doesn't drag in the persisted-settings/zustand stack. Hoisted factories run
// before imports, so the stub can't use `writable` — it's inlined here.
const agentWorktrees = vi.hoisted(() => {
  let value = true;
  const subscribers = new Set<(v: boolean) => void>();
  return {
    subscribe(run: (v: boolean) => void) {
      run(value);
      subscribers.add(run);
      return () => subscribers.delete(run);
    },
    set(next: boolean) {
      value = next;
      for (const run of subscribers) run(value);
    },
  };
});
vi.mock('$lib/stores/settings', () => ({ agentWorktrees }));

import {
  agentPlacementRequest,
  cancelAllAgentPlacements,
  defaultAgentPlacement,
  expandSpawnPlan,
  requestAgentPlacement,
  resolveAgentPlacement,
} from './agentPlacement';

beforeEach(() => {
  cancelAllAgentPlacements();
  agentWorktrees.set(true);
});

describe('expandSpawnPlan', () => {
  it('flattens counts into one labelled entry per agent', () => {
    expect(
      expandSpawnPlan([
        { key: 'claude', label: 'Claude Code', count: 2 },
        { key: 'codex', label: 'Codex', count: 1 },
      ])
    ).toEqual([
      { key: 'claude', label: 'Claude Code 1' },
      { key: 'claude', label: 'Claude Code 2' },
      { key: 'codex', label: 'Codex' },
    ]);
  });

  it('drops zero-count presets', () => {
    expect(expandSpawnPlan([{ key: 'claude', label: 'Claude Code', count: 0 }])).toEqual([]);
  });
});

describe('defaultAgentPlacement', () => {
  it('follows the isolate-agents setting', () => {
    expect(defaultAgentPlacement()).toBe('worktree');
    agentWorktrees.set(false);
    expect(defaultAgentPlacement()).toBe('main');
  });
});

describe('requestAgentPlacement', () => {
  it('publishes the request and resolves one placement per agent', async () => {
    const pending = requestAgentPlacement({
      agents: ['Release', 'Backend', 'Frontend'],
      source: 'orchestrator',
    });

    const request = get(agentPlacementRequest);
    expect(request).toMatchObject({ agents: ['Release', 'Backend', 'Frontend'], suggested: 'worktree' });

    // A mixed answer is the point: one in the main repo, two isolated.
    resolveAgentPlacement(request!.id, ['main', 'worktree', 'worktree']);
    await expect(pending).resolves.toEqual(['main', 'worktree', 'worktree']);
    expect(get(agentPlacementRequest)).toBeNull();
  });

  it('resolves null when dismissed', async () => {
    const pending = requestAgentPlacement({ agents: ['Claude Code'], source: 'manual' });
    resolveAgentPlacement(get(agentPlacementRequest)!.id, null);
    await expect(pending).resolves.toBeNull();
  });

  it('honours an explicit suggestion over the global default', () => {
    void requestAgentPlacement({
      agents: ['Release'],
      source: 'orchestrator',
      suggested: 'main',
      suggestionReason: 'release task',
    });
    expect(get(agentPlacementRequest)).toMatchObject({ suggested: 'main', suggestionReason: 'release task' });
  });

  it('queues a second request instead of dropping it', async () => {
    const first = requestAgentPlacement({ agents: ['A'], source: 'manual' });
    const second = requestAgentPlacement({ agents: ['B'], source: 'manual' });

    // Only the head is shown; the second must survive to be asked next.
    expect(get(agentPlacementRequest)?.agents).toEqual(['A']);
    resolveAgentPlacement(get(agentPlacementRequest)!.id, ['main']);
    await expect(first).resolves.toEqual(['main']);

    expect(get(agentPlacementRequest)?.agents).toEqual(['B']);
    resolveAgentPlacement(get(agentPlacementRequest)!.id, ['worktree']);
    await expect(second).resolves.toEqual(['worktree']);
  });

  it('ignores a resolve for an unknown id', async () => {
    const pending = requestAgentPlacement({ agents: ['A'], source: 'manual' });
    const request = get(agentPlacementRequest)!;
    resolveAgentPlacement(request.id + 999, ['main']);
    expect(get(agentPlacementRequest)).not.toBeNull();
    resolveAgentPlacement(request.id, ['main']);
    await expect(pending).resolves.toEqual(['main']);
  });

  it('cancelAll dismisses everything still queued', async () => {
    const first = requestAgentPlacement({ agents: ['A'], source: 'manual' });
    const second = requestAgentPlacement({ agents: ['B'], source: 'manual' });
    cancelAllAgentPlacements();
    await expect(first).resolves.toBeNull();
    await expect(second).resolves.toBeNull();
    expect(get(agentPlacementRequest)).toBeNull();
  });
});
