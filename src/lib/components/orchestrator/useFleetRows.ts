/**
 * The fleet, derived once.
 *
 * "Which agents exist, where do they work, what have they changed" was worked
 * out inside {@link FleetDashboard} and nowhere else. The stream shell needs the
 * same answer — its first two bands *are* the fleet, sorted by who needs you —
 * and the derivation is subtle enough (three session stores, two placements,
 * shared diff reads) that a second copy would drift within a release. It lives
 * here so both views read the same rows.
 *
 * Behaviour is unchanged from the panel this was lifted out of; the notes below
 * are the reasons the shape is what it is.
 *
 * ## Both placements appear here
 *
 * Placement is a per-agent choice, so a fleet is routinely mixed: some agents
 * isolated in their own worktree, some running directly in the main checkout.
 * Keying rows off `session.worktree` would render *only* the isolated ones — a
 * main-repo agent working visibly in a pane would be missing from the one view
 * that claims to show the fleet. The two differ in what you can *do*, not in
 * whether they exist:
 *
 * - **Isolated worktree** — its own branch, so Bring in / Merge / Discard all
 *   mean something. Numbers are measured against the commit it forked from.
 * - **Main repo** — no branch of its own; its edits are already in your working
 *   tree. Nothing to merge, nothing safe to discard, so such a row is
 *   review-only, and its `+N/−M` is the *checkout's* uncommitted work, shared
 *   with you and with any other main-repo agent.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useStore } from '$lib/react/useStore';
import { activeProject } from '$lib/stores/workspace';
import {
  sessions,
  devSessions,
  allProjectSessions,
  getAgentDisplayName,
  isAgentSession,
} from '$lib/stores/terminal';
import { orchestratorTasks } from '$lib/stores/orchestrator';
import type { WorktreeInfo } from '$lib/services/orchestrator/worktree-manager';
import type { OrchestratorTask } from '$lib/services/orchestrator/task-lifecycle';

/** How often the per-row diff stat is refreshed. Three cheap git reads each. */
export const FLEET_POLL_MS = 5000;

export type FleetStatus = 'working' | 'awaiting' | 'finished' | 'failed' | 'exited';

/** Where the agent is doing its work — decides which actions a row can offer. */
export type FleetPlacement = 'worktree' | 'main';

export interface FleetRow {
  /**
   * Stable identity. A worktree path for an isolated agent (the natural key —
   * it outlives the pane); the session id for a main-repo one, which has no
   * checkout of its own to be named by.
   */
  key: string;
  projectId: string;
  agentName: string;
  agentPreset: string | null;
  placement: FleetPlacement;
  /** Set only when `placement === 'worktree'`. */
  worktree: WorktreeInfo | null;
  /**
   * The repo the row's numbers are read from. `null` means the project root —
   * left to the backend rather than spelled out, so the path never has to
   * survive a round trip through `canonicalize` to be recognised as the root.
   */
  repoPath: string | null;
  /** Fork point to measure against; `null` means HEAD — the main-repo case. */
  baseCommit: string | null;
  /** True while the owning agent's pane is still alive. */
  live: boolean;
  sessionId: number | null;
  task: OrchestratorTask | null;
  status: FleetStatus;
  /**
   * What the agent's CLI last reported it was doing, from the pane's OSC title.
   * The stream's "working now" band leads with this, so it is carried on the row
   * rather than re-read from the session store at render time.
   */
  activity: string | null;
}

export interface FileStat {
  path: string;
  additions: number;
  deletions: number;
  status: string;
}

export interface DiffStat {
  files: FileStat[];
  total_additions: number;
  total_deletions: number;
  /**
   * What the backend actually measured against. Echoed back because a main-repo
   * row asks for "HEAD" without knowing the sha, and the per-file diff has to
   * open against the *same* base or it would show a different change set.
   */
  base_commit: string;
}

