# Orchestrator: edit small, delegate big (with permission)

Status: implemented 2026-09-19 (all three phases). Builds on `docs/coding-agent-internals-research.md`.

Deviations from the plan below, decided during implementation:
- Voice turns ask out loud and store no proposal, because realtime voice never
  delivers a literal answer (the reason an earlier confirmation hold was removed).
- Addressing a running agent by name ("Backend, run the tests") counts as approval.
- The post-edit check runs once when the turn is about to finish (then once more
  after a fix), not after every edit round: `npm run check` takes about a minute here.
- Steering hands the message to the running turn only when it is steered from
  the queue; plain queued messages still run in order after the turn.
- Undo is the chat word "undo" (no button yet).

## The rule (decided by the user)

- The orchestrator **does small work itself**: reading, searching, and edits or
  new files that touch **at most 3 files** in one task, plus running commands to
  verify.
- Anything that would touch **more than 3 files** is a big change. The
  orchestrator **must not do it on its own**. It stops, explains the scope, and
  **asks the user** whether to delegate, and to which agent: Claude Code, Codex,
  or another local model.
- **No delegation without the user's OK.** This applies to every agent, Claude
  Code and Codex included.

## What already exists (checked in code, not just the notes)

| Capability | Where | State |
|---|---|---|
| Native tool calling, text fallback | `orchestrator/agent-transport.ts` (`nativeTools`) | done |
| Round budget 50, doom-loop guard (3 identical calls) | `DEFAULT_AGENT_BUDGETS`, `brain-tools.ts` `DOOM_LOOP_THRESHOLD` | done |
| read/glob/grep/read_project | `brain-tools.ts`, executor in `stores/orchestrator.ts` | done |
| `write_file`, `edit_file` (exact, unique match, optimistic `expectedContent` check) | `stores/orchestrator.ts:4114`, `:4147` | basic |
| `run_command` sync + background | `stores/orchestrator.ts` | done |
| `update_todos` plan tool, mode profiles (ask/plan strip writes) | `brain-tools.ts` `brainToolProfile` | done |
| Delegation via FINAL `actions` (`spawn`/`send`) | `orchestrator-brain.ts:69` | exists |
| Unsolicited delegation is **stripped** ("direct-first") | `orchestrator-brain.ts:~1947` | conflicts with new rule |
| Chat queue; steering = promote + **stop** the running turn | `stores/orchestrator.ts:3651-3715` | works, but coarse |

So the job is mostly **policy plus a scope gate**, and then **edit quality**.

## Phase 1: Scope gate and ask-to-delegate (the core of the request)

1. **Track mutated files per turn.** In the executor, keep a `Set` of distinct
   repo paths that `write_file` / `edit_file` changed successfully this turn.
   `save_document` (user Documents folder) doesn't count.
2. **Hard gate in the executor, not only in the prompt.** Before any write, if
   the path is new to the set and the set already has 3 files, refuse:
   `error: scope limit — this task would change more than 3 files. Stop editing,
   summarise what's done and what remains, and ask the user whether to delegate
   (ask_question).` Writes to files already in the set are still allowed, so the
   orchestrator can finish fixing its own 3 files.
   - The threshold lives in one constant (`DIRECT_EDIT_FILE_LIMIT = 3`) so it can
     later become a setting.
   - The gate is scoped to the **task, not the turn**. A short follow-up like
     "okay, continue" must not reset the counter. Reuse the existing
     continuation detection (`isContinuationOfDirectWork`) to carry the set
     forward within a thread.
3. **Estimate up front, don't wait for the gate.** Add a prompt rule: after
   reconnaissance, if the plan clearly needs more than 3 files (a new feature,
   module or refactor), do **no** edits. Reply with the scope (files, rough
   steps) and ask via `ask_question`. The gate is only the backstop for bad
   estimates.
