# Orchestrator tool-calling loop

The brain (`orchestrator-brain.ts`) offers tools (`orchestrator/brain-tools.ts`)
in the system prompt and loops FINAL vs `tool_calls` through plain-text
`ai_complete` — no per-provider native `tools` param in `run_completion`.
The executor lives in `stores/orchestrator.ts` (`toolExecutor`: read_file,
list_terminals, list_agents, get_agent_output, ask_user) so the brain stays
free of store imports. Bounded at 4 tool rounds; without an executor,
`read_file` falls back to the legacy `readFiles` round-trip.

See also [[orchestrator-bare-ack-net]] (the ack guard the loop extends) and
[[model-request-param-dialects]] (why native tools were deferred).

## Turn-completion contract (2026-09-16)

The loop's recovery passes are single-use flags, each with its own trigger:
`protocolRecoveryUsed` (non-JSON response), `directPolicyRecoveryUsed`
(delegation despite direct-first, or unevidenced advice FINAL),
`promiseRecoveryUsed` (bare ack), `deferredRecoveryUsed` ("then I can…"
deferrals — see [[orchestrator-bare-ack-net]]), `claimWriteRecoveryUsed`
(claims a file that no write produced), `verificationRecoveryUsed` (edited files
with no verification after). Adding a new failure shape means a new flag, not
widening an old one, or two failures of different shapes in one turn starve each
other's recovery.

Observational callback the store owns: `onToolRound` (per-round evidence + live
progress line). It must never affect routing — wrap and swallow. `turnEndedAt`
on the chat thread marks a checkpoint as conversation memory rather than
interrupted work; `hasResumableTurn` refuses to offer resume when it is set, a
turn is live, or the thread needs input. (`onPlanSignal` and the
narration-derived plan card it fed were removed — see "One plan surface".)

## update_todos: plan state is a tool, not text (2026-09-17)

Plan state moved from model-attached `todos` arrays to a real tool
(`update_todos`, Gemini's 5-state model: `[ ]` pending, `[~]` in_progress,
`[x]` completed, `[!]` blocked, `[-]` cancelled). Invariants that keep the
fake "5/5 done" card impossible:

- Model-declared statuses are authoritative and never overwritten by the
  runtime; only legacy status-less items are derived from evidence
  (`todoIsDone(status, fallback)` everywhere, never `done = true`).
- `update_todos` is plan evidence, NOT work evidence. Phase 4 folds the
  checklist into the final card when work tools ran (`workEvidence`), or when
  plan state exists AND is not all-self-declared-done (a partial plan is
  honest; a lazy all-`[x]` call with zero work is the fake card through the
  new tool and is dropped).
- `advanceTodoItems` must never verb/semantically match `update_todos` results
  (no `TOOL_ACTION_LABELS` entry; `matchesToolSemantic` ignores it).
- Profiles: `PLAN_TOOL` is in every mode incl. ask/plan (report §15 —
  capability profiles physically strip mutating tools via `brainToolProfile`,
  `nativeTools(allowed)`, and profiled `profiledCalls` in the brain).
- The executor path skips the activity card for `update_todos` (it renders in
  the live ticker, not the transcript).
- Broad direct reviews treat the bootstrap `read_project` snapshot as
  reconnaissance only: before accepting a final, the loop requires successful
  `update_todos` plan evidence and at least one later targeted read/search.
- Tests that fake the brain must fire `ctx.onToolRound` like the real loop
  does, or Phase 4 sees no evidence.

## Authoritative plan contract (2026-09-18)

The FIRST `update_todos` of a turn is the plan of record; every later call must
re-state it. Two mechanisms share one definition of "the same row"
(`todoRowMatcher` in `chat-turn.ts`), so they must be changed together:

- `mergeTodoItems` reconciles matched rows in place, then PAIRS unmatched
  incoming rows with the open rows the call omitted (`pairedReplacements`: only
  when the call introduces no more new rows than it dropped, i.e. it reads as a
  re-statement, not an expansion). Only the surplus is appended — this is what
  stops a retelling in unmatched words from appending near-duplicates.