/**
 * Rows sharing a repo and a base share one git read. Every main-repo agent in a
 * project resolves to the same pair, so a fleet of five would otherwise poll the
 * same diff five times every {@link FLEET_POLL_MS}.
 */
export function statKey(row: Pick<FleetRow, 'repoPath' | 'baseCommit'>): string {
  return `${row.repoPath ?? '<root>'}@${row.baseCommit ?? 'HEAD'}`;
}

export const FLEET_STATUS_LABEL: Record<FleetStatus, string> = {
  working: 'Working',
  awaiting: 'Awaiting input',
  finished: 'Finished',
  failed: 'Failed',
  exited: 'Exited',
};

/**
 * Derive a row's status.
 *
 * Reads the orchestrator task where there is one — its `blocked`/`complete`
 * states come from the turn watcher, which is driven by a sentinel the agent
 * emits rather than a guess about its screen. A fleet fed by screen-scraped turn
 * state would be presenting a guess as a fact.
 */
export function statusFor(task: OrchestratorTask | null, live: boolean): FleetStatus {
  if (task) {
    if (task.status === 'blocked') return 'awaiting';
    if (task.status === 'complete') return 'finished';
    if (task.status === 'failed' || task.status === 'cancelled') return 'failed';
    if (task.status === 'in-progress') return live ? 'working' : 'exited';
  }
  return live ? 'working' : 'exited';
}

/**
 * Every agent in the active project, with its placement, status and identity.
 *
 * Pure derivation — no polling, no git. Callers that want `+N/−M` add
 * {@link useFleetStats} on top, so a view showing only names and status doesn't
 * pay for a git read every five seconds.
 */
export function useFleetRows(): FleetRow[] {
  const project = useStore(activeProject);
  const projectId = project?.id ?? null;
  const tasks = useStore(orchestratorTasks);
  // All three session stores, per the lookup gotcha in
  // `.spacron/memory/agent-worktrees.md`: `sessions` is the active project's
  // non-dev panes only, `devSessions` never reaches `allProjectSessions`, and an
  // agent spawned into the Development ambient lives solely in the latter.
  // Reading one store alone silently drops whole agents from the fleet.
  const activeSessions = useStore(sessions);
  const devProjectSessions = useStore(devSessions);
  const crossProjectSessions = useStore(allProjectSessions);

  return useMemo<FleetRow[]>(() => {
    if (!projectId) return [];
    const byKey = new Map<string, FleetRow>();

    const allSessions = [...activeSessions, ...devProjectSessions, ...crossProjectSessions];
    for (const session of allSessions) {
      if (session.projectId !== projectId) continue;
      // Only agent panes. `sessions` also holds the user's own shells, and a
      // main-repo row is no longer distinguished by carrying a worktree, so
      // without this every terminal in the project would join the fleet.
      if (!isAgentSession(session)) continue;
      // Keyed by worktree where there is one — it outlives the pane, so an
      // isolated agent keeps its identity across a restart — and by session id
      // otherwise, since a main-repo agent has no checkout to be named by.
      const key = session.worktree ? session.worktree.path : `session:${session.id}`;
      // A session already recorded is the same pane seen through another store.
      // Keep the first, but never let a later copy downgrade `live`.
      const existing = byKey.get(key);
      if (existing) {
        existing.live = existing.live || session.isRunning === true;
        continue;
      }
      const task = tasks.find(
        (t) => t.assignedSessionId === session.id || t.lastSessionId === session.id,
      ) ?? null;
      const live = session.isRunning === true;
      byKey.set(key, {
        key,
        projectId,
        agentName:
          session.agentName?.trim() || getAgentDisplayName(session.agentPreset) || 'Agent',
        agentPreset: session.agentPreset ?? null,
        placement: session.worktree ? 'worktree' : 'main',
        worktree: session.worktree ?? null,
        // A main-repo agent edits the checkout itself, measured against HEAD —
        // both left null so the backend supplies the project's own root and
        // current commit.
        repoPath: session.worktree?.path ?? null,
        baseCommit: session.worktree?.baseCommit ?? null,
        live,
        sessionId: session.id,
        task,
        status: statusFor(task, live),
        activity: session.paneTitle?.trim() || session.taskSummary?.trim() || null,
      });
    }

    // Task-owned worktrees (orchestrator-dispatched agents). A session-owned
    // entry already carries live status, so don't overwrite it.
    //
    // Only worktree-owning tasks are added here. A `skipWorktree` task whose
    // pane is still around already came through the loop above; once that pane
    // is gone there is nothing left that is specific to it — no branch, no
    // checkout, and a diff that is just the project's, which Source Control
    // already shows. A row for it would be a second name on someone else's
    // changes.
    for (const task of tasks) {
      if (!task.worktree || task.projectId !== projectId) continue;
      if (byKey.has(task.worktree.path)) continue;
      const sessionId = task.assignedSessionId ?? task.lastSessionId ?? null;
      const live =
        sessionId !== null && allSessions.some((s) => s.id === sessionId && s.isRunning);
      byKey.set(task.worktree.path, {
        key: task.worktree.path,
        projectId,
        agentName: task.name?.trim() || getAgentDisplayName(task.agentPreset) || 'Agent',
        agentPreset: task.agentPreset ?? null,
        placement: 'worktree',
        worktree: task.worktree,
        repoPath: task.worktree.path,
        baseCommit: task.worktree.baseCommit,
        live,
        sessionId,
        task,
        status: statusFor(task, live),
        activity: task.title?.trim() || null,
      });
    }

    // Isolated agents lead: theirs are the rows holding a decision (merge or
    // discard), while a main-repo row is only ever review.
    return [...byKey.values()].sort((a, b) => {
      if (a.placement !== b.placement) return a.placement === 'worktree' ? -1 : 1;
      return a.agentName.localeCompare(b.agentName);
    });
  }, [projectId, tasks, activeSessions, devProjectSessions, crossProjectSessions]);
}

