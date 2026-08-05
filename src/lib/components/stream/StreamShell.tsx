/**
 * The stream — one column, sorted by what needs a human.
 *
 * ## Why this exists
 *
 * The ambient shell shows the workspace as a *place*: a grid of rooms, two
 * drawers, a dock, five layout presets. That is a good answer to "where is
 * everything" and a poor answer to the question a person actually arrives with,
 * which is "what needs me?". With four agents running, the answer to that was
 * spread across four rooms, a panel, and a mailbox strip that was never mounted.
 *
 * So the front door is a single 820px column in three bands:
 *
 * 1. **Waiting for you** — the only band that holds decisions. Full-width cards,
 *    diff attached, two buttons: merge it, or send it back with a note.
 * 2. **Working now** — one line per agent, led by *what it is doing right now*
 *    (the pane's OSC title). That was the biggest thing the fleet panel could
 *    not tell you: it said "Working" and stopped.
 * 3. **Done today** — collapsed history, not a column of cards.
 *
 * Everything else — diffs in full, terminal, editor, preview — lives in a
 * slide-over ({@link StreamSheet}), one click deep and never docked.
 *
 * ## Simple and Pro are one layout, not two
 *
 * `uiDensity` toggles detail *in place*: branch names, `+N/−M`, placement
 * labels and the developer tools appear in Pro and are hidden in Simple. The
 * boxes do not move. A density switch that re-flowed the page would be a second
 * design to maintain and would make the toggle feel like a different app.
 *
 * ## What is real and what is not yet
 *
 * Band 1 merges two sources that both already ship: actionable mailbox cards
 * (an agent explicitly asking for a decision) and finished agents with changes
 * to judge. It is *not* backed by a review state in the task machine —
 * `OrchestratorTaskStatus` has no `in-review`, so "waiting for you" is derived
 * here from `blocked`/`complete` plus a non-empty diff. Adding the real state is
 * the next piece of work; until then this reads the world rather than inventing
 * a status it cannot persist.
 *
 * The plain-English line under each card is the agent's own words — a mailbox
 * card's text, or the task goal. Producing a written-for-a-human summary of what
 * changed is an orchestrator-brain job that does not exist yet, and a fabricated
 * one would be worse than the agent's own sentence.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import TitleBar from '$lib/components/layout/TitleBar.tsx';
import UpdateBanner from '$lib/components/shared/UpdateBanner.tsx';
import WelcomeScreen from '$lib/components/workspace/WelcomeScreen.tsx';
import FloatingPromptBar from '$lib/components/terminal/FloatingPromptBar.tsx';
import { AgentBrandMark } from '$lib/components/shared/useAgentBrand.tsx';
import StreamSheet, { type SheetTab } from './StreamSheet.tsx';
import { useStore } from '$lib/react/useStore';
import { activeProject, toggleProjectHUD } from '$lib/stores/workspace';
import { showToast } from '$lib/stores/notification';
import { toggleCommandPalette } from '$lib/stores/commandpalette';
import { openSettings } from '$lib/stores/layout';
import { shellMode, uiDensity } from '$lib/stores/settings';
import {
  focusPromptBar,
  killSession,
  promptBarInput,
  sendPromptToSession,
  setActiveSession,
} from '$lib/stores/terminal';
import {
  approveMailboxCard,
  mergeAndApproveMailboxCard,
  orchestratorTasks,
  replyToMailboxCard,
  resumeBlockedOrchestratorTask,
} from '$lib/stores/orchestrator';
import {
  dismissMailboxCard,
  getMailboxCards,
  mailbox,
  mailboxSeen,
  type MailboxCard,
} from '$lib/services/orchestrator/mailbox';
import { mergeTaskWorktree } from '$lib/services/orchestrator/worktree-manager';
import {
  statKey,
  useFleetRows,
  useFleetStats,
  type DiffStat,
  type FleetRow,
} from '$lib/components/orchestrator/useFleetRows';
import type { OrchestratorTask } from '$lib/services/orchestrator/task-lifecycle';
import './StreamShell.css';

/** Openers for a first-run project, filled into the composer rather than sent. */
const EXAMPLE_PROMPTS = [
  'Fix the login crash',
  'Add dark mode',
  'Write tests for checkout',
];

