# Where an agent's turn end is reported

[[agent-turn-detection]] covers how a turn end is *detected*. This is what
happens next: getting it back to the conversation that asked for the work.

## One watcher owns a session

`chatTurnWatchers` and `dispatchTurnWatchers` (stores/orchestrator.ts) are the
registry, both keyed by **session id**. `watchDispatchedAgentTurn` stands down
when either already holds that session, and returns early for an `adopted` task
because `watchAdoptedAgentTurns` re-arms forever. That is deliberate — two
watchers on one session report the same turn end twice — but it means a
**leaked entry silently disables reporting**: the agent then looks permanently
silent, with no error anywhere.

Tests reuse a handful of session ids (42 is `spawnAgentPreset`'s default), so a
watcher left armed by one case kills the next one's agent. That failure appears
only in a full-file run, never when the test is run alone with `-t`. Both maps
are cleared in `resetOrchestratorCachesForTests` for exactly this reason; add
any new per-session watcher map there too.

## Blocked keeps the lease; finished releases it

A turn that ends `blocked` must NOT go through `completeLeasedTask`. That
releases the terminal lease and nulls `assignedSessionId`, so the user's answer
re-leases a **fresh CLI** that never saw the question, while the one actually
holding it sits at its prompt with all the context. `reportAgentNeedsInput`
marks the task blocked *in place* instead, and the answer types back into the
same REPL.

The spawn path (`sendGoalToLeasedTask` → `completeLeasedTask`) still does
release on blocked, so a first-turn question resumes into a fresh CLI. That
asymmetry is real and unfixed — check which path you are on before assuming a
blocked task still owns its terminal.

An **adopted** task is the other exception: never change its status. Its
watcher's `shouldContinue` is `leasedSessionLive`, which requires
`in-progress`, so marking it blocked kills the permanent watcher.

## What routes a reply back to a CLI

The `taskId` on a `ChatInlineRequest`. The agent-relay branch of
`sendChatMessage` sends a reply to a card carrying one into that agent's REPL
instead of starting an orchestrator turn — `answeringAgentRequest` is what
makes this work in a plain orchestrator thread, not only in chat mode.

Related: [[agent-turn-detection]] [[agent-report-status]] [[blocked-reason-is-raw-pty]]
