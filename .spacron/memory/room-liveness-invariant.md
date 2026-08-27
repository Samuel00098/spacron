# A room that is closed has nothing running in it

The Projects panel reports what each project has open, and it was showing
"terminal running" for projects with no terminal on screen. The cause was an
asymmetry in `closeRoom` (`components/layout/AppShell.tsx`):

- closing an `agent:<id>` room **killed** its session, but
- closing the **Terminal** room only set `terminalRoomOpen` to `false` and left
  its shells running.

So a shell could be alive with no window onto it, and the panel — correctly
reading the live session list — reported a process the user could not find.

## The invariant now

**A terminal room's open state and the liveness of its shells move together.**
Closing it kills the non-agent sessions it owns, behind a confirmation, and
cancelling leaves the room *open* rather than hiding it: hiding without killing
is the ghost state this exists to remove. Agent sessions are never touched by it
— they own their own rooms.

## What to keep true

- `closeRoom` is the **only** gate. There is exactly one `setTerminalRoomOpen(false)`
  and one `setDevTerminalRoomOpen(false)` outside project restore; adding another
  re-opens the hole silently, and nothing will fail. Grep before you add one.
- `toggleTerminal` in `stores/zustand/layout.ts` moves the *aux* flags, not
  `terminalRoomOpen`. Keep it that way or it becomes a second close path.
- Project restore (`restoreProjectState`) may still set it false — that is a
  saved arrangement being put back, not a user closing a room, and it must not
  prompt.
- **Reopening the room must make exactly ONE shell.** Killing the shells on close
  is what first made the grid genuinely empty on a reopen, and two things then
  race to fill it: the activity-bar Terminal button (synchronous, checks
  `paneAssignments`) and `TerminalPanel`'s auto-open effect (80ms after mount,
  cannot see an in-flight async creation). Both go through
  `claimStartupShell`, and `closeTerminalRoomForReal` releases the claim so a
  close-then-reopen inside the 5s window does not leave both declining and the
  room empty. Any third opener needs the same claim.
- The confirm dialog uses `useModalFocus`, so it is rendered conditionally and
  never mounted-and-null. See [[modal-open-count-gate]].

Related: [[per-project-persistence]] [[agent-background-poll-budget]]
