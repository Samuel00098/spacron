# Blocked/attention reasons come from the raw PTY tail — sanitize them

`attentionReason()` in `services/orchestrator/agent-signals.ts` is the single
source of the text on a "needs input" card. Everything downstream is a copy of
its return value:

`attentionReason` → `AgentTurnOutcome.reason` (agent-turn-watch) →
`ExecutionOutcome.note` → `task.blockedReason` → the completion card
(`AgentNotifications`), the inbox, the task panel and `memory.ts`.

It is handed the **raw terminal buffer**, not a transcript. It used to slice a
±40-char window straight out of that, so a TUI agent's card rendered as
`[38;2;200;200;200;48;2;20;20;20m ...` — CSI colour codes, cursor moves and OSC
window-title strings, with the ESC bytes themselves invisible. It now runs
`stripTerminalOutput` (from `./activity-log`, the same normalizer the transcript
uses) **before** matching and slicing, drops box-drawing glyphs, and falls back
to the last readable *prose* line before the generic sentence.

Rules for anything else that surfaces agent output in the UI:

- Never put a slice of the PTY buffer on screen. `stripTerminalOutput` first.
- For anything longer than a phrase (a chat reply, a report, live output),
  stripping is not enough: a full-screen TUI (Codex, Claude Code) repaints rows
  in place, so the stripped stream is every frame glued together. Read the
  rendered pane with `readAgentScreen` (`services/terminal-screen.ts`) and fall
  back to the stripped stream only when no pane is mounted.
- Match on the stripped text too. Escape sequences sitting inside a phrase are
  exactly what stops it matching — stripping can only widen the match.
- OSC title strings (`ESC ]0;…BEL`) carry status text like
  "Waiting for response… - <task>" and are removed wholesale, so a card whose
  only "phrase" lived in the window title correctly falls back to the generic
  sentence rather than printing the title.

`agent-signals.ts` and `activity-log.ts` are both dependency-free pure modules;
this import does not create a cycle. Both files are CRLF — preserve it.

Related: [[agent-turn-detection]], [[agent-inbox-unread]]
