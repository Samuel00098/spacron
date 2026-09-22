/**
 * The Fleet Orchestrator protocol — the standing brief for an agent that runs
 * OTHER agents.
 *
 * Spacron exposes a handful of MCP tools to every launched CLI agent
 * (`list_agents`, `spawn_agent`, `send_to_agent`, `read_agent_output`, and
 * `report_status` — see `.spacron/memory/mcp-architecture.md` and
 * `.spacron/memory/agent-report-status.md`). Any agent holding those tools can
 * dispatch a team, review what comes back, send fixes, and iterate. What it
 * cannot do is invent a reliable protocol for that on its own — the failure
 * modes are specific and repeatable (reviewing half-written work, two workers on
 * one file, looping forever on taste). This module is that protocol, and it
 * ships with the app rather than being something the user writes.
 *
 * ## Why a file, not a pasted charter
 *
 * `ROLE_BRIEFS` in agent-charter.ts is deliberately ONE LINE per role: a long,
 * multi-line paste does not commit reliably into Ink-based REPLs — the agent
 * submits early and the brief arrives truncated. A full orchestration protocol
 * is ~70 lines, so it cannot go through the paste channel at all.
 *
 * So the app writes the protocol to disk and the one-line role brief points at
 * it (`ORCHESTRATOR_ROLE_BRIEF`). Every CLI agent can read a file, which also
 * makes this work for Codex/Cursor/Gemini and not only Claude Code — the
 * orchestrator is a role conferred by a prompt, never an agent type.
 *
 * Claude Code additionally gets a native skill at
 * `.claude/skills/orchestrate-fleet/SKILL.md` so it can discover the protocol
 * without being told. Same body, two delivery surfaces.
 *
 * See docs/agent-loops.md for the design and the known gaps this protocol works
 * around (no completion signal, no worktree on MCP spawn).
 */

import { backendInvoke } from '$lib/services/backend';
import { ORCHESTRATOR_BRIEF_PATH } from './agent-charter';

/**
 * `ORCHESTRATOR_BRIEF_PATH` and the one-line role brief live in agent-charter.ts
 * on purpose: this module imports `backendInvoke`, which pulls in
 * `@tauri-apps/api/core` at load, and agent-charter.ts is a pure module with
 * pure unit tests that must stay free of that chain. Constants flow charter →
 * here, never the reverse.
 */

/** Claude Code's native skill location for the same protocol. */
export const ORCHESTRATOR_SKILL_PATH = '.claude/skills/orchestrate-fleet/SKILL.md';

/** Directory workers write their completion reports into. */
export const REPORTS_DIR = '.spacron/reports';

/**
 * The protocol body.
 *
 * Every rule here exists because its absence is a known failure:
 *
 * - **Report files as the done signal** — `read_agent_output` returns a
 *   scrollback tail with no completion marker, and terminal output goes quiet
 *   mid-thought. An orchestrator that infers "finished" from silence reviews
 *   half-written work. Having the worker *declare* completion by writing a file
 *   is deterministic, carries a real summary instead of redraw noise, is cheap
 *   to poll with the orchestrator's own tools, and works for any agent that can
 *   write a file — so it doesn't depend on per-preset turn-signal support.
 * - **Disjoint file ownership** — MCP-spawned agents currently share the main
 *   checkout with no worktree isolation (docs/agent-loops.md, gap 1), so two
 *   workers on one file clobber each other silently.
 * - **Tests decide done** — an LLM reviewing an LLM does not converge on taste
 *   alone; self-correction without external feedback can make output worse
 *   (Huang et al., ICLR 2024). The deterministic check is the gate; the
 *   orchestrator's judgment shapes the feedback.
 * - **A round cap** — no loop should be unbounded, and nothing in the app
 *   enforces one here.
 */
