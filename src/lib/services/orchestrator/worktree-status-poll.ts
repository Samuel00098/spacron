import { getWorktreeStatus, type WorktreeInfo, type WorktreeStatus } from './worktree-manager';

/**
 * One shared, self-throttling poller for every live worktree status readout.
 *
 * Each agent badge used to own a `setInterval(4000)` that called
 * `getWorktreeStatus` directly. That command runs `git status --porcelain` plus
 * `git rev-parse` — two process spawns and a full worktree scan — so the cost of
 * simply *having* agents open was linear in the number of agents, paid forever,
 * whether or not anything had changed and whether or not the window was even on
 * screen. With six agents that is three git processes a second, in bursts of
 * twelve, on the machine those same agents are trying to compile on.
 *
 * Three properties fix that, and none of them change what a caller sees:
 *
 *  - **Shared and deduplicated.** Subscribers are keyed by worktree path, so N
 *    watchers of one worktree cost one git call, and a new subscriber gets the
 *    cached status immediately instead of forcing a fresh read.
 *  - **Backed off by agent activity.** A worktree cannot change while its agent
 *    is silent, so a subscriber supplies a monotonic activity probe (in practice
 *    the session's produced-chars counter). Output since the last poll keeps the
 *    fast cadence; silence doubles the interval up to {@link IDLE_POLL_MS}. A
 *    working agent is still watched at the old 4s; an idle one costs ~nothing.
 *  - **Serialised and visibility-gated.** At most one git call is in flight
 *    across the whole app, so ticks never spike, and nothing runs at all while
 *    the window is hidden — becoming visible refreshes everything at once.
 */

/** Cadence while the agent is producing output. The old per-badge interval. */
export const BASE_POLL_MS = 4000;
/** Slowest cadence, reached by an agent that has gone quiet. */
export const IDLE_POLL_MS = 30000;
/** How often the scheduler wakes to see what is due. */
const TICK_MS = 1000;
/**
 * How long an entry survives its last unsubscribe. Panes remount (a stage
 * retile, a project switch) and the badge's `worktree` object identity changes
 * with the stores it is derived from; without a grace period every one of those
 * would drop the cached status and force an immediate re-read, which is the cost
 * this module exists to avoid.
 */
const RETAIN_MS = 60000;

type Listener = (status: WorktreeStatus | null) => void;

interface Entry {
  worktree: WorktreeInfo;
  listeners: Set<Listener>;
  /** One monotonic activity probe per subscriber; any rise means "still working". */
  probes: Set<() => number>;
  /** Probe total at the previous poll, for the growth comparison. */
  lastActivity: number;
  status: WorktreeStatus | null;
  /** Whether `status` holds a real reading rather than "never polled". */
  polled: boolean;
  nextAt: number;
  intervalMs: number;
  /** When the last listener left, or null while someone is still watching. */
  emptySince: number | null;
}

const entries = new Map<string, Entry>();
let timer: ReturnType<typeof setInterval> | null = null;
/** The in-flight scheduling pass, or null. Every caller awaits this same one. */
let currentPass: Promise<void> | null = null;
/** A pass was asked for while one was already running — re-run once it ends. */
let passPending = false;
let visibilityHandler: (() => void) | null = null;

/** Injectable for tests; the real one shells out to git through the backend. */
let readStatus: (worktree: WorktreeInfo) => Promise<WorktreeStatus | null> = getWorktreeStatus;

function hidden(): boolean {
  return typeof document !== 'undefined' && document.hidden === true;
}

function sampleActivity(entry: Entry): number {
  let total = 0;
  for (const probe of entry.probes) {
    try { total += probe(); } catch { /* a probe for a session that is gone */ }
  }
  return total;
}

function start(): void {
  if (timer) return;
  timer = setInterval(() => void runPass(), TICK_MS);
  if (typeof document !== 'undefined' && !visibilityHandler) {
    visibilityHandler = () => {
      if (document.hidden) return;
      // Everything is stale by an unknown amount — re-read it all, at once,
      // rather than letting each entry drift in on its own backed-off schedule.
      for (const entry of entries.values()) {
        entry.nextAt = 0;
        entry.intervalMs = BASE_POLL_MS;
      }
      void runPass();
    };
    document.addEventListener('visibilitychange', visibilityHandler);
  }
}

function stopIfIdle(): void {
  if (entries.size > 0 || !timer) return;
  clearInterval(timer);
  timer = null;
  if (visibilityHandler && typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', visibilityHandler);
  }
  visibilityHandler = null;
}

