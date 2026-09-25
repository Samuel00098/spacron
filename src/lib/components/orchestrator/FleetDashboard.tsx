/**
 * Agent Fleet Dashboard — one view of what every agent in the fleet produced.
 *
 * Spacron can already *create* a fleet of agents in isolated worktrees; until
 * this existed there was no way to *judge* what they made. Reviewing four
 * agents meant switching to each room, reading its terminal, then going to
 * Source Control — which is scoped to the open project, not to that agent's
 * worktree — and repeating. The hard part (worktree isolation and
 * reconciliation) was done; the part a person actually touches was missing.
 *
 * One card per agent, showing live turn status, where it is working, `+N/−M`,
 * and its changed files expanding into the §7 diff viewer **pointed at that
 * agent's repo** rather than at whatever project happens to be open.
 *
 * ## Both placements appear here
 *
 * Placement is a per-agent choice (see [[agent-placement-gate]]), so a fleet is
 * routinely mixed: some agents isolated in their own worktree, some running
 * directly in the main checkout. This panel used to key rows off
 * `session.worktree` and therefore rendered *only* the isolated ones — a
 * main-repo agent was working, visibly, in a pane, and the one screen that
 * claims to show the fleet said there was nothing there. The two placements
 * differ in what you can *do*, not in whether they exist:
 *
 * - **Isolated worktree** — its own branch, so Bring in / Merge / Discard all
 *   mean something. Numbers are measured against the commit it forked from.
 * - **Main repo** — no branch of its own; its edits are already sitting in your
 *   working tree. There is nothing to merge and nothing safe to discard, so the
 *   card is review-only: status, `+N/−M` against HEAD, and the file diffs.
 *   Those numbers are the *checkout's* uncommitted work, which is shared with
 *   you and with any other main-repo agent — the card says so rather than
 *   implying the agent authored all of it.
 *
 * Merge and discard act on real git state, so both demand a confirmation that
 * names the branch, and discard refuses outright while the agent's session is
 * still alive — killing an agent mid-write and deleting its checkout is
 * unrecoverable. Discard goes through `reclaimWorktree`, which stages anything
 * outstanding and re-asks git before removing anything.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useStore } from '$lib/react/useStore';
import { activeProject } from '$lib/stores/workspace';
import { showToast } from '$lib/stores/notification';
import {
  sessions,
  devSessions,
  allProjectSessions,
  setActiveSession,
  getAgentDisplayName,
  getSessionOutputProduced,
  isAgentSession,
  sessionHeaderSummary,
} from '$lib/stores/terminal';
import { orchestratorTasks, stageAgentWorktree, markWorktreeMerged } from '$lib/stores/orchestrator';
import {
  mergeTaskWorktree,
  reclaimWorktree,
  type WorktreeInfo,
} from '$lib/services/orchestrator/worktree-manager';
import type { OrchestratorTask } from '$lib/services/orchestrator/task-lifecycle';
import { agentTurnStates, type AgentTurnPhase } from '$lib/stores/agentTurnState';
import { layout } from '$lib/stores/layout';
import {
  DEEPSEEK_HARNESS_COMMAND,
  deepSeekAgentName,
  deepSeekPanelRoot,
  deepSeekPlacements,
} from '$lib/services/deepseek-harness';
import { AgentBrandMark } from '$lib/components/shared/useAgentBrand.tsx';
import HunkDiffView from '$lib/components/review/HunkDiffView.tsx';
import FileIcon from '$lib/components/explorer/FileIcon.tsx';
import WorktreeReviewModal from './WorktreeReviewModal.tsx';
import {
  filesOwnedBy,
  isSharedFile,
  recordDiffReading,
  type AgentSample,
} from '$lib/services/orchestrator/agent-file-attribution';
import './FleetDashboard.css';

/** How often the per-card diff stat is refreshed. Three cheap git reads each. */
const POLL_MS = 5000;

type FleetStatus = 'working' | 'idle' | 'awaiting' | 'finished' | 'failed' | 'exited' | 'open';


/** Where the agent is doing its work — decides which actions the card offers. */
type FleetPlacement = 'worktree' | 'main';

interface FleetRow {
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
   * The repo the card's numbers are read from. `null` means the project root —
   * left to the backend rather than spelled out, so the path never has to
   * survive a round trip through `canonicalize` to be recognised as the root.
   */
  repoPath: string | null;
  /** Fork point to measure against; `null` means HEAD — the main-repo case. */
  baseCommit: string | null;
  /** True while the owning agent's pane is still alive. */
  live: boolean;
  /** The agent's own header summary (see `sessionHeaderSummary`), if any. */
  summary: string | null;
  /** The DeepSeek panel's row: no terminal, so its status is not turn-driven. */
  deepseekPanel?: boolean;
  sessionId: number | null;
  task: OrchestratorTask | null;
  status: FleetStatus;
}

