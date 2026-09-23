# Handing work over when an agent runs out of usage

What the code cannot tell you by itself: the *invariants* this feature spans,
and the two traps that are not visible from any one file.

Plan: `docs/agent-failover-plan.md`. Pure logic:
`services/orchestrator/agent-failover.ts` (the ladder) and `agent-handover.ts`
(the words). Side effects live in `stores/orchestrator.ts`.

## The invariants no single file owns

**One branch, one agent, one review.** Every hop reuses the same task, the same
worktree and the same branch, so three agents' work accumulates on *one* branch
and the user reviews once at the end. This is why `runHandover` kills the old
session *before* launching the successor, and why nothing in the handover path
stages into the main checkout. Anything that starts a second agent on a live
worktree breaks both halves at once.

**Freezing is not staging.** `snapshotWorktree` (a snapshot-only Tauri command,
`workspace_git_snapshot_worktree`) commits loose edits onto the agent's own
branch and stops. It deliberately is *not* `stageWorktreeChanges`, which goes on
to apply the delta into the user's checkout — auto-staging is off by default and
freezing work is not a reason to push it past the review wall.

**Two agreeing signals, always.** A limit phrase in the transcript is never
enough on its own, and neither is the meter. `watchLeasedAgentTurn` only returns
`limited` when both agree. This is the same rule [[agent-turn-detection]]
records for bells, and for the same reason: a false positive throws away a
half-built feature.

**`transitionTask` has no in-progress → in-progress edge.** A handover patches
the task back to `todo` directly before relaunching. Do not "fix" the transition
table to allow the self-edge — a relaunch is a fresh start of the same task, not
a state it can sit in twice.

## Traps

**A managed Claude account on macOS is not a second login.** The login Keychain
holds one item per CLI, so relocating `CLAUDE_CONFIG_DIR` moves settings but not
the credential. Rust reports this as `distinctLogin: false` and the ladder skips
those accounts — without that check, a "handover" hops into the same account
that just ran out, under a different name. This cannot be reproduced on Windows
or Linux, where the credential is a file inside the config dir.

**Do not add a poller.** The failover watch subscribes to the meter's existing
30s reading (`usageState`) and only fetches the per-account roster while at
least one leased agent is running. See [[agent-background-poll-budget]] for why
anything per-agent has to justify itself.

**`\b` does not survive this repo's shell tooling.** Writing a regex containing
`\b` through a heredoc leaves literal 0x08 bytes in the file; the pattern then
silently never matches and every test that depends on it fails in a way that
looks like a logic bug. `AGENT_LIMIT_PATTERN` was written twice for this reason.

## Wording rules the cards inherit

Only a *declared* turn end may use the word "finished" ([[agent-turn-detection]],
[[agent-report-status]]). The migration chain has to keep that **per hop**:
`describeMigrationChain` describes each agent by what was observed — headroom
left, files on the branch, whether it stopped when asked or was interrupted —
and never claims an earlier agent finished anything. A test asserts the strings
"finished" and "completed" never appear in it.

## Still open

Settled by a default rather than by the user, and worth revisiting:

- One threshold for every window type (3% of a weekly budget is far more work
  than 3% of a 5-hour one), and *any* exhausted window triggers, not only the
  binding one.
- Non-reporting CLIs are hard-excluded from automatic failover — only the eight
  in `MCP_CONFIGURABLE_EXECUTABLES` are candidates.
- No hand-back when the original account's limit resets. The reset time is in
  hand, so this is scheduling, not new detection.
- A successor that fails for non-limit reasons does not re-enter the ladder.
