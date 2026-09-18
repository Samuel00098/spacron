# Orchestrator must never dead-end on a bare acknowledgement

The in-app assistant (orchestrator brain) produced "Absolutely, I'll help you map
out the project…" and then nothing — no `readFiles`, no actions — because the LLM
complied with the JSON schema but delivered only a conversation line. A reply-only
result for a substantive request is a dead end: the app shows it and the turn ends,
so the work the user asked for never happens.

Two layers now stop that, and they must stay in sync:

1. **Brain prompt** (`orchestrator-brain.ts`, `buildSystemPrompt`): the
   "NEVER JUST ACKNOWLEDGE" rule says a bare reply with empty `actions` and no
   `readFiles` is a complete failure, and the PROJECT QUESTIONS rule explicitly
   covers "map out / go through / report on / analyze the project" (auto-read
   `package.json`, README, main entry via `readFiles`, then summarize in `reply`).
2. **Store safety net** (`stores/orchestrator.ts`, `routeWithProjectReads`): on the
   FIRST routing round only (`readRounds === 0`), if the result has no actions, no
   `readFiles`, and the message is not chatter, the store auto-reads
   `pickProjectOverviewFiles` (matched by filename against the built project tree)
   and re-routes once so the model answers from real source. It deliberately does
   NOT fire on later rounds — once the model is reading it is already working.

The helper `isConversationalChatter` must be conservative: short greetings only,
so genuine small talk stays fast and unread.

## Third failure shape: the deferral (2026-09-16)

A subtler sibling later slipped past both layers: "I've inspected the project at
a high level… then I can give you concrete recommendations." Present-perfect
claim + future offer defeated `isPromiseOnlyReply` (which only matches
"I'll / let me" promises), and the evidence gate only fired on broad-review
phrasing. Fix shipped as four synced pieces:

1. `chat-turn.ts::isDeferredCompletionReply` — claims progress, defers the
   deliverable; a deliverable (bullets/code/recommendations) beats deferral
   phrases. Must stay conservative like its sibling.
2. Brain loop (`orchestrator-brain.ts`): the evidence gate now fires for ANY
   `isDirectAdviceOnlyRequest` FINAL with zero successful read-tool results,
   and a dedicated one-shot deferral recovery pass auto-continues the turn
   ("the turn does not end while requested work remains").
3. Store nets (`stores/orchestrator.ts`): round-0 auto-read and the
   honest-failure conversion both match deferral replies too.
4. Prompt contract: COMPLETION CONTRACT line in `buildSystemPrompt` plus the
   native-transport system-prompt suffix in `agent-transport.ts`.

If any layer is edited, re-run `chat-turn.test.ts`, `orchestrator-brain.test.ts`
and the store suite together — the screenshot regression is covered in each.

## Fourth failure shape: the follow-up turn (2026-09-17)

The original screenshot had TWO halves. After the deferral fix shipped, the
first half (canned task-panel reply) returned through a different door: the
TASK_ADVICE_RE fast-path matched any "suggest/recommend" mention and answered
"Can you help me inspect the project…?" from the board before the LLM ran.
And the second half ("okay" → five pre-checked todos) was never about recovery
flags at all: the follow-up turn runs a FRESH `routeOrchestratorRequest`, so
none of the in-turn gates know the prior message asked for review work.

Synced pieces now:

1. TASK_ADVICE_RE is question-shaped only ("what should we do next").
2. `isContinuationOfDirectWork` (brain) lets a short go-ahead inherit
   `isDirectAdviceOnlyRequest` from the USER's own prior conversation turns —
   judged on user turns only, so assistant phrasing cannot manufacture it.
3. The evidence gates, the direct-delegation gate AND the pre-seeded
   read_project snapshot all key off `followUpDirectReview` (= the request OR
   the continuation), not off `trimmed` alone. `BROAD_REVIEW_RE` also matches
   "the project" now.
4. Todos may ride a TOOL round (an intended plan) but never a FINAL with zero
   tool work this turn; the brain strips them and the store refuses to fold a
   checklist into the final card unless `turnEvidence` has an ok result. Phase 4
   no longer force-checks todos without executed tools either.
5. `validateToolCall` coerces stringified args ("80" → 80) instead of rejecting
   the whole round — a failed round used to starve every gate of evidence and
   fail the turn as "no evidence".

If you touch any of these, the two brain tests named above plus the store test
"does not paint a fully checked-off plan" and "applies the read-evidence gate
to a short go-ahead" are the regression net.