interface FileStat {
  path: string;
  additions: number;
  deletions: number;
  status: string;
}

interface DiffStat {
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
 * Cards sharing a repo and a base share one git read. Every main-repo agent in
 * a project resolves to the same pair, so a fleet of five would otherwise poll
 * the same diff five times every {@link POLL_MS}.
 */
function statKey(row: Pick<FleetRow, 'repoPath' | 'baseCommit'>): string {
  return `${row.repoPath ?? '<root>'}@${row.baseCommit ?? 'HEAD'}`;
}

const STATUS_LABEL: Record<FleetStatus, string> = {
  working: 'Working',
  idle: 'Idle',
  awaiting: 'Awaiting input',
  finished: 'Finished',
  failed: 'Failed',
  exited: 'Exited',
  // The DeepSeek panel: its web UI does not report turns to Spacron, so the
  // card says what is known (the panel is open) rather than guessing.
  open: 'Open',
};

/**
 * Derive a card's status from the same events the agent notifications fire on
 * (`stores/agentTurnState.ts`): a prompt handed over starts a turn, and the
 * turn watcher's end (the done / needs-input card) closes it.
 *
 * - Working: it was sent a task and has not ended that turn yet.
 * - Idle: open, and nothing has been asked of it. An agent that was only
 *   launched is idle however much its startup screen prints, and so is one
 *   whose orchestrator task exists but has not been sent to it.
 * - Finished / Awaiting input / Failed: how its last turn ended.
 */
export function statusFor(
  task: OrchestratorTask | null,
  live: boolean,
  turn: AgentTurnPhase | undefined,
): FleetStatus {
  if (!live) {
    if (task?.status === 'complete') return 'finished';
    if (task?.status === 'failed' || task?.status === 'cancelled') return 'failed';
    return 'exited';
  }
  if (task?.status === 'blocked' || turn === 'blocked') return 'awaiting';
  if (turn === 'working') return 'working';
  if (turn === 'finished') return 'finished';
  if (turn === 'failed') return 'failed';
  return 'idle';
}

/** A row as rendered: its live status and when its working stretch began. */
type DisplayRow = FleetRow & { workingSince: number | null };

/** Card order: working agents lead, then what needs you, what's done last. */
const STATUS_ORDER: Record<FleetStatus, number> = {
  working: 0,
  awaiting: 1,
  failed: 2,
  finished: 3,
  idle: 4,
  open: 5,
  exited: 6,
};

/** What a card says when the agent has no header summary to show. */
const SUMMARY_FALLBACK: Record<FleetStatus, string> = {
  working: 'Working on a task',
  idle: 'No task yet',
  awaiting: 'Waiting for your answer',
  finished: 'Finished its task',
  failed: 'Stopped with an error',
  exited: 'Closed',
  open: 'Open in its panel',
};

/**
 * The line under the agent's name: the same summary its own pane header shows
 * (the CLI's title for the conversation), then an orchestrator task's goal,
 * then a plain word for its state. Never the prompt it was sent: a prompt is
 * a question or an instruction, while the header says what the work is.
 */
export function summaryLine(
  summary: string | null,
  goal: string | null | undefined,
  status: FleetStatus,
): string {
  return summary?.trim() || goal?.trim() || SUMMARY_FALLBACK[status];
}

/** "42s", "3m 05s", "1h 12m". */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

function FleetEmpty({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="fleet-empty">
      <span className="fleet-empty-icon" aria-hidden="true">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      </span>
      <strong>{title}</strong>
      <span>{children}</span>
    </div>
  );
}

export default function FleetDashboard() {
  const project = useStore(activeProject);
  const projectId = project?.id ?? null;
  const projectRoot = project?.root_path ?? null;
  const deepseekOpen = useStore(layout).deepseekVisible;
  const placements = useStore(deepSeekPlacements);
  const tasks = useStore(orchestratorTasks);
  // All three session stores, per the lookup gotcha in
  // `.spacron/memory/agent-worktrees.md`: `sessions` is the active project's
  // non-dev panes only, `devSessions` never reaches `allProjectSessions`, and
  // an agent spawned into the Development ambient lives solely in the latter.
  // Reading one store alone silently drops whole agents from the fleet.
  const activeSessions = useStore(sessions);
  const devProjectSessions = useStore(devSessions);
  const crossProjectSessions = useStore(allProjectSessions);

  const [stats, setStats] = useState<Record<string, DiffStat>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [openFileKey, setOpenFileKey] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  /** Pending destructive action awaiting explicit confirmation. */
  const [confirming, setConfirming] = useState<{ key: string; action: 'merge' | 'discard' } | null>(null);
  /** Row key of the worktree whose dedicated review pane is open. */
  const [reviewing, setReviewing] = useState<string | null>(null);
  /** The checkout's own branch, for labelling main-repo cards. */
  const [mainBranch, setMainBranch] = useState<string | null>(null);
  /** Suppress the card entrance animation on the panel's first paint, so
      remounting the room doesn't replay the whole fleet's entrance. Cards that
      appear later (agents spawning) still animate in. */
  const [suppressEnter, setSuppressEnter] = useState(true);

  const rows = useMemo<FleetRow[]>(() => {
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
      const summary = sessionHeaderSummary(session);
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
        summary,
        sessionId: session.id,
        task,
        status: statusFor(task, live, undefined),
      });
    }