/**
 * `+N/−M` and changed files per row, polled while the caller is mounted.
 *
 * Returns the map keyed by {@link statKey}, plus the refresher so a view can
 * re-read immediately after an action that moves git state (a merge, a discard)
 * instead of showing stale numbers until the next tick.
 */
export function useFleetStats(rows: FleetRow[]): {
  stats: Record<string, DiffStat>;
  refresh: (list?: FleetRow[]) => Promise<void>;
} {
  const [stats, setStats] = useState<Record<string, DiffStat>>({});

  const refresh = useCallback(
    async (list: FleetRow[] = rows) => {
      const next: Record<string, DiffStat> = {};
      // One read per distinct repo+base, not per row.
      const targets = new Map<string, FleetRow>();
      for (const row of list) {
        if (!targets.has(statKey(row))) targets.set(statKey(row), row);
      }
      await Promise.all(
        [...targets].map(async ([key, row]) => {
          try {
            next[key] = await invoke<DiffStat>('workspace_git_worktree_diff_stat', {
              projectId: row.projectId,
              worktreePath: row.repoPath,
              // Null asks the backend to resolve HEAD, which is the only base a
              // main-repo agent has — it never forked from anything.
              baseCommit: row.baseCommit,
            });
          } catch {
            // A worktree removed underneath us, or git unavailable. Leave it out
            // rather than blanking every other row's numbers.
          }
        }),
      );
      setStats((current) => ({ ...current, ...next }));
    },
    [rows],
  );

  // Poll while mounted. `rows` is stable between renders unless the fleet
  // actually changes, so this restarts only when it does.
  useEffect(() => {
    if (rows.length === 0) return;
    let cancelled = false;
    const tick = () => {
      if (!cancelled) void refresh(rows);
    };
    tick();
    const timer = setInterval(tick, FLEET_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // `refresh` closes over `rows`, so depending on both would be depending on
    // the same thing twice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  return { stats, refresh };
}
