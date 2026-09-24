# Room edge lights run only while the room's session works

The traveling edge light (the conic-gradient rim on panels, `global.css` "The
traveling edge light" section) is **paused on room panels by default** and runs
only when the room carries the `is-working` class:

- `.app-shell .room-panel::after { animation-play-state: paused; }`
- `.app-shell .room-panel.is-working::after { animation-play-state: running; }`
- `is-working` is set in `AppShell.tsx` `renderRoomFrame()` from the room's
  `TerminalSessionInfo.isExecuting` flag. Agent rooms use their agent session;
  the normal and dev terminal rooms use any running non-agent session they own.
  Output reactivates the flag after a quiet spell, so this applies equally to
  every agent CLI and ordinary terminal commands.

Rationale: motion that carries no information reads as alive for ten minutes
and as an itch after an hour. The light now means "a session is working here".
The always-on base ring is what makes a paused light still read as a border —
the same property that lets the ring survive `prefers-reduced-motion`.

Every other surface that gets the edge light (utility drawers, dock, prompt
bar, usage/inbox/resource popovers) keeps its ambient lap — only room
panels, the surfaces where work happens, are gated.

If you add a new "working" signal (e.g. mobile streaming), gate it through the
same `is-working` class rather than a new one.
