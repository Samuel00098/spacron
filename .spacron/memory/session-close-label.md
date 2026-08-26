# Closing a terminal names it from a snapshot, not from state

`killSession` (`src/lib/stores/terminal.ts`) removes the session from its project
state **synchronously**, and only then closes the pty. The pty's exit event lands
afterwards, so by the time `handlePtyExit` runs to build the "… closed" toast the
session is already gone from `getProjectState(...).sessions` — `find` returns
`undefined` every single time a close is user-initiated.

The old fallback was `` `Terminal ${id}` ``. **`id` is the pty manager's
process-wide counter**, not the per-project number the tab shows, so closing the
first terminal of your tenth project of the session announced "Terminal 31 closed"
while the tab said "Terminal 1".

Fix: `closingSessionLabels`, a `Map<number, string>` populated in `killSession`
from `getSessionLabel(closing, siblings)` *before* the session is dropped, read
and deleted in `handlePtyExit`, and cleared in `killAllSessions`. The last-resort
fallback is a bare `'Terminal'` — never a number, because any number that isn't
the per-project one is worse than none.

Rules for anyone touching this area:

- **Never name a session from `id` in user-facing text.** Session ids are global
  and monotonic; terminal numbers are per-project and reused. They only coincide
  in the first project of a fresh session, which is exactly why the bug survived.
- Anything that needs a session's identity *after* teardown must snapshot it
  before the state removal, not look it up after.
- `killSession` is the only place that removes a session from `state.sessions`
  (the exit path merely flips `isRunning`), so it is the only place that needs
  the snapshot.

**Severity rides on the same map (2026-08-24):** `handlePtyExit` now takes its
close-vs-death classification from `closingSessionLabels.delete(id)`'s boolean
return — true means `killSession` ran first, i.e. the user closed the terminal.
That matters because a killed pty often reports a *non-zero* exit code (Windows
ConPTY especially), so classifying by code alone turned every deliberate close
into a red "process died" / "exited with errors" toast. Current contract:

- user-closed (label was in the map) → info `${label} closed`, shells **and**
  untracked agents, whatever the exit code;
- self-exited shell → clean = info "closed", non-clean = error "process died";
- self-exited untracked agent → clean = success "finished its work", non-clean =
  error "exited with errors".

Deliberately left alone: when the user closes an agent mid-run,
`playNudge(clean ? 'done' : 'failed')` still plays the failed chime (the nudge is
a sound, not the window notification the fix targeted). Revisit if it annoys.

Regression tests live in the `close notifications` describe of
`terminal.test.ts`: kill-then-exit-1 must be info "Terminal 1 closed"; exit-137
with no kill must stay an error.

Testing: the pty mock in `terminal.test.ts` used to drop `opts.onExit` on the
floor, so no test could ever reach `handlePtyExit`. It now records it, and
`firePtyExit(id, code)` raises the exit by hand. A regression test has to burn a
pty id in a throwaway project first — otherwise the global counter and the
per-project number both read 1 and the bug hides.

Known adjacent issue, deliberately left alone: the `Terminal N` fallback title at
`registerPtySession` is `shellCount + 1`, so with Terminals 1-3 open, closing #1
and opening a new one yields a **second** "Terminal 3". Lowest-free numbering
would fix it but contradicts the existing test
`'frees the terminal number again once an agent reverts to a shell'`, which
asserts count-based numbering on purpose. Needs a product call before changing.

Related: [[agent-inbox-unread]]
