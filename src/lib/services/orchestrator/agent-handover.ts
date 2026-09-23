/**
 * The words a successor is given when it inherits half a feature.
 *
 * Crossing to a different CLI needs a written brief, because the successor has
 * no history at all. Crossing to another account of the *same* CLI often does
 * not — the worktree carries the work and the CLI's own session resume may
 * carry the conversation — but it costs little to say what happened, and the
 * successor reading a diff it did not write is the normal case either way.
 *
 * ## Everything here is built from evidence
 *
 * The outgoing agent is never asked to summarise its own unfinished work. It
 * ran out of usage; that is precisely the state in which it cannot answer. So
 * the brief is assembled from four things Spacron already holds, three of which
 * are observed facts rather than claims:
 *
 * - **the goal** — `task.goal`, on the record since the task was created;
 * - **what landed** — `getWorktreeDelta()`, which is git's answer about the
 *   branch, not the agent's;
 * - **what the agent last said** — the ANSI-stripped transcript tail, quoted as
 *   a *claim* and labelled as one;
 * - **why the handover happened** — the migration record.
 *
 * The distinction in the third bullet is the one that matters. A dying agent's
 * last paragraph is frequently a plan it never carried out. Presenting that as
 * "what is done" is how a successor marks a feature complete that was never
 * built, so the brief tells it to trust the diff over the sentence.
 *
 * Pure and I/O-free, so the wording can be tested without a running agent.
 */

import type { OrchestratorTask, TaskMigration } from './task-lifecycle';
import type { WorktreeDelta } from './worktree-manager';

/** How much of the outgoing agent's last words to carry across. */
const TRANSCRIPT_TAIL_CHARS = 1200;

export interface HandoverBriefInput {
  task: Pick<OrchestratorTask, 'goal' | 'title' | 'transcript' | 'worktree'>;
  /** The agent that is handing over, as the user would name it. */
  fromLabel: string;
  /** The agent taking over, as the user would name it. */
  toLabel: string;
  /** Git's account of what the branch holds. Null when it could not be read. */
  delta: WorktreeDelta | null;
  /** Why the work moved, in one sentence. */
  reason: string;
  /** Earlier hops, so a third agent sees the whole chain rather than one link. */
  history?: readonly TaskMigration[];
}

/** The last words the outgoing agent printed, trimmed and squared off. */
function transcriptTail(transcript: string | null | undefined): string | null {
  const text = transcript?.trim();
  if (!text) return null;
  if (text.length <= TRANSCRIPT_TAIL_CHARS) return text;
  const cut = text.slice(-TRANSCRIPT_TAIL_CHARS);
  // Start at a line boundary so the excerpt does not open mid-word.
  const newline = cut.indexOf('\n');
  return (newline > 0 ? cut.slice(newline + 1) : cut).trim();
}

/** Git's account of the branch, as a sentence rather than a struct. */
function describeDelta(delta: WorktreeDelta | null): string {
  if (!delta) {
    return 'I could not read the branch state, so check `git status` and `git log` yourself before assuming anything is or is not done.';
  }
  const parts: string[] = [];
  if (delta.committedFiles > 0) {
    parts.push(`${delta.committedFiles} file${delta.committedFiles === 1 ? '' : 's'} changed in commits on this branch`);
  }
  if (delta.dirtyFiles > 0) {
    parts.push(`${delta.dirtyFiles} file${delta.dirtyFiles === 1 ? '' : 's'} still uncommitted`);
  }
  if (!parts.length) {
    return 'The branch holds no changes yet — the previous agent stopped before anything landed, so you are starting this from the beginning.';
  }
  const first = delta.firstFile ? ` The first file it touched was \`${delta.firstFile}\`.` : '';
  return `The branch holds ${parts.join(', and ')}.${first}`;
}

/** Earlier hops, one line each, so a third agent sees the whole chain. */
function describeHistory(history: readonly TaskMigration[]): string | null {
  if (!history.length) return null;
  const lines = history.map((hop) => {
    const from = hop.fromAccountLabel ? `${hop.fromPreset} (${hop.fromAccountLabel})` : hop.fromPreset ?? 'an agent';
    const to = hop.toAccountLabel ? `${hop.toPreset} (${hop.toAccountLabel})` : hop.toPreset;
    return `- ${from} → ${to}: ${hop.reason}`;
  });
  return `This work has already been handed over ${history.length === 1 ? 'once' : `${history.length} times`}:\n${lines.join('\n')}`;
}

/**
 * The message a successor receives as its first instruction.
 *
 * Written as a handover between colleagues rather than as a status dump,
 * because that is what it is: the successor's first job is to read the diff and
 * finish what it finds, which is an ordinary task for a coding agent and should
 * read like one.
 */