    // Task-owned worktrees (orchestrator-dispatched agents). A session-owned
    // entry already carries live status, so don't overwrite it.
    //
    // Only worktree-owning tasks are added here. A `skipWorktree` task whose
    // pane is still around already came through the loop above; once that pane
    // is gone there is nothing left that is specific to it — no branch, no
    // checkout, and a diff that is just the project's, which Source Control
    // already shows. A card for it would be a second name on someone else's
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
        summary: sessionHeaderSummary(allSessions.find((s) => s.id === sessionId)),
        sessionId,
        task,
        status: statusFor(task, live, undefined),
      });
    }

    // The DeepSeek panel is an agent without a terminal: dsh's own web UI in a
    // room. Terminal-session rows can never see it, so it joins from the room
    // being open, working where its placement says (main repo or worktree).
    if (deepseekOpen && projectRoot) {
      const worktree = placements[projectId]?.worktree ?? null;
      const panelRoot = deepSeekPanelRoot(placements, projectId, projectRoot);
      const key = worktree ? worktree.path : `deepseek:${projectId}`;
      if (!byKey.has(key)) {
        byKey.set(key, {
          key,
          projectId,
          agentName: deepSeekAgentName(
            panelRoot,
            allSessions.map((session) => session.agentName ?? '').filter(Boolean),
          ),
          agentPreset: DEEPSEEK_HARNESS_COMMAND,
          placement: worktree ? 'worktree' : 'main',
          worktree,
          repoPath: worktree?.path ?? null,
          baseCommit: worktree?.baseCommit ?? null,
          live: true,
          summary: null,
          sessionId: null,
          task: null,
          status: 'open',
          deepseekPanel: true,
        });
      }
    }

    // Isolated agents lead: theirs are the cards holding a decision (merge or
    // discard), while a main-repo card is only ever review.
    return [...byKey.values()].sort((a, b) => {
      if (a.placement !== b.placement) return a.placement === 'worktree' ? -1 : 1;
      return a.agentName.localeCompare(b.agentName);
    });
  }, [projectId, projectRoot, tasks, activeSessions, devProjectSessions, crossProjectSessions, deepseekOpen, placements]);

  const refreshStats = useCallback(
    async (list: FleetRow[]) => {
      const next: Record<string, DiffStat> = {};
      // One read per distinct repo+base, not per card.
      const targets = new Map<string, FleetRow>();
      // Per-agent output counters, grouped the same way, so a reading can be
      // credited to the agents that actually produced something during it.
      const samples = new Map<string, AgentSample[]>();
      for (const row of list) {
        const key = statKey(row);
        if (!targets.has(key)) targets.set(key, row);
        if (row.sessionId !== null) {
          const produced = getSessionOutputProduced(row.sessionId);
          const bucket = samples.get(key);
          if (bucket) bucket.push({ sessionId: row.sessionId, produced });
          else samples.set(key, [{ sessionId: row.sessionId, produced }]);
        }
      }
      // Read one at a time rather than in parallel: each of these spawns git, and
      // firing one per agent into the same instant is what makes the whole app
      // hitch every few seconds once several agents are running.
      //
      // Deliberately NOT skipped when the agents have been quiet, the way the
      // worktree-status poller is. Attribution is a fold over consecutive
      // readings, so a skipped one merges two intervals into one: an edit YOU
      // made while every agent was idle would land in the same interval as the
      // next agent's work and be credited to it. The panel is only polled while
      // it is open and visible, which is the gate that keeps this affordable.
      for (const [key, row] of targets) {
        try {
          const stat = await invoke<DiffStat>('workspace_git_worktree_diff_stat', {
            projectId: row.projectId,
            worktreePath: row.repoPath,
            // Null asks the backend to resolve HEAD, which is the only base a
            // main-repo agent has — it never forked from anything.
            baseCommit: row.baseCommit,
          });
          next[key] = stat;
          // Fold the reading in before it is shown, so a card never paints a
          // file list one reading behind its attribution.
          recordDiffReading(key, samples.get(key) ?? [], stat.files);
        } catch {
          // A worktree removed underneath us, or git unavailable. Leave it out
          // rather than blanking every other card's numbers.
        }
      }
      if (Object.keys(next).length > 0) setStats((current) => ({ ...current, ...next }));
    },
    [],
  );

  // Poll while the panel is open. `rows` is stable between renders unless the
  // fleet actually changes, so this restarts only when it does.
  useEffect(() => {
    if (rows.length === 0) return;
    let cancelled = false;
    // A hidden window has nobody reading these numbers, so running git for them
    // only takes CPU from the agents. Becoming visible forces a full re-read,
    // since everything is stale by an unknown amount by then.
    const tick = () => {
      if (cancelled || document.hidden) return;
      void refreshStats(rows);
    };
    tick();
    const timer = setInterval(tick, POLL_MS);
    const onVisible = () => tick();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [rows, refreshStats]);

  // First paint: drop the entrance-suppression class so later-mounted cards
  // (new agents appearing) animate in.
  useLayoutEffect(() => {
    setSuppressEnter(false);
  }, []);

  const turnStates = useStore(agentTurnStates);

  const display = useMemo<DisplayRow[]>(
    () =>
      rows.map((row) => {
        const turn = row.sessionId !== null ? turnStates[row.sessionId] : undefined;
        const status = row.deepseekPanel ? 'open' : statusFor(row.task, row.live, turn?.phase);
        return {
          ...row,
          status,
          workingSince: status === 'working' ? turn?.since ?? null : null,
        };
      }),
    [rows, turnStates],
  );

  /** Cards showing their details (changes, branch, actions). Closed by default. */
  const [openCards, setOpenCards] = useState<Set<string>>(new Set());
  const toggleCard = (key: string) =>
    setOpenCards((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // Main-repo cards name the branch the agent is actually sitting on, which is
  // the checkout's — and it moves under them if you check something else out.
  const hasMainRepoRow = rows.some((row) => row.placement === 'main');
  useEffect(() => {
    if (!projectId || !hasMainRepoRow) {
      setMainBranch(null);
      return;
    }
    let cancelled = false;
    const read = async () => {
      try {
        const status = await invoke<{ branch: string }>('workspace_git_status', { projectId });
        if (!cancelled) setMainBranch(status.branch?.trim() || null);
      } catch {
        // Not a git repo, or git unavailable — the card falls back to saying
        // "main repo" without a branch, which is still true.
        if (!cancelled) setMainBranch(null);
      }
    };
    void read();
    const timer = setInterval(read, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [projectId, hasMainRepoRow]);

  function withBusy(key: string, fn: () => Promise<void>) {
    setBusy((current) => new Set(current).add(key));
    void fn().finally(() => {
      setBusy((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    });
  }

  function doMerge(row: FleetRow) {
    setConfirming(null);
    const worktree = row.worktree;
    if (!worktree) return;
    withBusy(row.key, async () => {
      try {
        const result = await mergeTaskWorktree(row.projectId, worktree, false);
        if (result.conflicted) {
          showToast(
            `${row.agentName}: merge hit conflicts. Resolve them in Source Control.`,
            'warning',
            14000,
            true,
          );
        } else if (result.alreadyUpToDate) {
          // git succeeded but moved nothing. Claiming a merge here was the one
          // notification guaranteed to be false: it fired precisely when the
          // press had no effect.
          showToast(
            `Nothing to merge. ${worktree.branch} holds nothing ${worktree.baseBranch} doesn't already have.`,
            'info',
            6000,
          );
        } else if (result.success) {
          // Tell the reconciler the work has landed. Without this it still sees
          // the whole merged range as outstanding, stages it back in seconds
          // later, and announces it as newly arrived.
          markWorktreeMerged(row.projectId, worktree, result.mergedCommit);
          showToast(
            `Merged ${worktree.branch} into ${worktree.baseBranch}.`,
            'success',
            8000,
          );
        } else {
          showToast(result.message || 'Merge failed.', 'error', 10000);
        }
      } catch (err) {
        showToast(String(err), 'error', 10000);
      }
      await refreshStats(rows);
    });
  }

  function doDiscard(row: FleetRow) {
    setConfirming(null);
    const worktree = row.worktree;
    if (!worktree) return;
    withBusy(row.key, async () => {
      try {
        // `reclaimWorktree`, never a bare remove: it stages anything outstanding
        // and re-reads git before deleting, so a write that lands mid-operation
        // isn't destroyed unseen. It reports back instead of removing when work
        // can't be moved.
        const outcome = await reclaimWorktree(row.projectId, worktree, {
          deleteBranch: true,
        });
        if (outcome.removed) {
          showToast(
            outcome.staged > 0
              ? `Discarded ${worktree.branch}. ${outcome.staged} file change${outcome.staged === 1 ? '' : 's'} were staged into Source Control first.`
              : `Discarded ${worktree.branch}.`,
            'success',
            8000,
          );
          setExpanded((current) => (current === row.key ? null : current));
        } else if (outcome.reason === 'conflict') {
          showToast(
            `${row.agentName}: can't discard. Staging its work conflicts with your edits. Resolve in Source Control, then try again.`,
            'warning',
            14000,
            true,
          );
        } else if (outcome.reason === 'pending') {
          showToast(
            `${row.agentName}: kept the worktree. ${outcome.pendingFiles} file change${outcome.pendingFiles === 1 ? '' : 's'} still hadn't reached your working tree.`,
            'warning',
            12000,
          );
        } else {
          showToast(outcome.message || 'Could not discard the worktree.', 'error', 10000);
        }
      } catch (err) {
        showToast(String(err), 'error', 10000);
      }
      await refreshStats(rows);
    });
  }

  function doStage(row: FleetRow) {
    const worktree = row.worktree;
    if (!worktree) return;
    withBusy(row.key, async () => {
      try {
        await stageAgentWorktree(row.projectId, worktree);
      } catch (err) {
        showToast(String(err), 'error', 10000);
      }
      await refreshStats(rows);
    });
  }

  if (!project) {
    return (
      <FleetEmpty title="No project open">Open a project to see what its agents changed.</FleetEmpty>
    );
  }

  if (rows.length === 0) {
    return (
      <FleetEmpty title="No agents running in this project">
        Spawn agents and they show up here, whether they take their own branch
        and checkout or work directly in the main repo. Isolated ones are ready to
        review, merge or throw away; main-repo ones are ready to read.
      </FleetEmpty>
    );
  }

  const isolatedCount = display.filter((row) => row.placement === 'worktree').length;
  const ordered = [...display].sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      (a.status === 'working' ? (a.workingSince ?? 0) - (b.workingSince ?? 0) : 0) ||
      a.agentName.localeCompare(b.agentName),
  );
  const working = ordered.filter((row) => row.status === 'working');
  const awaitingCount = display.filter((row) => row.status === 'awaiting').length;
  const idleCount = display.filter((row) => row.status === 'idle').length;
  const readyCount = display.filter(readyToReview).length;


  /**
   * A worktree card whose agent has stopped and left unreviewed work is the
   * fleet's reason for existing: everything a quarantine is supposed to surface
   * at once. `!row.live` is the honest gate — a working agent's card is
   * mid-flight, not ready, however many files it has touched so far.
   */
  function readyToReview(row: DisplayRow): boolean {
    return (
      row.placement === 'worktree' &&
      Boolean(row.worktree) &&
      !row.live &&
      (row.status === 'finished' || row.status === 'exited') &&
      Boolean(stats[statKey(row)]?.files.length)
    );
  }

  const renderCard = (row: DisplayRow) => {
      const key = statKey(row);
      const stat = stats[key];
      const isBusy = busy.has(row.key);
      const isExpanded = expanded === row.key;
      const pendingConfirm = confirming?.key === row.key ? confirming.action : null;
      const worktree = row.worktree;

      // An isolated agent owns its whole worktree diff, so the reading IS
      // its work. A main-repo agent shares the checkout with you and with
      // every other main-repo agent, so it is credited only with the files
      // that moved while it was the one producing output.
      const allFiles = stat?.files ?? [];
      const files =
        row.placement === 'worktree' ? allFiles : filesOwnedBy(key, row.sessionId, allFiles);
      const othersCount = row.placement === 'worktree' ? 0 : allFiles.length - files.length;
      const additions =
        row.placement === 'worktree'
          ? stat?.total_additions ?? 0
          : files.reduce((sum, file) => sum + file.additions, 0);
      const deletions =
        row.placement === 'worktree'
          ? stat?.total_deletions ?? 0
          : files.reduce((sum, file) => sum + file.deletions, 0);
      const hasFiles = files.length > 0;

      const ready = readyToReview(row);
      const detailsOpen = openCards.has(row.key);
      const activity = summaryLine(row.summary, row.task?.goal, row.status);

      return (
        <article
          className={`fleet-card status-${row.status} placement-${row.placement}${ready ? ' ready' : ''}`}
          key={row.key}
        >
          {/* The whole card at rest: who, what it's on, and its state, in one
              row. Clicking it opens the details below. The mark sits in a
              fixed tile because AgentBrandMark draws at 100% of whatever
              contains it; an unsized parent lets a fetched favicon render at
              its own intrinsic size. */}
          <button
            type="button"
            className="fc-row"
            onClick={() => toggleCard(row.key)}
            aria-expanded={detailsOpen}
            title={detailsOpen ? 'Hide details' : 'Show changes, branch and actions'}
          >
            <span className="fc-brand-tile">
              {/* The CLI's product name, not the assistant's: an unbundled CLI's
                  logo is looked up by name, so "Nova" fetched the wrong one. */}
              <AgentBrandMark
                command={row.agentPreset}
                name={getAgentDisplayName(row.agentPreset) ?? row.agentName}
                className="fc-brand"
              />
            </span>
            <span className="fc-main">
              <span className="fc-name">{row.agentName}</span>
              <span className="fc-activity" title={activity}>{activity}</span>
            </span>
            <span
              className={`fc-status fc-status-${row.status}`}
              title={row.workingSince !== null ? `Working for ${formatElapsed(Date.now() - row.workingSince)}` : undefined}
            >
              <i className="fc-status-dot" aria-hidden="true" />
              {STATUS_LABEL[row.status]}
            </span>
            <svg className={`fc-row-caret${detailsOpen ? ' open' : ''}`} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>

          {detailsOpen && (
          <div className="fc-details">
          <div className="fc-meta">
            {worktree ? (
              <span
                className="fc-branch"
                title={`Isolated worktree\n${worktree.branch}\nForked from ${worktree.baseBranch}\n${worktree.path}`}
              >
                {worktree.branch}
              </span>
            ) : (
              /* Named for what it is. Without this the card would show a
                 branch name identical to the user's own and read as if the
                 agent had somewhere of its own to merge back from. */
              <span
                className="fc-branch"
                title={`Running in the project root, with no worktree isolation.\nIts edits go straight into your checkout${mainBranch ? ` on ${mainBranch}` : ''}.`}
              >
                <span className="fc-placement">main repo</span>
                {mainBranch && <span className="fc-branch-name">{mainBranch}</span>}
              </span>
            )}
            {stat ? (
              <span
                className="fc-stat"
                title={
                  row.placement === 'worktree'
                    ? 'Everything this agent changed in its own worktree'
                    : 'Files that changed while this agent was the one working'
                }
              >
                <span className="fc-add">+{additions}</span>
                <span className="fc-del">&minus;{deletions}</span>
              </span>
            ) : (
              <span className="fc-stat fc-stat-loading">…</span>
            )}
          </div>

          {worktree?.stageConflict && (
            <div className="fc-warning">
              Staging is paused. This worktree conflicts with edits already in
              your working tree. Resolve them in Source Control, then stage again.
            </div>
          )}

          {/* The reason a quarantine exists: an agent that finished, work that
              hasn't been reviewed. Read as a cue to look, not an alarm — the
              card's diff is one click away, and merging or discarding is the
              resolution. */}
          {ready && (
            <div className="fc-ready">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              <span>
                Ready to review: {files.length} file{files.length === 1 ? '' : 's'}, isolated on{' '}
                <code>{worktree?.branch}</code>
              </span>
            </div>
          )}

          <button
            className="fc-files-toggle"
            onClick={() => {
              setExpanded((current) => (current === row.key ? null : row.key));
              setOpenFileKey(null);
            }}
            aria-expanded={isExpanded}
            disabled={!hasFiles}
          >
            <svg
              className={`fc-caret${isExpanded ? ' expanded' : ''}`}
              width="9" height="9" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>
            {!stat
              ? 'Reading changes…'
              : files.length === 0
                ? 'No changes yet'
                : `${files.length} changed file${files.length === 1 ? '' : 's'}`}
          </button>

          {isExpanded && stat && row.placement === 'main' && (
            /* The rest of the checkout is deliberately not hidden in
               silence. This agent shares the tree with you and with every
               other main-repo agent, so "not attributed to it" covers your
               own edits, another agent's, and anything that was already
               changed before the panel started watching. */
            <div className="fc-note">
              {othersCount > 0
                ? `Files that changed while this agent was working. ${othersCount} other changed
                   file${othersCount === 1 ? '' : 's'} in your checkout ${othersCount === 1 ? 'is' : 'are'}
                   not attributed to it.`
                : 'Files that changed while this agent was working, out of everything uncommitted in your checkout.'}
            </div>
          )}

          {isExpanded && stat && (
            <div className="fc-files">
              {files.map((file) => {
                const fileKey = `${row.key}::${file.path}`;
                const fileOpen = openFileKey === fileKey;
                return (
                  <div className="fc-file" key={file.path}>
                    <button
                      className="fc-file-row"
                      onClick={() => setOpenFileKey(fileOpen ? null : fileKey)}
                      title={`${fileOpen ? 'Hide' : 'Show'} diff for ${file.path}`}
                    >
                      <FileIcon name={file.path.split('/').pop() || ''} isDir={false} />
                      <span className="fc-file-path">{file.path}</span>
                      {row.placement === 'main' && isSharedFile(key, file.path) && (
                        /* Two agents were producing output over the interval
                           this file moved in, so which of them wrote it is
                           not something the evidence can settle. Say so
                           rather than letting one card claim it. */
                        <span
                          className="fc-file-shared"
                          title="Another agent was also working when this file changed"
                        >
                          shared
                        </span>
                      )}
                      <span className={`fc-file-badge ${file.status}`}>
                        {file.status.charAt(0).toUpperCase()}
                      </span>
                      <span className="fc-file-stat">
                        <span className="fc-add">+{file.additions}</span>
                        <span className="fc-del">&minus;{file.deletions}</span>
                      </span>
                    </button>
                    {fileOpen && (
                      <div className="fc-file-diff">
                        {/* Pointed at the agent's own repo, measured against
                            the base the stat above used — `stat.base_commit`
                            rather than `row.baseCommit`, because a main-repo
                            row asks for HEAD without knowing its sha and the
                            two views must agree. This is the §7 dependency:
                            the diff viewer takes a repo path instead of
                            assuming the active project. Read-only — merge and
                            discard are the actions here, not partial staging
                            of finished work belonging to someone else. */}
                        <HunkDiffView
                          projectId={row.projectId}
                          repoPath={row.repoPath}
                          filePath={file.path}
                          side="unstaged"
                          baseRef={stat.base_commit}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {pendingConfirm && worktree ? (
            <div className="fc-confirm">
              <span className="fc-confirm-text">
                {pendingConfirm === 'merge' ? (
                  <>
                    Merge <strong>{worktree.branch}</strong> into{' '}
                    <strong>{worktree.baseBranch}</strong>?
                  </>
                ) : (
                  <>
                    Delete the worktree and branch <strong>{worktree.branch}</strong>?
                    Anything not yet in your working tree is staged first.
                  </>
                )}
              </span>
              <div className="fc-confirm-actions">
                <button
                  className={`fc-btn ${pendingConfirm === 'discard' ? 'danger' : 'primary'}`}
                  onClick={() =>
                    pendingConfirm === 'merge' ? doMerge(row) : doDiscard(row)
                  }
                  disabled={isBusy}
                >
                  {pendingConfirm === 'merge' ? 'Merge' : 'Discard'}
                </button>
                <button className="fc-btn" onClick={() => setConfirming(null)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            /* Split into two groups so the row can't wrap into an
               undifferentiated block of four equal buttons: the actions
               that move work lead, navigation and destruction sit apart
               and quiet.

               A main-repo card carries only the right-hand group. Bring in,
               Merge and Discard all name a branch this agent does not have:
               its edits are already in your tree, so there is nothing to
               copy across and nothing that could be thrown away without
               throwing away your own work with it. Showing them greyed out
               would just be four dead controls on every such card. */
            <div className="fc-actions">
              {worktree && (
                <div className="fc-actions-main">
                  <button
                    className="fc-btn"
                    onClick={() => doStage(row)}
                    disabled={isBusy}
                    title="Apply this agent's changes to your main checkout for local testing. Your main branch is not committed or pushed, and running agents keep their worktrees. Closed, fully brought-in worktrees are cleaned up automatically."
                  >
                    Bring in
                  </button>
                  <button
                    className="fc-btn primary"
                    onClick={() => setConfirming({ key: row.key, action: 'merge' })}
                    disabled={isBusy}
                    title={`Create a local merge commit from ${worktree.branch} in the main checkout. Nothing is pushed.`}
                  >
                    Merge into{' '}
                    {/* The base branch is arbitrary-length; clamp it here so a
                        long name can't blow the button out of the row. */}
                    <span className="fc-btn-branch">{worktree.baseBranch}</span>
                  </button>
                </div>
              )}
              <div className="fc-actions-aside">
                {/* The dedicated review pane — the Orca-style gate. Reading
                    one file at a time inline (See changes) is fine for a
                    glance; this is the focused surface for actually
                    judging a finished worktree before merging it. */}
                {worktree && hasFiles && (
                  <button
                    className="fc-btn review"
                    onClick={() => setReviewing(row.key)}
                    disabled={isBusy}
                    title={`Open the full review of ${worktree.branch} against ${worktree.baseBranch}`}
                  >
                    Review
                  </button>
                )}
                {/* Reading the work is the one thing every card can offer,
                    whatever the placement. It drives the same disclosure as
                    the file-count row above so there is one expanded state,
                    not two that can disagree. */}
                <button
                  className="fc-btn quiet"
                  onClick={() => {
                    setExpanded((current) => (current === row.key ? null : row.key));
                    setOpenFileKey(null);
                  }}
                  aria-expanded={isExpanded}
                  disabled={!hasFiles}
                  title={
                    hasFiles
                      ? `${isExpanded ? 'Hide' : 'Show'} the files this agent changed`
                      : 'Nothing has changed yet'
                  }
                >
                  {isExpanded ? 'Hide changes' : 'See changes'}
                </button>
                {row.sessionId !== null && (
                  <button
                    className="fc-btn quiet"
                    onClick={() => setActiveSession(row.sessionId!)}
                    title="Focus this agent's terminal"
                  >
                    Terminal
                  </button>
                )}
                {worktree && (
                  <button
                    className="fc-btn quiet danger"
                    onClick={() => setConfirming({ key: row.key, action: 'discard' })}
                    // Refusing while the pane is live is the safety rule, not a
                    // convenience: killing an agent mid-write and deleting its
                    // checkout cannot be undone.
                    disabled={isBusy || row.live}
                    title={
                      row.live
                        ? 'Close this agent first. Discarding a worktree while it is still writing is unrecoverable.'
                        : `Delete the worktree and branch ${worktree.branch}`
                    }
                  >
                    Discard
                  </button>
                )}
              </div>
            </div>
          )}
          </div>
          )}
        </article>
      );
  };

  return (
    <div className="fleet-root">
      <header className="fleet-head">
        <div className="fleet-head-left">
          <span className="fleet-icon">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
          </span>
          <span className="fleet-title">Agent Fleet</span>
        </div>
        <span className="fleet-count-pill">
          {rows.length} agent{rows.length === 1 ? '' : 's'}
          {isolatedCount > 0 && isolatedCount < rows.length && ` · ${isolatedCount} isolated`}
        </span>
      </header>

      {/* The fleet's state in one slim line. Working leads; clicking it opens
          the list of who is working, on what, and for how long. */}
      <div className={`fleet-strip${working.length > 0 ? ' is-active' : ''}`}>
        <span className="fleet-strip-dot" aria-hidden="true" />
        <span className="fleet-strip-working">
          {working.length > 0 ? `${working.length} working` : 'None working'}
        </span>
        {awaitingCount > 0 && (
          <span className="fleet-chip fleet-chip-awaiting">{awaitingCount} need{awaitingCount === 1 ? 's' : ''} input</span>
        )}
        {readyCount > 0 && <span className="fleet-chip fleet-chip-ready">{readyCount} ready</span>}
        {idleCount > 0 && <span className="fleet-chip fleet-chip-idle">{idleCount} idle</span>}
        {working.length > 0 && <span className="fleet-strip-sweep" aria-hidden="true" />}
      </div>

      <div className={`fleet-grid${suppressEnter ? ' no-enter' : ''}`}>{ordered.map(renderCard)}</div>

      {reviewing &&
        (() => {
          const row = rows.find((r) => r.key === reviewing);
          if (!row?.worktree) return null;
          return (
            <WorktreeReviewModal
              projectId={row.projectId}
              agentName={row.agentName}
              agentPreset={row.agentPreset}
              worktree={row.worktree}
              repoPath={row.repoPath ?? row.worktree.path}
              baseCommit={row.baseCommit ?? row.worktree.baseCommit}
              live={row.live}
              onClose={() => setReviewing(null)}
              // Merge and discard resolve the card; bring-in changes the main
              // checkout the card's numbers are read against. Refresh either way.
              onResolved={() => void refreshStats(rows)}
            />
          );
        })()}
    </div>
  );
}