export function buildOrchestratorBriefBody(): string {
  return `# Fleet Orchestrator protocol

You are the **orchestrator**. You run a team of agents; you do not do the implementation
yourself. Follow this protocol exactly — each rule exists because skipping it fails in a
specific, repeatable way.

## Your tools

Use these three for the loop — each one spawns or messages a worker **and waits for its
result**, so a round is one call, not a polling chore:

- \`delegate_task(preset, prompt, files, name)\` — hand a sub-task to a new worker and wait.
  Returns its report, its \`branch\`, and a \`handle\`.
- \`bounce_task(handle, feedback)\` — send a worker back to fix something, and wait for the
  redone work. **Use this, not \`send_to_agent\`, for another round** — it clears the old
  report first, so you can't be handed stale work.
- \`check_task(handle)\` — keep waiting on a worker that came back \`working\`.

Lower-level tools, for when you need to drive something yourself:
\`list_agents()\`, \`spawn_agent()\`, \`send_to_agent()\`, \`read_agent_output()\`.

\`report_status(state, detail)\` is how **you** reach the user. Call it with
\`needs_input\` the moment you are blocked on them, and with \`done\` or \`failed\` when
you stop. Spacron raises a notification from that call; without it the user only has
terminal output they may not be looking at, and your turn ends on a timeout instead of
when you actually finished.

You also keep your own shell and file tools. Use them for \`git\` and for running tests.

**Do not use your own in-process sub-agent feature for work that writes code.** It is fine
for read-only research, but an in-process sub-agent has no pane and no branch, so the user
cannot watch it, steer it, or review its diff — and neither can you.

If these tools are unavailable, stop and tell the user the Spacron MCP tools aren't
connected. Do not quietly do the whole task yourself.

## 1. Plan

Split the goal into **2–4 sub-tasks with disjoint file sets**. Write the split down before
spawning anything.

Worktrees mean two workers editing one file no longer clobber each other on disk — but
their branches still have to come back together, and overlapping edits become merge
conflicts you have to resolve. **Keep file sets disjoint.** If one file is genuinely
central to two concerns, that is one sub-task, not two.

## 2. Dispatch and wait

One call per worker:

\`delegate_task(preset, prompt, files, name)\`

Pass the sub-task as \`prompt\` and that worker's file set as \`files\`. **Do not write
reporting instructions into the prompt** — they are appended for you, with the right
absolute paths. Each worker gets its own pane and its own git branch.

**Write each \`prompt\` as a detailed brief, never a one-liner.** The worker sees nothing
but that prompt, so even when the user's goal was vague, spell it out: the goal and why;
the relevant files, functions and conventions you found (real paths only); numbered,
concrete requirements including edge cases; what must not change, including the files
sibling workers own; what "done" looks like; and the exact commands to verify it. Where
the goal leaves a choice open, decide and state it as an assumption.

**Leave \`name\` out.** Workers are named for you, from the same set the app uses, so the
user sees "Trinity" and "Morpheus" on the panes rather than \`claude-1\` and \`claude-2\` —
a generic label you pass is replaced by one of those anyway. Pass a name only when it
carries meaning for the user ("Reviewer"). Either way, address a worker by the \`handle\`
the result gives you, not by the name you asked for.

The call waits and comes back with one of:

- \`complete\` — \`report\` holds the worker's summary, \`branch\` its branch. Ready to review.
- \`blocked\` — it stopped and needs a decision from you.
- \`working\` — still going. Call \`check_task(handle)\` to keep waiting.
- \`gone\` — it exited without reporting; look at its pane.

To run workers in parallel, ask for a short \`wait_seconds\` on each so you get \`working\`
back quickly, then \`check_task\` them in turn.

**Review only once every worker in the round has reported.** Looking at them one at a time
as they finish throws away the thing only you can see — whether their changes are
consistent *with each other*.

## 4. Review

For each worker, in this order:

1. Read its report file.
2. Read the **actual change** — \`git diff <your-branch>..<worker-branch>\`, using the
   \`branch\` from \`list_agents()\`. The report says what it believes it did; the diff says
   what it did. Never review from \`read_agent_output\`.
3. Run the project's checks: its test suite, typecheck, and build. A worker's branch is a
   separate checkout, so to check the combined result you may need the branches merged
   into yours first — if you are not confident doing that safely, run the checks per
   branch and say so in your final report.

**The checks decide whether the work is done. You decide what to say about it.** Do not
accept a round because the code reads well, and do not accept a worker's claim that tests
pass — run them yourself. Look for what only you can see: two workers disagreeing on a
shared interface, a caller left behind by a signature change, the same helper written
twice.

## 5. Bounce or accept

For each worker that needs changes:

\`bounce_task(handle, feedback)\`

\`feedback\` must be **specific and actionable** — the file, the problem, and what "correct"
looks like. Never "please improve this". The call clears the old report and waits for the
redone work, so what comes back is the new attempt.

Workers whose work is fine are left alone. Only bounced workers consume a round.

## 6. Budget — stop at 3 rounds

Go back to the user, with what you have, when **any** of these is true:

- all workers are accepted and the project's checks pass — the success case;
- you have run **3 rounds** and are still bouncing work;
- a worker's branch or files did not change between rounds, or you find yourself writing
  the same critique twice — it is not converging;
- a worker is blocked on something only the user can decide;
- the checks pass but you believe the work is wrong, or the checks fail but you cannot
  say why.

**Never stop silently, and never keep going past the cap because it feels close.** An
unbounded loop burns the user's tokens on their own key.

## 7. Report to the user

End by telling the user, in plain language:

- what was built, and by which workers;
- what the checks say — the actual result, not a summary of intent;
- anything you bounced and why, and how many rounds it took;
- anything you could not resolve, stated plainly.

If work is incomplete or a check fails, say so directly. A confident report on broken work
is worse than no report.
`;
}