/**
 * Ask for a scheduling pass.
 *
 * A pass reads its due list before its first `await`, so a subscribe that lands
 * mid-pass would otherwise wait a whole tick for its first reading. Requests
 * arriving during a pass are coalesced into one re-run, and every caller gets
 * the same promise — which settles only once the queue has drained, so a caller
 * can rely on its own request having been served.
 */
function runPass(): Promise<void> {
  if (currentPass) {
    passPending = true;
    return currentPass;
  }
  currentPass = (async () => {
    try {
      do {
        passPending = false;
        await onePass();
      } while (passPending);
    } finally {
      currentPass = null;
      passPending = false;
    }
  })();
  return currentPass;
}

/**
 * One scheduling pass. Due entries are read one at a time — the serialisation is
 * deliberate, so N agents never fire N git processes into the same millisecond.
 */
async function onePass(): Promise<void> {
  const now = Date.now();

  // Retire entries nobody has watched for a while, so their cached status and
  // schedule don't outlive the agent.
  for (const [path, entry] of [...entries]) {
    if (entry.emptySince !== null && now - entry.emptySince >= RETAIN_MS) {
      entries.delete(path);
    }
  }
  stopIfIdle();

  if (hidden()) return;

  const due = [...entries.values()].filter(
    (entry) => entry.listeners.size > 0 && Date.now() >= entry.nextAt,
  );
  for (const entry of due) {
    const status = await readStatus(entry.worktree);
    // Re-check: the pass is not instantaneous and the last listener may have
    // left while git was running.
    if (!entries.has(entry.worktree.path)) continue;

    const changed =
      !entry.polled ||
      entry.status?.changedFiles !== status?.changedFiles ||
      entry.status?.branch !== status?.branch;
    entry.status = status;
    entry.polled = true;

    const activity = sampleActivity(entry);
    const busy = activity > entry.lastActivity;
    entry.lastActivity = activity;
    // Output since the last poll, or a status that actually moved, both mean
    // "watch this closely". Anything else earns a longer nap.
    entry.intervalMs =
      busy || changed ? BASE_POLL_MS : Math.min(entry.intervalMs * 2, IDLE_POLL_MS);
    entry.nextAt = Date.now() + entry.intervalMs;

    if (changed) {
      for (const listener of [...entry.listeners]) {
        try { listener(status); } catch { /* a listener unmounting mid-pass */ }
      }
    }
  }
}

/**
 * Watch one worktree's status.
 *
 * `activity` must return a monotonically increasing count of whatever the
 * worktree's agent has produced (`getSessionOutputProduced` is the one to pass);
 * it is what tells a working agent from an idle one. `onStatus` is called with
 * the cached status right away when there is one, and thereafter only when the
 * status actually changes.
 *
 * Returns the unsubscribe function.
 */
export function subscribeWorktreeStatus(
  worktree: WorktreeInfo,
  activity: () => number,
  onStatus: Listener,
): () => void {
  const path = worktree.path;
  let entry = entries.get(path);
  if (!entry) {
    entry = {
      worktree,
      listeners: new Set(),
      probes: new Set(),
      lastActivity: 0,
      status: null,
      polled: false,
      nextAt: 0,
      intervalMs: BASE_POLL_MS,
      emptySince: null,
    };
    entries.set(path, entry);
  } else {
    // Keep the newest view of the worktree (a rename moves the branch, not the
    // path), but leave the schedule alone — a remount must not force a re-read.
    entry.worktree = worktree;
  }
  entry.listeners.add(onStatus);
  entry.probes.add(activity);
  entry.emptySince = null;
  if (entry.polled) onStatus(entry.status);
  start();
  void runPass();

  return () => {
    const current = entries.get(path);
    if (!current) return;
    current.listeners.delete(onStatus);
    current.probes.delete(activity);
    if (current.listeners.size === 0) current.emptySince = Date.now();
  };
}

/** Test seam: swap the git call and clear all scheduler state. */
export function __resetWorktreeStatusPollForTest(
  reader?: (worktree: WorktreeInfo) => Promise<WorktreeStatus | null>,
): void {
  entries.clear();
  currentPass = null;
  passPending = false;
  if (timer) clearInterval(timer);
  timer = null;
  if (visibilityHandler && typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', visibilityHandler);
  }
  visibilityHandler = null;
  readStatus = reader ?? getWorktreeStatus;
}

/** Test seam: run one scheduling pass without waiting for the timer. */
export function __runWorktreeStatusPassForTest(): Promise<void> {
  return runPass();
}