- `findOmittedPlanItems` reports the omissions nothing stood in for, and the
  store sends that back ONCE (`planResendRequested`) asking for the complete
  list. The second offense falls through to the sticky merge, so a stubborn
  model costs a round but can never deadlock the turn.

### One plan surface (2026-09-18)

The turn's plan has exactly ONE surface: the live ticker above the composer,
own by `update_todos`. The old `onPlanSignal` hook fed a second, narration-derived
`type: 'plan'` card (prose + one row per requested tool call) into Work details
via `planSignalText`/`planCardTitle`/`describeBrainToolCall`. All of that is
deleted from the brain, the store, and `chat-turn.ts`, so nothing new writes a
plan card. Do not re-add a producer for it: a second copy of the plan disagreed
with the ticker, and its rows were one of the sources of the near-duplicate
retellings.

Even the render path is gone now: `'plan'` is out of `ChatMessageType`, the
`ChatModePanel` branch and `ActivityDisclosure`'s `plan` prop are deleted, and
the thread sanitiser drops `type: 'plan'` rows on load and on persist (a
null-then-filter, so surviving messages keep their index for id fallbacks), so
pre-change transcripts lose the card instead of rendering one nothing can
reproduce.

### Ceiling (2026-09-18)

`MAX_PLAN_ITEMS = 12` replaced the old 6-row `MAX_TICKER_ITEMS` cap. That cap
silently truncated planned work AND hid the failed reword matches behind its own
truncation (the old "24-item bug" test only passed because of it), so raising
it requires the pairing above. Ceiling relief now recycles finished rows only;
a refused addition is reported through `truncated`, never swapped in for a
pending row.

## Verification gate (2026-09-18)

A turn that changed a project file must run a verification command AFTERWARDS
before its FINAL is accepted. One predicate serves both sides —
`hasUnverifiedMutation` in `chat-turn.ts` — with the gate in the brain and the
VERIFY BEFORE FINISHING prompt rule backing it. Three deliberate asymmetries
that look like bugs and are not:

- `save_document` is NOT a gating mutation. It lands in the user's Documents
  folder, which no test, typecheck or build can say anything about, so gating it
  would cost a pointless round every time the user asks for a written-up answer.
  The two sets of "mutating tools" therefore differ on purpose: the gate uses
  `CODE_MUTATING_TOOL_NAMES`, evidence uses `MUTATING_TOOL_NAMES`.
- A FAILING verification counts as verification. The gate exists to make a
  command run, not to demand that it pass; a red run is the finding to report.
- A command that ran before the last write does not count (it cannot have
  covered the change), and neither does one that only looked (`git status`,
  `cat`). Matching is on command vocabulary, so `checkout` must not read as
  `check`.

One shot, and that is load-bearing twice over: a command that times out never
prints its own text (the status line is `TIMEOUT after Ns`, with no command), and
a project with no test command can never satisfy the gate — so the pass must be
able to end with the model SAYING there is nothing to verify rather than
looping.

## Finished-turn report (2026-09-18)

`composeTurnReply(reply, summary, todos, results)` owns the finished card. A turn
that changed files or ran a command (`isReportableTurn`) renders the structured
`CompletionReport` INSTEAD of the `formatTurnSummary` one-liner, and falls back
to that line when the report renders empty, so a read-only turn is unchanged.
Three rules that only make sense together:

- A section the model headed itself (`### X` or `**X**`) is skipped, so the card
  never carries two "What is working" blocks. The Verification section is
  runtime-owned but still respects a heading, so the model's prose and the
  measured result appear side by side rather than twice.
- `improvements` stays `[]` on purpose. Suggestions are judgement, not tool
  output; the model's own reply is the only honest source, and a generated list
  here would read as evidence.
- Completed plan items are listed only when no write landed, because the ticker
  checklist is rendered beside the report and the two would otherwise repeat
  each other line for line.

The store passes `turnEvidence` as that fourth argument: the report must be built
from the same results the summary and the plan closure use, or the card and the
phase-4 evidence disagree.
