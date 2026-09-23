import { beforeEach, describe, expect, it } from 'vitest';
import { saveTurnEdits, loadTurnEdits, clearTurnEdits, resetTurnEditsForTests } from './turn-edit-undo';

// The node test environment has no `indexedDB`, so these cases exercise the
// in-memory path the module falls back to. What they pin down is the contract
// the store owes its caller either way: a record read back whole, a record
// dropped once used, and — the part that matters — every call resolving
// instead of throwing when durable storage is unreachable. A turn must never
// fail because its undo record could not be written.
describe('turn-edit-undo', () => {
  beforeEach(() => resetTurnEditsForTests());

  it('reads back exactly what a turn recorded', async () => {
    await saveTurnEdits('thread-1', [
      { path: 'convex/segments.ts', original: 'before', written: 'after' },
      { path: 'notes/new.md', original: null, written: 'fresh' },
    ]);
    expect(await loadTurnEdits('thread-1')).toEqual([
      { path: 'convex/segments.ts', original: 'before', written: 'after' },
      { path: 'notes/new.md', original: null, written: 'fresh' },
    ]);
  });

  it('keeps conversations apart and reports an unknown one as empty', async () => {
    await saveTurnEdits('thread-1', [{ path: 'a.ts', original: 'a', written: 'b' }]);
    expect(await loadTurnEdits('thread-2')).toEqual([]);
  });

  it('replaces the previous turn rather than accumulating', async () => {
    await saveTurnEdits('thread-1', [{ path: 'a.ts', original: 'a', written: 'b' }]);
    await saveTurnEdits('thread-1', [{ path: 'c.ts', original: 'c', written: 'd' }]);
    expect(await loadTurnEdits('thread-1')).toEqual([{ path: 'c.ts', original: 'c', written: 'd' }]);
  });

  it('offers an applied undo only once', async () => {
    await saveTurnEdits('thread-1', [{ path: 'a.ts', original: 'a', written: 'b' }]);
    await clearTurnEdits('thread-1');
    expect(await loadTurnEdits('thread-1')).toEqual([]);
  });

  it('resolves rather than throwing when there is nothing to clear', async () => {
    await expect(clearTurnEdits('never-seen')).resolves.toBeUndefined();
  });
});