4. **The delegation question.** `ask_question` with options built from the real
   agent roster (`list_agents` plus the agents that can be installed or spawned):
   - `Delegate to Claude Code`, `Delegate to Codex`, one option per other
     configured local model, and `Do it yourself anyway` (a user override that
     lifts the gate for this task).
   - Target an already-running agent when one fits, e.g. "Send to Iris (Claude
     Code, idle)".
   - The question includes a drafted hand-off prompt (goal, files, constraints,
     verification command), so the user approves the brief as well as the agent.
5. **Executing the answer.** On the user's choice, the next turn emits the
   `spawn`/`send` action with the drafted brief. Rewrite the direct-first strip
   at `orchestrator-brain.ts:~1947` from "strip unless explicitly requested" to
   **"strip unless explicitly requested OR the user approved a pending delegation
   proposal in this thread."** The proposal is stored as thread state
   (`pendingDelegation: { brief, options, proposedAt }`), so approval is a fact
   the code can check, not something inferred from wording.
6. **Prompt and tool descriptions.** Update `write_file`/`edit_file` descriptions
   and `buildBrainToolsPrompt` to match: "≤3 files: do it; >3: propose delegation
   and ask; never spawn/send without approval". Remove the older conflicting
   lines ("large coding work goes to an agent via spawn/send", and the
   PLAN-AND-DELEGATE text that lets the model spawn a planner by itself).

**Tests** (in `orchestrator-brain.test.ts`, `stores/orchestrator.test.ts`):
- the 4th distinct file is refused while re-editing a 1st–3rd file succeeds;
- the counter survives a continuation turn and resets on a new task;
- an unapproved spawn is stripped, and an approved pending proposal is kept;
- a >3-file request produces an `ask_question` with no writes;
- "Do it yourself anyway" lifts the gate.

## Phase 2: Edit quality (from the research)

1. **Line endings.** Normalize CRLF to LF for matching, then write back in the
   file's original ending (as OpenCode does). On Windows a model's `\n`-only
   `old_string` currently fails against CRLF files.
2. **Fuzzy fallback chain**, tried only after the exact match fails, and always
   requiring a **unique** match: trailing-whitespace-trimmed lines, then
   indentation-flexible, then block-anchor (first and last lines exact, middle
   similar). The tool result says which matcher hit, so a fuzzy apply is visible.
3. **`replace_all`** parameter for renames within a file.
4. **Read-before-edit.** Track which paths the model read this turn; refuse
   `edit_file` and overwriting `write_file` on unread files ("read it first").
   This stops blind overwrites.
5. **Diff in the result and the activity card.** Return a short unified diff so
   the transcript shows what changed. Cap the size.
6. **Post-edit check.** If the project has a fast check configured (e.g.
   `npm run check`, `tsc --noEmit`), run it after the last edit of a round and
   append errors to the tool result ("errors after edit, fix these:"). This is
   the cheap version of OpenCode's LSP diagnostics, and it feeds the existing
   `verificationRecoveryUsed` gate with real evidence.

**Tests:** CRLF round-trip, each fuzzy matcher (including an ambiguous fuzzy
match refusing), `replace_all`, the unread-file refusal, and a diff that doesn't
exceed its size cap.

## Phase 3: Nice to have (not required for the goal)

- **Mid-turn steering without killing the turn** (the Codex model). Drain
  queued messages at the top of each tool round and inject them as user input,
  and don't end the turn while input is pending. Today steering stops the turn
  and restarts it, which throws away in-flight work.
- **Checkpoint per turn** for the orchestrator's own edits (keep pre-edit
  contents, one-click revert), since it now edits code directly.

## Risks and coordination

- `orchestrator-brain.ts`, `chat-turn.ts`, `stores/orchestrator.ts` and their
  tests **already have uncommitted changes from another session** (git status on
  2026-09-19). Implementation must build on those edits, not overwrite them.
  Check `git diff` on those files before starting.
- The existing recovery flags (`directPolicyRecoveryUsed`,
  `claimWriteRecoveryUsed`, …) must keep working. Phase 1 adds one new state
  (`pendingDelegation`), not a widened old flag, per the turn-completion
  contract in `.spacron/memory/orchestrator-tool-calling.md`.
