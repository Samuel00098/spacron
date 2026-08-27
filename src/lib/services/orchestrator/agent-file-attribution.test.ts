import { beforeEach, describe, expect, it } from 'vitest';

import {
  recordDiffReading,
  filesOwnedBy,
  isSharedFile,
  ownersOf,
  unattributedCount,
  __resetAttributionForTest,
} from './agent-file-attribution';

const REPO = '<root>@HEAD';

function file(path: string, additions = 1, deletions = 0, status = 'modified') {
  return { path, additions, deletions, status };
}

/** Agent output counters, as `getSessionOutputProduced` would report them. */
function at(...pairs: Array<[number, number]>) {
  return pairs.map(([sessionId, produced]) => ({ sessionId, produced }));
}

describe('main-repo file attribution', () => {
  beforeEach(() => {
    __resetAttributionForTest();
  });

  it('credits a file to the only agent that was producing output', () => {
    recordDiffReading(REPO, at([1, 0], [2, 0]), []);
    // Agent 1 worked, agent 2 said nothing.
    recordDiffReading(REPO, at([1, 500], [2, 0]), [file('src/a.ts')]);

    expect(ownersOf(REPO, 'src/a.ts')).toEqual([1]);
    expect(filesOwnedBy(REPO, 1, [file('src/a.ts')])).toHaveLength(1);
    expect(filesOwnedBy(REPO, 2, [file('src/a.ts')])).toHaveLength(0);
  });

  it('leaves changes that predate the first reading unattributed', () => {
    // The panel opens onto a checkout that is already dirty. Nothing about
    // those files is evidence of any agent, so no card may claim them.
    recordDiffReading(REPO, at([1, 100], [2, 200]), [file('src/old.ts'), file('src/older.ts')]);

    expect(ownersOf(REPO, 'src/old.ts')).toEqual([]);
    expect(filesOwnedBy(REPO, 1, [file('src/old.ts')])).toHaveLength(0);
    expect(filesOwnedBy(REPO, 2, [file('src/old.ts')])).toHaveLength(0);
  });

  it("leaves the user's own edits unattributed", () => {
    // The whole point of the panel complaint: files the user changed while the
    // agents sat idle must not appear on any agent's card.
    recordDiffReading(REPO, at([1, 100]), []);
    recordDiffReading(REPO, at([1, 100]), [file('README.md')]); // agent produced nothing

    expect(ownersOf(REPO, 'README.md')).toEqual([]);
    expect(filesOwnedBy(REPO, 1, [file('README.md')])).toHaveLength(0);
  });

  it('marks a file shared when several agents were working over the interval', () => {
    recordDiffReading(REPO, at([1, 0], [2, 0]), []);
    recordDiffReading(REPO, at([1, 300], [2, 400]), [file('src/shared.ts')]);

    expect(ownersOf(REPO, 'src/shared.ts').sort()).toEqual([1, 2]);
    expect(isSharedFile(REPO, 'src/shared.ts')).toBe(true);
    // Claimed by neither exclusively — both cards show it, both marked shared.
    expect(filesOwnedBy(REPO, 1, [file('src/shared.ts')])).toHaveLength(1);
    expect(filesOwnedBy(REPO, 2, [file('src/shared.ts')])).toHaveLength(1);
  });

  it('keeps each agent to its own file when they work in turn', () => {
    const seen = [file('src/a.ts')];
    recordDiffReading(REPO, at([1, 0], [2, 0]), []);
    recordDiffReading(REPO, at([1, 500], [2, 0]), seen);
    const both = [file('src/a.ts'), file('src/b.ts')];
    recordDiffReading(REPO, at([1, 500], [2, 900]), both);

    expect(filesOwnedBy(REPO, 1, both).map((f) => f.path)).toEqual(['src/a.ts']);
    expect(filesOwnedBy(REPO, 2, both).map((f) => f.path)).toEqual(['src/b.ts']);
    expect(isSharedFile(REPO, 'src/a.ts')).toBe(false);
    expect(isSharedFile(REPO, 'src/b.ts')).toBe(false);
  });

  it('re-credits a file that an agent changes again', () => {
    recordDiffReading(REPO, at([1, 0], [2, 0]), []);
    recordDiffReading(REPO, at([1, 500], [2, 0]), [file('src/a.ts', 3, 0)]);
    // Agent 2 now edits the same file: it becomes shared, because both have
    // written to it — not reassigned to whoever touched it last.
    recordDiffReading(REPO, at([1, 500], [2, 700]), [file('src/a.ts', 9, 2)]);

    expect(ownersOf(REPO, 'src/a.ts').sort()).toEqual([1, 2]);
  });

  it('does not re-credit a file whose diff did not move', () => {
    recordDiffReading(REPO, at([1, 0], [2, 0]), []);
    recordDiffReading(REPO, at([1, 500], [2, 0]), [file('src/a.ts', 3, 0)]);
    // Agent 2 works, but a.ts is byte-for-byte where agent 1 left it.
    recordDiffReading(REPO, at([1, 500], [2, 800]), [file('src/a.ts', 3, 0)]);

    expect(ownersOf(REPO, 'src/a.ts')).toEqual([1]);
  });

  it('forgets a file that leaves the diff, so a later change starts fresh', () => {
    recordDiffReading(REPO, at([1, 0], [2, 0]), []);
    recordDiffReading(REPO, at([1, 500], [2, 0]), [file('src/a.ts')]);
    expect(ownersOf(REPO, 'src/a.ts')).toEqual([1]);

    // Reverted or committed.
    recordDiffReading(REPO, at([1, 600], [2, 0]), []);
    expect(ownersOf(REPO, 'src/a.ts')).toEqual([]);

    // Agent 2 changes it next time round; agent 1 has no claim on it.
    recordDiffReading(REPO, at([1, 600], [2, 900]), [file('src/a.ts')]);
    expect(ownersOf(REPO, 'src/a.ts')).toEqual([2]);
  });

  it('does not credit an agent for work done before it was first seen', () => {
    // A newly spawned agent arrives with a non-zero counter. Whatever produced
    // that output happened before this module was watching it, so the files
    // that moved in the same interval are not its doing.
    recordDiffReading(REPO, at([1, 0]), []);
    recordDiffReading(REPO, at([1, 100], [2, 4000]), [file('src/a.ts')]);

    expect(ownersOf(REPO, 'src/a.ts')).toEqual([1]);
  });

  it('counts what it is not claiming, so a card can say so', () => {
    recordDiffReading(REPO, at([1, 0], [2, 0]), []);
    const all = [file('src/a.ts'), file('src/b.ts'), file('README.md')];
    recordDiffReading(REPO, at([1, 500], [2, 0]), [all[0]]);
    recordDiffReading(REPO, at([1, 500], [2, 300]), [all[0], all[1]]);
    recordDiffReading(REPO, at([1, 500], [2, 300]), all); // user edits README

    expect(filesOwnedBy(REPO, 1, all).map((f) => f.path)).toEqual(['src/a.ts']);
    expect(unattributedCount(REPO, 1, all)).toBe(2);
  });

  it('keeps repos independent', () => {
    const other = '/wt/b@abc1234';
    recordDiffReading(REPO, at([1, 0]), []);
    recordDiffReading(other, at([2, 0]), []);
    recordDiffReading(REPO, at([1, 500]), [file('src/a.ts')]);
    recordDiffReading(other, at([2, 500]), [file('src/a.ts')]);

    expect(ownersOf(REPO, 'src/a.ts')).toEqual([1]);
    expect(ownersOf(other, 'src/a.ts')).toEqual([2]);
  });
});