/**
 * One decision waiting on the user.
 *
 * Either source can be missing: a mailbox card without a matching agent is still
 * a question that needs answering, and a finished agent that never wrote to the
 * mailbox still has a diff to judge. What the card can *do* follows from which
 * halves are present, which is why both are carried rather than flattened.
 */
interface ReviewItem {
  id: string;
  agentName: string;
  agentPreset: string | null;
  /** The agent's own words. Never generated here — see the file header. */
  say: string;
  at: number;
  card: MailboxCard | null;
  row: FleetRow | null;
}

function ageLabel(ts: number, now: number): string {
  const mins = Math.floor(Math.max(0, now - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export default function StreamShell() {
  const project = useStore(activeProject);
  const projectId = project?.id ?? null;
  const density = useStore(uiDensity);
  const pro = density === 'pro';

  const rows = useFleetRows();
  const { stats, refresh } = useFleetStats(rows);
  const tasks = useStore(orchestratorTasks);

  // Both mailbox stores, so the queue recomputes as traffic arrives *and* as the
  // user works cards off it; `getMailboxCards` reads them via `get()` internally.
  const allMail = useStore(mailbox);
  const seen = useStore(mailboxSeen);
  const cards = useMemo(
    () => (projectId ? getMailboxCards(projectId, { actionableOnly: true }) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allMail, seen, projectId],
  );

  const [sheetRowKey, setSheetRowKey] = useState<string | null>(null);
  const [sheetTab, setSheetTab] = useState<SheetTab>('changes');
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');
  const [confirmMerge, setConfirmMerge] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [showDone, setShowDone] = useState(false);

  const now = Date.now();

  /**
   * Band 1. Mailbox cards lead — an agent that asked a question is more
   * explicitly blocked on you than one that merely finished — and each pulls in
   * its agent's row so the same card can both answer the question and merge the
   * branch.
   */
  const reviewItems = useMemo<ReviewItem[]>(() => {
    const items: ReviewItem[] = [];
    const claimedRowKeys = new Set<string>();

    for (const card of cards) {
      const row =
        rows.find((r) => r.task?.id && r.task.id === card.taskId) ??
        rows.find((r) => r.agentName === card.from) ??
        null;
      if (row) claimedRowKeys.add(row.key);
      items.push({
        id: `card:${card.id}`,
        agentName: row?.agentName ?? card.from,
        agentPreset: row?.agentPreset ?? null,
        say: card.text,
        at: card.createdAt,
        card,
        row,
      });
    }

    for (const row of rows) {
      if (claimedRowKeys.has(row.key)) continue;
      if (row.status !== 'finished' && row.status !== 'awaiting') continue;
      if (row.status === 'finished') {
        // A finished agent with nothing to show is history, not a decision — it
        // belongs in "Done today". Waiting on the first stat read is deliberate:
        // promoting a row to band 1 and demoting it a second later would make
        // the band flicker on every project open.
        //
        // `awaiting` is exempt: a blocked agent is parked *on the human*, which
        // is this band's whole subject. Gating it on a diff would hide the agent
        // that asked a question before writing any code — and that agent is
        // stuck until it is answered.
        const stat = stats[statKey(row)];
        if (!stat || stat.files.length === 0) continue;
      }
      items.push({
        id: `row:${row.key}`,
        agentName: row.agentName,
        agentPreset: row.agentPreset,
        say:
          row.task?.blockedReason?.trim() ||
          row.task?.goal?.trim() ||
          'Finished, and left changes to look at.',
        at: row.task?.completedAt ?? row.task?.startedAt ?? row.task?.createdAt ?? now,
        card: null,
        row,
      });
    }

    return items.sort((a, b) => b.at - a.at);
    // `now` only breaks ties on rows with no timestamps at all; excluded so the
    // list does not rebuild on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cards, rows, stats]);

  const reviewRowKeys = useMemo(
    () => new Set(reviewItems.map((item) => item.row?.key).filter(Boolean) as string[]),
    [reviewItems],
  );
  const reviewTaskIds = useMemo(
    () => new Set(reviewItems.map((item) => item.row?.task?.id).filter(Boolean) as string[]),
    [reviewItems],
  );

  /** Band 2 — live agents only. An exited pane has stopped, whatever it left. */
  const workingRows = useMemo(
    () => rows.filter((row) => row.status === 'working' && !reviewRowKeys.has(row.key)),
    [rows, reviewRowKeys],
  );

  /** Band 3 — what closed out today, minus anything still awaiting a decision. */
  const doneTasks = useMemo<OrchestratorTask[]>(() => {
    if (!projectId) return [];
    const since = startOfToday();
    return tasks
      .filter((task) => task.projectId === projectId)
      .filter((task) => ['complete', 'failed', 'cancelled'].includes(task.status))
      .filter((task) => (task.completedAt ?? task.createdAt) >= since)
      .filter((task) => !reviewTaskIds.has(task.id))
      .sort((a, b) => (b.completedAt ?? b.createdAt) - (a.completedAt ?? a.createdAt));
  }, [tasks, projectId, reviewTaskIds]);

  const sheetRow = useMemo(
    () => rows.find((row) => row.key === sheetRowKey) ?? null,
    [rows, sheetRowKey],
  );
  const sheetStat: DiffStat | undefined = sheetRow ? stats[statKey(sheetRow)] : undefined;

  // A row can vanish under the sheet — its worktree discarded, its pane closed.
  // Leaving a sheet open over nothing would strand the user behind a scrim.
  useEffect(() => {
    if (sheetRowKey && !sheetRow) setSheetRowKey(null);
  }, [sheetRowKey, sheetRow]);

  const withBusy = useCallback((id: string, fn: () => Promise<void>) => {
    setBusy((current) => new Set(current).add(id));
    void fn().finally(() => {
      setBusy((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    });
  }, []);

  function openSheet(row: FleetRow, tab: SheetTab = 'changes') {
    setSheetRowKey(row.key);
    setSheetTab(tab);
  }

  /**
   * "Looks good."
   *
   * What that means depends on what the item is made of: answering the agent's
   * question, merging its branch, or both. `mergeAndApproveMailboxCard` exists
   * precisely for the both-case, so it is preferred over doing the two halves
   * separately and risking a merge that lands with the agent never told.
   */
  function approve(item: ReviewItem) {
    setConfirmMerge(null);
    const rootPath = project?.root_path ?? null;
    withBusy(item.id, async () => {
      try {
        if (item.card && item.row?.worktree) {
          await mergeAndApproveMailboxCard(item.row.projectId, item.card, rootPath);
        } else if (item.card) {
          await approveMailboxCard(projectId!, item.card, rootPath);
        } else if (item.row?.worktree) {
          const worktree = item.row.worktree;
          const result = await mergeTaskWorktree(item.row.projectId, worktree, false);
          if (result.conflicted) {
            showToast(
              `${item.agentName}: the merge hit conflicts — open Source Control to sort them out.`,
              'warning',
              14000,
              true,
            );
          } else if (result.success) {
            showToast(`Merged ${item.agentName}'s work into ${worktree.baseBranch}.`, 'success', 8000);
          } else {
            showToast(result.message || 'The merge did not go through.', 'error', 10000);
          }
        }
      } catch (err) {
        showToast(String(err), 'error', 10000);
      }
      await refresh();
    });
  }

  /**
   * "Ask for changes."
   *
   * Three delivery routes, in order of how directly they reach the agent: reply
   * on the card it sent, resume a task the machine has parked as blocked, or
   * type straight into a live pane. If none apply the agent is gone, and saying
   * so beats swallowing the note.
   */
  function sendBack(item: ReviewItem) {
    const text = replyText.trim();
    if (!text) return;
    const rootPath = project?.root_path ?? null;
    setReplyingTo(null);
    setReplyText('');
    withBusy(item.id, async () => {
      try {
        if (item.card) {
          await replyToMailboxCard(projectId!, item.card, text, rootPath);
        } else if (item.row?.task && item.row.task.status === 'blocked' && rootPath) {
          await resumeBlockedOrchestratorTask(item.row.task.id, text, rootPath);
        } else if (item.row?.sessionId !== null && item.row?.live) {
          sendPromptToSession(item.row.sessionId!, text, item.row.agentPreset);
        } else {
          showToast(
            `${item.agentName} has stopped, so there was nowhere to send that. Start it again to carry on.`,
            'warning',
            10000,
          );
          return;
        }
        showToast(`Sent back to ${item.agentName}. It keeps its work and picks up from here.`, 'success', 7000);
      } catch (err) {
        showToast(String(err), 'error', 10000);
      }
    });
  }

  if (!project) {
    return (
      <div className="stream-shell">
        <TitleBar />
        <UpdateBanner />
        <div className="stream-welcome">
          <WelcomeScreen />
        </div>
      </div>
    );
  }

  const nothingYet =
    reviewItems.length === 0 && workingRows.length === 0 && doneTasks.length === 0;

  return (
    <div className="stream-shell" data-density={density}>
      <TitleBar />
      <UpdateBanner />

      {/* Same two wrappers the ambient shell uses, because the UI zoom setting
          is implemented by `.zoom-content`'s `zoom` — a shell that skipped them
          would quietly ignore ⌘+ / ⌘−. */}
      <div className="zoom-wrapper">
      <div className="zoom-content">

      <header className="stream-top">
        <button
          className="st-project"
          onClick={() => toggleProjectHUD()}
          title="Switch project"
        >
          <span className="st-project-sq">{project.name.charAt(0).toUpperCase()}</span>
          {project.name}
        </button>

        <div className="st-spacer" />

        <button className="st-omni" onClick={() => toggleCommandPalette()}>
          <span>Search or run a command</span>
          <kbd>⌘K</kbd>
        </button>

        <div className="st-seg" role="group" aria-label="How much to show">
          <button
            className={pro ? '' : 'on'}
            onClick={() => uiDensity.set('simple')}
            title="Just what you need to decide"
          >
            Simple
          </button>
          <button
            className={pro ? 'on' : ''}
            onClick={() => uiDensity.set('pro')}
            title="Branches, counts and the developer tools"
          >
            Pro
          </button>
        </div>

        {pro && (
          /* Only offered in Pro. The room grid is the power-user surface, and
             putting a one-click trip to a completely different shell in front of
             a first-time user is how they get lost. */
          <button
            className="st-icon"
            onClick={() => shellMode.set('ambient')}
            title="Switch to the room layout"
          >
            ▤
          </button>
        )}
        <button className="st-icon" onClick={() => openSettings()} title="Settings">
          ⚙
        </button>
      </header>

      <main className="stream-body">
        <div className="stream-wrap">
          {nothingYet && (
            <section className="st-firstrun">
              <h1>What should we build?</h1>
              <p>
                Describe it in your own words. Spacron reads the project first, works out
                what to do, and puts each agent in its own safe copy so nothing it tries
                can break what you have.
              </p>
              <div className="st-examples">
                {EXAMPLE_PROMPTS.map((example) => (
                  <button
                    key={example}
                    onClick={() => {
                      promptBarInput.set(example);
                      focusPromptBar();
                    }}
                  >
                    {example}
                  </button>
                ))}
              </div>
            </section>
          )}

          {reviewItems.length > 0 && (
            <section className="st-band" aria-labelledby="band-review">
              <div className="st-bandhead">
                <i className="st-dot attn" aria-hidden="true" />
                <h2 id="band-review">Waiting for you</h2>
                <span className="st-bandsub">
                  {reviewItems.length === 1
                    ? 'one thing needs a decision'
                    : `${reviewItems.length} things need a decision`}
                </span>
              </div>

              {reviewItems.map((item) => {
                const row = item.row;
                const stat = row ? stats[statKey(row)] : undefined;
                const isBusy = busy.has(item.id);
                const replying = replyingTo === item.id;
                const confirming = confirmMerge === item.id;
                const mergeable = Boolean(row?.worktree);

                return (
                  <article className="st-review" key={item.id}>
                    <header className="st-rh">
                      <span className="st-av">
                        <AgentBrandMark command={item.agentPreset} name={item.agentName} />
                      </span>
                      <div className="st-who">
                        <div className="st-ttl">
                          <span className="st-agent">{item.agentName}</span>{' '}
                          {item.card ? 'needs a decision' : 'finished its work'}
                          {row?.task?.title ? ` on “${row.task.title}”` : ''}
                        </div>
                        <p className="st-say">{item.say}</p>
                      </div>
                      <span className="st-when">{ageLabel(item.at, now)}</span>
                    </header>

                    <div className="st-facts">
                      {stat && stat.files.length > 0 && (
                        <span className="st-fact">
                          {stat.files.length} file{stat.files.length === 1 ? '' : 's'}
                          {pro && (
                            <>
                              {' '}
                              <span className="add">+{stat.total_additions}</span>{' '}
                              <span className="del">&minus;{stat.total_deletions}</span>
                            </>
                          )}
                        </span>
                      )}
                      {row?.worktree ? (
                        <span className="st-fact">
                          {pro ? row.worktree.branch : 'in its own safe copy'}
                        </span>
                      ) : row ? (
                        <span className="st-fact warn">edits your project folder directly</span>
                      ) : null}
                      {pro && item.card && <span className="st-fact">{item.card.kind}</span>}
                    </div>

                    {confirming && row?.worktree ? (
                      <div className="st-confirm">
                        <p>
                          Bring {item.agentName}'s work into{' '}
                          <strong>{row.worktree.baseBranch}</strong>? It joins your project
                          for real — you can still undo it in Source Control.
                        </p>
                        <div className="st-actions">
                          <button className="st-btn go" onClick={() => approve(item)} disabled={isBusy}>
                            Yes, merge it
                          </button>
                          <button className="st-btn" onClick={() => setConfirmMerge(null)}>
                            Not yet
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="st-actions">
                        <button
                          className="st-btn go"
                          disabled={isBusy}
                          onClick={() => (mergeable ? setConfirmMerge(item.id) : approve(item))}
                        >
                          ✓ {mergeable ? 'Looks good — merge it' : 'Looks good — carry on'}
                        </button>
                        <button
                          className="st-btn"
                          disabled={isBusy}
                          onClick={() => {
                            setReplyingTo(replying ? null : item.id);
                            setReplyText('');
                          }}
                        >
                          ↩ Ask for changes
                        </button>
                        {row && (
                          <button className="st-btn ghost tail" onClick={() => openSheet(row)}>
                            See everything →
                          </button>
                        )}
                        {item.card && (
                          <button
                            className="st-btn ghost"
                            onClick={() => dismissMailboxCard(item.card!.id)}
                            title="Clear this without answering"
                          >
                            Dismiss
                          </button>
                        )}
                      </div>
                    )}

                    {replying && (
                      <div className="st-sendback">
                        <textarea
                          autoFocus
                          value={replyText}
                          placeholder={`What should ${item.agentName} do differently?`}
                          onChange={(event) => setReplyText(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                              event.preventDefault();
                              sendBack(item);
                            }
                          }}
                        />
                        <div className="st-actions">
                          <span className="st-hint">
                            {item.agentName} keeps its work and picks up from here.
                          </span>
                          <button className="st-btn ghost" onClick={() => setReplyingTo(null)}>
                            Cancel
                          </button>
                          <button
                            className="st-btn go"
                            onClick={() => sendBack(item)}
                            disabled={!replyText.trim() || isBusy}
                          >
                            Send back to {item.agentName}
                          </button>
                        </div>
                      </div>
                    )}
                  </article>
                );
              })}
            </section>
          )}

          {workingRows.length > 0 && (
            <section className="st-band" aria-labelledby="band-working">
              <div className="st-bandhead">
                <i className="st-dot run" aria-hidden="true" />
                <h2 id="band-working">Working now</h2>
                <span className="st-bandsub">
                  {workingRows.length} agent{workingRows.length === 1 ? '' : 's'}
                </span>
              </div>

              {workingRows.map((row) => (
                <div
                  className="st-run"
                  key={row.key}
                  role="button"
                  tabIndex={0}
                  onClick={() => openSheet(row, 'terminal')}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      openSheet(row, 'terminal');
                    }
                  }}
                >
                  <span className="st-av small">
                    <AgentBrandMark command={row.agentPreset} name={row.agentName} />
                  </span>
                  <div className="st-runmid">
                    <div className="st-runname">
                      {row.agentName}
                      {row.task?.title && <em> — {row.task.title}</em>}
                    </div>
                    {/* The point of this band: what it is doing *right now*, from
                        the pane's own title. Falls back to the plain state rather
                        than inventing an activity. */}
                    <div className="st-runnow">
                      <i aria-hidden="true" />
                      {row.activity ?? 'working…'}
                    </div>
                  </div>
                  {pro && row.worktree && <span className="st-runbranch">{row.worktree.branch}</span>}
                  {row.sessionId !== null && (
                    <button
                      className="st-stop"
                      onClick={(event) => {
                        event.stopPropagation();
                        void killSession(row.sessionId!);
                      }}
                      title={`Stop ${row.agentName}`}
                    >
                      Stop
                    </button>
                  )}
                </div>
              ))}
            </section>
          )}

          {doneTasks.length > 0 && (
            <section className="st-band" aria-labelledby="band-done">
              <div className="st-bandhead">
                <i className="st-dot done" aria-hidden="true" />
                <h2 id="band-done">Done today</h2>
                <button
                  className="st-bandtoggle"
                  onClick={() => setShowDone((value) => !value)}
                  aria-expanded={showDone}
                >
                  {showDone ? 'Hide' : `Show ${doneTasks.length}`}
                </button>
              </div>

              {showDone &&
                doneTasks.map((task) => {
                  const failed = task.status !== 'complete';
                  const sessionId = task.assignedSessionId ?? task.lastSessionId ?? null;
                  return (
                    <div className="st-done" key={task.id}>
                      <span className={`st-tick${failed ? ' failed' : ''}`} aria-hidden="true">
                        {failed ? '×' : '✓'}
                      </span>
                      <b>{task.name?.trim() || 'Agent'}</b>
                      <span className="st-donetext">
                        {failed
                          ? task.failureReason?.trim() || `${task.status} — ${task.title}`
                          : task.title}
                      </span>
                      {sessionId !== null && (
                        <button
                          className="st-btn ghost tail"
                          onClick={() => setActiveSession(sessionId)}
                        >
                          Open its terminal
                        </button>
                      )}
                    </div>
                  );
                })}
            </section>
          )}
        </div>
      </main>

      <div className="stream-compose">
        <div className="stream-wrap">
          <FloatingPromptBar />
        </div>
      </div>

      <StreamSheet
        row={sheetRow}
        stat={sheetStat}
        tab={sheetTab}
        onTab={setSheetTab}
        onClose={() => setSheetRowKey(null)}
      />

      </div>
      </div>
    </div>
  );
}