/**
 * The same protocol as a Claude Code skill. Frontmatter drives discovery, so the
 * description has to name the situations the user will actually describe.
 */
export function buildOrchestratorSkill(): string {
  return `---
name: orchestrate-fleet
description: Run a team of Spacron agents on one goal — split the work, dispatch workers, review what they produce, send back fixes, and iterate until the project's checks pass. Use when asked to orchestrate, coordinate, or run several agents, to "spin up agents" to build something, or when a task is large enough to split across workers.
---

${buildOrchestratorBriefBody()}`;
}

async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await backendInvoke<string>('fs_read_file', { path });
  } catch {
    return null;
  }
}

/** Write only when content actually differs, so we don't churn mtimes every launch. */
async function writeIfStale(path: string, content: string): Promise<boolean> {
  const current = await readFileOrNull(path);
  if (current === content) return false;
  await backendInvoke('fs_write_file', { path, content });
  return true;
}

/**
 * Ensure the project carries the current orchestrator protocol.
 *
 * Idempotent and best-effort: called on every agent launch, so it must be cheap
 * and must never block a launch. Unlike `ensureAgentRulesFiles` this is NOT
 * gated on `agentReadsRulesFile` — any agent can be handed the orchestrator
 * role, and any agent can read a file.
 *
 * Both files are fully app-managed (unlike CLAUDE.md, which merges into user
 * content), so they are overwritten wholesale rather than upserted into.
 *
 * @returns true when the brief is present and current.
 */
export async function ensureOrchestratorBrief(rootPath: string): Promise<boolean> {
  const root = rootPath?.replace(/[\\/]+$/, '');
  if (!root) return false;

  try {
    await writeIfStale(`${root}/${ORCHESTRATOR_BRIEF_PATH}`, buildOrchestratorBriefBody());
  } catch (err) {
    console.error('Failed to write orchestrator brief:', err);
    return false;
  }

  // The skill is Claude Code's discovery surface. A failure here is not fatal —
  // the brief file above is the channel every other agent uses.
  try {
    await writeIfStale(`${root}/${ORCHESTRATOR_SKILL_PATH}`, buildOrchestratorSkill());
  } catch {
    /* best-effort */
  }

  return true;
}
