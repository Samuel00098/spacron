/**
 * Which agent changed which file, when several agents share one working tree.
 *
 * An agent running in its own worktree needs none of this: the worktree's diff
 * *is* that agent's work. Main-repo agents are the problem — they edit the same
 * checkout as each other and as you, so `git diff` can only say "these files
 * changed", never "this agent changed them". The Fleet used to show every card
 * the same whole-checkout diff and say so in a note, which is honest but is not
 * what the panel is for.
 *
 * The signal used here is timing. The Fleet already re-reads a repo's diff only
 * when some agent sharing it has produced output, and an agent that has printed
 * nothing since the last reading has written nothing. So each reading is folded
 * against the previous one: files whose diff changed are credited to the agents
 * that produced output over that interval.
 *
 * What that gives, and what it does not:
 *
 *  - One agent working at a time → exact.
 *  - Several working at once → the file is credited to each of them and marked
 *    shared, rather than silently claimed by one.
 *  - Files already changed when watching started → credited to nobody. They
 *    predate the evidence, and guessing an owner for them would be fiction.
 *  - Your own edits, made while no agent was producing output → credited to
 *    nobody, which is what keeps them off the agents' cards.
 *
 * Attribution is evidence, not proof: an agent that writes a file without
 * printing anything, in the same interval as another agent, is indistinguishable
 * from it. Callers should present a shared file as shared.
 */

export interface DiffFileLike {
  path: string;
  additions: number;
  deletions: number;
  status: string;
}

/** One agent's monotonic output counter at the moment of a reading. */
export interface AgentSample {
  sessionId: number;
  /** `getSessionOutputProduced(sessionId)` — must never decrease. */
  produced: number;
}

interface RepoState {
  /** path → fingerprint of its diff at the last reading. */
  lastFiles: Map<string, string>;
  /** sessionId → output counter at the last reading. */
  lastProduced: Map<number, number>;
  /** path → the sessions credited with changing it. */
  owners: Map<string, Set<number>>;
  /** Whether a reading has been folded in yet. */
  seeded: boolean;
}

const repos = new Map<string, RepoState>();

function ensure(repoKey: string): RepoState {
  let state = repos.get(repoKey);
  if (!state) {
    state = { lastFiles: new Map(), lastProduced: new Map(), owners: new Map(), seeded: false };
    repos.set(repoKey, state);
  }
  return state;
}

function fingerprint(file: DiffFileLike): string {
  return `${file.status}:${file.additions}:${file.deletions}`;
}

/**
 * Fold one diff reading into a repo's attribution.
 *
 * Call once per reading, with every agent that shares this repo and the file
 * list the reading returned.
 */
export function recordDiffReading(
  repoKey: string,
  agents: AgentSample[],
  files: DiffFileLike[],
): void {
  const state = ensure(repoKey);

  // Who produced output since the last reading. A session seen for the first
  // time has no baseline, so it is not counted as a worker for this interval —
  // whatever it did before we were watching is not evidence we hold.
  const workers: number[] = [];
  for (const agent of agents) {
    const previous = state.lastProduced.get(agent.sessionId);
    if (previous !== undefined && agent.produced > previous) workers.push(agent.sessionId);
    state.lastProduced.set(agent.sessionId, agent.produced);
  }

  const present = new Set<string>();
  for (const file of files) {
    present.add(file.path);
    const next = fingerprint(file);
    const previous = state.lastFiles.get(file.path);
    state.lastFiles.set(file.path, next);
    if (previous === next) continue; // this file did not move
    // Pre-existing changes (first reading) and changes made while no agent was
    // producing output both belong to nobody we can name.
    if (!state.seeded || workers.length === 0) continue;
    let owners = state.owners.get(file.path);
    if (!owners) {
      owners = new Set<number>();
      state.owners.set(file.path, owners);
    }
    for (const sessionId of workers) owners.add(sessionId);
  }

  // A file that left the diff was reverted or committed; its history of
  // ownership goes with it, so a later change starts attribution afresh.
  for (const path of [...state.lastFiles.keys()]) {
    if (present.has(path)) continue;
    state.lastFiles.delete(path);
    state.owners.delete(path);
  }

  state.seeded = true;
}

/** The sessions credited with a file, or an empty array for an unattributed one. */
export function ownersOf(repoKey: string, path: string): number[] {
  const owners = repos.get(repoKey)?.owners.get(path);
  return owners ? [...owners] : [];
}

/** Narrow a reading's file list to the ones credited to `sessionId`. */
export function filesOwnedBy<T extends { path: string }>(
  repoKey: string,
  sessionId: number | null,
  files: T[],
): T[] {
  if (sessionId === null) return [];
  const state = repos.get(repoKey);
  if (!state) return [];
  return files.filter((file) => state.owners.get(file.path)?.has(sessionId) === true);
}

/**
 * How many of a reading's files are not credited to `sessionId` — the rest of
 * the checkout, which a card should acknowledge rather than hide silently.
 */
export function unattributedCount<T extends { path: string }>(
  repoKey: string,
  sessionId: number | null,
  files: T[],
): number {
  return files.length - filesOwnedBy(repoKey, sessionId, files).length;
}

/** Whether more than one agent is credited with this file. */
export function isSharedFile(repoKey: string, path: string): boolean {
  return (repos.get(repoKey)?.owners.get(path)?.size ?? 0) > 1;
}

/** Drop a repo's attribution — its agents are gone, or the panel is resetting. */
export function forgetRepoAttribution(repoKey: string): void {
  repos.delete(repoKey);
}

/** Test seam. */
export function __resetAttributionForTest(): void {
  repos.clear();
}
