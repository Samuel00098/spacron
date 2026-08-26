# Agent turn detection (orchestrator)

How Spacron decides an agent CLI has ended its turn, and the footguns in that path.

## The detection architecture
- `watchLeasedAgentTurn` (src/lib/services/orchestrator/agent-turn-watch.ts) is the
  single funnel every leased/adopted/adapter-driven agent goes through.
- Signal preference: (0) hook sentinel → (1) bell corroborated by quiescence →
  (2) attention prompt in `recent` tail → (3) idle fallback.
- **Only `claude` / `claude-code` are hook-capable** (`HOOK_CAPABLE` in
  agent-hook-signals.ts). Every other CLI in the ~37-entry preset catalog
  (runs.ts: `AI_AGENT_PRESETS`) — Codex, Gemini, OpenCode, Aider, Cline, … — is
  driven entirely by heuristics. There is NO per-CLI timing tuning: all non-hook
  agents share one config (idleMs=90s, minWorkChars=500, tailChars=2KB, idle
  rescan 8KB). But they DO get **per-CLI attention phrases** (see below).

## Per-CLI attention prompts (2026-08-24 fix)
- The old failure: `AGENT_ATTENTION_PATTERN` was ONE generic English phrase
  list, so any CLI phrasing its "needs input" gate outside it (e.g. Codex's
  "Send?") was misreported "finished" — a silent miss, not a false alarm.
- Fix: `agentAttentionPhrases(command)` (agent-rules-file.ts) returns a
  CLI-specific phrase list keyed by executable (codex/gemini/opencode/aider/
  claude + alias keys). The watcher resolves it from `opts.agentCommand`
  (threaded through `watchTurn` at all 3 call sites in orchestrator.ts) and
  layers it onto the matcher in `containsAttentionRequest`/`attentionReason`.
- The universal `AGENT_ATTENTION_PATTERN` was ALSO broadened with structural
  cues every CLI shares: `(y/N)`, `y/N`, `awaiting approval`, `paused`,
  `confirm?`, `approve?`, `is this ok?`. These live in
  `UNIVERSAL_ATTENTION_PATTERN` so they apply even with no per-CLI command.
- Phrases are literal substrings (regex-escaped), keyed by executable so
  `npx opencode`, `codex.cmd` etc. all resolve. Unknown CLIs get `[]` and rely
  on the universal pattern. Conservative by design — a loose phrase here causes
  the opposite bug (working agent misreported "blocked").
- Caveat: still English-centric. A CLI prompting in another language, or with a
  phrasing no entry covers, is still missed — but now it's additive per CLI
  rather than a single global list, so coverage grows without touching the
  watcher.

## Bell heuristic is no longer instant (2026-08-24 hardening)
- A terminal BEL (`\x07`) alone does NOT end a turn. It used to: a mid-turn ring
  (progress TUI, "press enter", OSC title terminator) false-completed the turn
  instantly, releasing the lease and discarding the agent's real answer.
- Now a bell only corroborates a finish: after the ring, output must stay quiet
  for `BELL_FINISH_GRACE_MS` (2.5s) before the turn resolves. A genuine end-bell
  is followed by silence; a mid-turn bell is followed by more output, so it
  never reaches the quiet state. Implemented via `lastBellAt` + `lastGrowthAt`.
- Hook agents (`signalled`) skip the bell path entirely — the sentinel channel wins.

## Other known footguns (non-hook CLIs)
- **Quiet/verbose asymmetry**: single 90s idle window. A verbose CLI pausing 2min
  compiling can be false-completed; a terse CLI relies on the 10min quiet backstop.
- The idle fallback for signalled agents is demoted to 15min (SIGNALLED_IDLE_MS) so
  a silent hook failure doesn't false-complete during normal long tool calls.

## Related
- [[terminal-lease]] — `leaseOrchestratorTerminal` installs hooks before launch.
- [[agent-notification-ping]] — the corner-card / OS-notification gating on visibility.
- [[reviewer-verdict-signals]] — same nonce-sentinel trust model, for reviewer verdicts.

## 2026-08-25: three states, and `via` (declared vs inferred)

`AgentTurnOutcome` gained a **third** reportable kind and a provenance field:

```ts
| { kind: 'finished'; via: TurnEndSource }
| { kind: 'blocked'; reason: string; via: TurnEndSource }
| { kind: 'failed';  reason: string; via: TurnEndSource }   // new
| { kind: 'aborted' }
```

**Why `failed` had to exist.** Failure used to be derived from the exit code
alone, so it could only be seen when the process died. A CLI agent sits in a
REPL: it hits an error it cannot get past, says so, and returns to its prompt —
alive, exiting 0 later. That was classified `complete` and announced as "Agent
finished". The process-exit path also built a *`blocked`* outcome for a non-zero
exit, so a crash was announced as "needs your input". Both are fixed;
`ExecutionOutcome.failed` carries a declared failure past the exit-code check,
and it outranks `needsHumanInput` (different questions — "did it work" vs "is it
waiting").

**Why `via`.** A turn ends either because the agent said so (hook sentinel, or a
`report_status` call — see [[agent-report-status]]) or because we guessed from
the screen. The idle fallback fires on a long compile exactly as readily as on a
real completion, so a card that says "finished" on that evidence is a claim we
cannot back. `via: 'inferred'` now words it as **"went quiet"** instead.
`describeTurnEnd(outcome)` in agent-turn-watch.ts is the single mapping to
`{ status, reason, declared }` — both the leased and adopted paths go through it,
because they previously carried their own ternaries and that is exactly how the
two paths disagreed about what a crash was.

Three places read `declared`: the corner card verb, the OS notification
headline, and the voice line (which says "seems to have finished" — "went quiet"
sounds evasive out loud). Completion cards are also **grouped by it**, so one
real finish can't label two guesses as "3 agents finished".

Note the asymmetry in `completeLeasedTask`: only a `done` card inherits the
doubt. A task the exit code turned `failed` is an observed fact, so it stays
`declared: true` whatever the watcher thought.
