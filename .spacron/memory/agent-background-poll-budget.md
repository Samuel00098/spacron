# What one running agent costs in the background

Every open agent brings a set of always-on poll loops with it, so the cost of
the app at rest is linear in how many agents are running. That is the thing to
check first when "it gets sluggish with several agents open" — before looking at
rendering.

The expensive ones all end in a **git subprocess**. On Windows a spawn plus a
worktree scan is tens of milliseconds, so a handful of agents polling every few
seconds is a continuous share of a core, taken from the machine those agents are
compiling on:

- `workspace_git_worktree_status` — two spawns (`status --porcelain`,
  `rev-parse`) per call. Behind `AgentWorktreeBadge`.
- `workspace_git_worktree_diff_stat` — the Fleet cards' `+N -N`.
- `workspace_git_worktree_delta` — `worktree-reconciler`, 4 s, every tracked
  worktree, and it drives auto-staging so it must keep running in the background.

## Rules for anything that polls per agent

1. **Go through `worktree-status-poll.ts`, don't start another timer.** It
   deduplicates by worktree path, serialises so N agents never spawn N git
   processes into one instant, and stops entirely while `document.hidden`.
2. **Gate on agent activity, not on the clock.** A worktree cannot change while
   its agent is printing nothing, so an idle agent should cost nothing. Pass
   `getSessionOutputProduced(sessionId)` as the probe.

   **One deliberate exception: the Fleet's `diff_stat` poll.** Per-agent file
   attribution (`agent-file-attribution.ts`) is a fold over *consecutive*
   readings, so skipping a reading merges two intervals into one — an edit the
   user made while every agent was idle then lands in the same interval as the
   next agent's work and is credited to that agent. That poll is gated by the
   panel being open and visible instead, and its reads are serialised. Do not
   "optimise" it back.
3. **Never use `getSessionOutputLength` to detect activity over a long window.**
   It is the length of the *retained* buffer, which is capped
   (`MAX_SESSION_BUFFER_CHARS`) — after a couple of minutes of a working agent it
   stops rising and every length-based growth check goes silently blind. This
   already cost the turn watcher a real bug: it saw a permanently idle session
   and false-completed turns mid-work. `getSessionOutputProduced` is monotonic
   and is what growth checks want.
4. **Read tails, not the whole window.** `getSessionOutputBuffer()` joins the
   whole 250 k window and every append drops the memo, so `.slice(-2000)` on a
   timer rebuilds a quarter-megabyte string per tick per agent. Use
   `getSessionOutputTail` / `getSessionOutputSince`.

Related: [[agent-turn-detection]] [[agent-history-persistence]]