export function buildHandoverBrief(input: HandoverBriefInput): string {
  const { task, fromLabel, toLabel, delta, reason } = input;

  const sections: string[] = [
    `You are taking over unfinished work from ${fromLabel}. ${reason}`,
    `The goal, unchanged:\n${task.goal.trim() || task.title}`,
    `You are already in ${fromLabel}'s checkout, on its branch, with every edit it made in place — committed and uncommitted. Nothing has been lost and nothing needs re-doing from scratch.`,
    `What git says landed: ${describeDelta(delta)}`,
  ];

  const history = describeHistory(input.history ?? []);
  if (history) sections.push(history);

  const tail = transcriptTail(task.transcript);
  if (tail) {
    sections.push(
      [
        `The last thing ${fromLabel} printed, for context only:`,
        '```',
        tail,
        '```',
        `Treat that as a claim, not as a record. It stopped mid-feature, so anything it said it was "about to" do almost certainly is not done. Where its words and the diff disagree, the diff is right.`,
      ].join('\n')
    );
  }

  sections.push(
    [
      'Start by reading the diff on this branch to see exactly where it got to. Then finish the goal above:',
      '- Complete anything half-done — a function added without its caller updated, a test written but not run.',
      '- Keep working on this branch. Do not reset, rebase, or discard what is already here.',
      `- When the feature is genuinely finished, say so explicitly (the user is told you finished only when you declare it).`,
    ].join('\n')
  );

  void toLabel;
  return sections.join('\n\n');
}

/**
 * What is sent *into the dying agent's* session before it is stopped.
 *
 * The gentlest step of the ladder, and the reason a handover is not a crash: an
 * agent that lands its current edit and commits leaves its successor a tree
 * that makes sense. Most CLIs take a queued message at their next safe point,
 * which is usually within seconds of a tool call returning.
 */
export function buildWrapUpRequest(headroomPercent: number | null): string {
  const left = headroomPercent == null ? 'almost none' : `${Math.round(headroomPercent)}%`;
  return [
    `Stop here please — your account has ${left} of its usage limit left and the rest of this feature is being handed to another agent.`,
    '',
    'Do exactly this and nothing more:',
    '1. Finish only the edit you have in hand. Do not start anything new.',
    '2. Commit everything on this branch, even if it is incomplete. A commit message saying what is half-done is ideal.',
    '3. Reply with one paragraph: what you completed, and what the next agent has to pick up.',
    '',
    'Do not try to finish the feature.',
  ].join('\n');
}

/** The one-sentence reason recorded on the migration and shown to the user. */
export function describeHandoverReason(
  fromLabel: string,
  headroomPercent: number | null,
  resetAtMs: number | null,
  now = Date.now()
): string {
  const left = headroomPercent == null ? 'ran out of usage' : `dropped to ${Math.round(headroomPercent)}% usage left`;
  if (resetAtMs == null || resetAtMs <= now) return `${fromLabel} ${left}.`;
  const mins = Math.round((resetAtMs - now) / 60000);
  const wait =
    mins < 60 ? `${mins}m` : mins < 60 * 24 ? `${Math.floor(mins / 60)}h` : `${Math.round(mins / 1440)}d`;
  return `${fromLabel} ${left}, with ${wait} to reset.`;
}

/**
 * The migration story for a completion card, one clause per hop.
 *
 * **The constraint that shapes this.** `endedBy` distinguishes a turn the agent
 * *declared* finished from one we merely watched go quiet, and only a declared
 * end may use the word "finished". A migration summary has to keep that per
 * hop: "Claude went quiet at 98%" and "Claude declared it was done" are
 * different claims, and flattening them is how a user gets told work completed
 * that never did. So every hop here is described by what was *observed* — how
 * much headroom was left, how the agent stopped, how many files it left behind
 * — and never by "it finished X".
 */
export function describeMigrationChain(migrations: readonly TaskMigration[]): string | null {
  if (!migrations.length) return null;

  const clauses = migrations.map((hop) => {
    const from = hop.fromAccountLabel
      ? `${hop.fromPreset} (${hop.fromAccountLabel})`
      : hop.fromPreset ?? 'the first agent';
    const to = hop.toAccountLabel ? `${hop.toPreset} (${hop.toAccountLabel})` : hop.toPreset;
    const left = hop.fromHeadroomPercent == null ? 'ran out' : `dropped to ${Math.round(hop.fromHeadroomPercent)}%`;
    const landed =
      hop.filesChanged == null
        ? ''
        : ` leaving ${hop.filesChanged} changed file${hop.filesChanged === 1 ? '' : 's'} on the branch`;
    const stopped =
      hop.stoppedBy === 'interrupt'
        ? ' It did not stop when asked, so it was interrupted.'
        : hop.stoppedBy === 'wrap-up'
          ? ' It wrapped up and committed first.'
          : '';
    return `${from} ${left}${landed}, and ${to} picked the work up on the same branch.${stopped}`;
  });

  return clauses.join(' ');
}
