# `report_status` — the agent tells us, we stop guessing

Shipped 2026-08-25. The first deterministic turn signal that is not Claude-only,
built after reading how T3 Code (github.com/pingdotgg/t3code) does it.

## The two halves

**1. A tool an agent calls about itself.** `report_status(state, detail)` where
state is `working | needs_input | done | failed` (validated in Rust — the
frontend matches on a closed set). Every other tool in `mcp/mod.rs` acts on some
*other* agent; this one is the caller reporting its own turn. It is advertised
to every MCP-speaking CLI, so unlike the hook sentinel it is not one preset's
privilege.

**2. A credential that says which agent called.** The app-wide MCP token
(`?token=…`, persisted in the config dir) authenticates but identifies nobody —
every agent presents the same string. `McpServerHandle::mint_agent_token()` mints
a per-launch token held only in memory; `authorize()` (renamed from
`reject_unauthorized`, now returning `Result<Caller, Response>`) accepts either
and reports which session the presented token was bound to. **The identity comes
from the token, never from an argument** — an agent could name any session it
liked.

## Where each piece lives

- `src-tauri/src/mcp/mod.rs` — `AgentReport`, `Caller`, `AgentTokens`,
  `authorize`, `tool_report_status`, the `report_status` arm of
  `handle_tool_call`. `Caller` is threaded through `dispatch_message` →
  `handle_tool_call`; adding a tool that needs identity means using that arg.
- `src-tauri/src/commands/mcp.rs` — `mcp_open_agent_channel` /
  `mcp_bind_agent_channel` / `mcp_close_agent_channel`.
- `lib.rs` — `report_fn` emits `mcp:agent-report`.
- `stores/mcpBridge.ts` — `prepareAgentChannel` / `bindAgentChannel`, and
  `handleAgentReport`, which decides between ending a turn and notifying.
- `orchestrator/agent-hook-signals.ts` — `deliverTurnSignal` pushes a report
  into the same listener set the hook sentinels use.

## The three traps already handled — do not undo them

1. **`hasTurnSignalChannel` is not `channels.has(id)`.** `onTurnSignal` now
   creates a listener-only entry for any watched session (a report can arrive
   from a session that never had a hook channel, and the watcher subscribes once
   at the start of the turn). If `hasTurnSignalChannel` returned true for those,
   **every non-hook agent would move from the 90-second idle fallback to the
   15-minute one** — a silent, large regression. It tests `channelId != null`.
2. **A delivered report must not also toast.** `handleAgentReport` returns as
   soon as `deliverTurnSignal` succeeds, because the orchestrator's completion
   card is then the single visual surface. Toasting as well re-creates the
   double-notification the inbox work removed ([[agent-inbox-unread]]).
3. **`working` is not a turn boundary.** It is dropped. An agent pinging
   progress every few minutes must not produce a notification each time.
4. **One reported state, one outcome kind.** `failed` maps to
   `{ kind: 'failed' }`, never to `blocked`. An earlier cut collapsed the two,
   which made an error arrive as "needs your input" and sent the user looking
   for a question nobody asked. See the `via`/three-state section in
   [[agent-turn-detection]].

## Only a declared end may interrupt (2026-08-25, same day)

The rule the whole notification path now enforces:

| Turn ended by | Card / chime / OS notification | Inbox row |
|---|---|---|
| `report_status`, hook sentinel, non-zero exit | yes | yes |
| idle fallback / bell / attention regex → **finished** | **no** | yes |
| attention regex → **blocked**, any **failed** | yes | yes |

`silent = status === 'done' && !declared`, computed identically in
`completeLeasedTask` and `notifyAdoptedTurnEnd`, stored on the completion card,
and read by `AgentNotifications` (which filters silent cards out of the floating
stack *and* the OS-notification loop).

Why: "output stopped growing for 90 seconds" is equally a long compile, a slow
tool call, or an agent sitting at a prompt nobody typed into. Announcing those
as completions is the false "your agent has finished" the user kept getting
while nothing had happened, and it costs the real ones their credibility.
Needs-input and failure still interrupt even when inferred — a missed "needs
input" strands the user waiting on an agent that is waiting on them, and that
asymmetry is deliberate.

**The trade to know:** an agent that never calls `report_status` now finishes
*silently*. That is the intended behaviour, not a bug — but it means the brief
in `agent-rules-file.ts` (rule 5) is load-bearing. If agents stop reporting,
users stop being told anything. Check that rule survives before blaming the
notification code.

## The five things a card may say (2026-08-26)

`CompletionSummary.declared: boolean` became **`endedBy: 'declared' | 'exit' |
'inferred'`**, because a boolean could not tell the difference between a turn
the agent reported and a process that merely stopped:

| endedBy | Card says | Interrupts? | Set by |
|---|---|---|---|
| `declared` | **finished** | yes | `report_status` / hook sentinel |
| `exit` | **exited** | yes | the agent's process ending (adopted path) |
| `inferred` | **went quiet** | **no** | the idle / bell / regex fallback |

plus **needs input** and **failed**, which always interrupt.

`exit` exists because "the process ended" is an observed fact but *not* evidence
the work is done — `/exit`, Ctrl-D and a finished session all exit 0. The
adopted process-exit card used to say "finished" for all three.

Two more false cues fixed in `terminal.ts::handlePtyExit` at the same time:
the completion chime fired even when `wasClosedByUser` (you closed the terminal
and the app chimed "done" at you), and an untracked agent's clean exit toasted
"finished its work" — now "exited", for the same reason as above.

`completionVerb` / `completionHeadline` are exported from `AgentNotifications`
and covered by `completionCopy.test.ts`, including that the corner card and the
OS notification can never word the same event differently.

## The shell channel — how the other ~30 CLIs report (2026-08-26)

`report_status` needs an MCP config, which Spacron writes for eight
executables. The universal fallback is a **file plus a nonce in the agent's
environment**, because running a shell command is the one capability every
coding CLI has:

```
SPACRON_TURN_FILE   -> the append-only file agent_signals.rs already tails
SPACRON_TURN_TOKEN  -> the nonce, which is also the channel id
```

The agent echoes one line when it stops:
`SPACRON-TURN-DONE:<nonce> <sentence>` (also `-NEEDS-INPUT:` and the new
`-TURN-FAILED:`). Rule 5 of the standing brief carries the exact commands.

This reuses the machinery Claude's hooks already use — `parseSignalLine`, the
Rust tailer, `deliverTurnSignal` — so there is one code path, not two.

**Three things that make it safe rather than just convenient:**

1. The nonce lives only in that session's environment, so no other agent (and
   no quoted documentation) can produce a line that ends this turn.
2. A session can now hold **two** channels (`ChannelState.channelIds`) — Claude
   gets the hook and the shell one. Lines are parsed against the nonce they
   arrived on, never the entry's single `channelId`; getting that wrong makes
   the second channel silently dead.
3. `hasTurnSignalChannel` means **guaranteed** (hook only) and gates the
   15-minute idle window. A shell channel sets `guaranteed: false`, because the
   agent may simply forget to echo — treating it as guaranteed would move every
   CLI to the long fallback. `hasAnyTurnSignalChannel` is the separate question
   "did it have a way to speak?", which is what `agentCanReport` uses.

The channel is opened in `createSession` (the env must be complete before the
process starts) and attached right after the PTY exists — the same two-step as
the MCP token, for the same reason.

## Silence is only fair to agents that could have spoken (2026-08-26)

`silent` is **not** just `endedBy === 'inferred'`. It is
`endedBy === 'inferred' && agentCanReport(task.agentPreset)`.

Spacron writes an MCP config for eight executables (claude, codex, gemini,
opencode, droid, cursor, cursor-agent, agent). The preset catalog briefs ~39
CLIs to call `report_status` — so **31 of them are told to report a tool they
do not have**, because `injectMcpConfigForAgent` has no branch for them and
they launch with no Spacron tools at all.

Withholding the card from those would mean they finish and the user is told
nothing, ever — the opposite failure from the false "finished" the rule exists
to stop. So: an agent that *could* report and didn't gets silence (its silence
is information); an agent with no channel still gets a card, worded "went
quiet". A guess honestly labelled as a guess beats nothing.

`agent-capabilities.ts` owns the list, as a leaf module both `mcpBridge`
(writes the configs) and `stores/orchestrator` (decides what interrupts) can
import without a cycle. **`agent-capabilities.test.ts` parses the `switch` in
`injectMcpConfigForAgent` and asserts the two agree** — a CLI added there and
forgotten here would be briefed to report and then silenced for not reporting.

The real fix for those 31 is an MCP config surface per CLI. Until then, that
diff is the honest coverage boundary of this whole feature.

## Every agent, not just Claude (same day)

The Claude-only limit below is closed. The per-launch token is now ALSO written
into the agent's PTY environment as `SPACRON_AGENT_TOKEN` (`stores/terminal.ts`,
minted before the env is built, bound right after the PTY exists), and
`report_status` takes an optional `agent_token` argument matched against the
minted set. Attribution order in the Rust handler:

1. the token presented **on the connection** (proof; Claude Code via
   `--mcp-config`),
2. the `agent_token` **argument** (a shared secret only that agent's process
   tree could read — weaker than transport auth, but a real boundary, and the
   difference between one CLI working and all of them),
3. neither → unattributed: shown, but cannot end a turn.

The connection token deliberately outranks a claimed one, so an agent cannot
report as somebody else by passing their token. `mcpBridge` keeps
`channelsBySession` so the env var and the `--mcp-config` URL carry the SAME
token for one agent rather than two.

## What the inbox row says

`completionBody()` (inbox.ts) never returns an empty string. Order: AI summary →
what the agent said (`report_status` detail / blocked prompt / failure) →
a sentence stating the outcome. A `finished` outcome now carries `detail`
through `HookSignal` → `AgentTurnOutcome` → `describeTurnEnd` → the card's
`reason`, which is what it took to stop the inbox rendering a name and a title
with no message under them.

## Historical: the coverage limit this shipped with

**Superseded by the env-token section above — kept for the reasoning.** The
per-launch token can only ride a config surface that is itself per-launch, and
`--mcp-config` is the only one we have: codex/gemini/opencode/cursor/droid
discover the server from a shared config file, so they present the app-wide
token and their reports arrive with `sessionId: null`. Those still notify —
`handleAgentReport` shows them unattributed — but they cannot *end a turn*,
because there is no way to know whose turn it was.

Widening it means giving those CLIs a per-launch config of their own. Codex is
the tractable one: `agent_accounts.rs` already builds a per-account `CODEX_HOME`,
so a per-launch home is the same trick. Do **not** "fix" this by writing a
per-launch token into the shared config file just before spawning — an agent
that re-reads its config later would then present another agent's token, and a
misattributed report is worse than an unattributed one.

Related: [[agent-turn-detection]]
[[blocked-reason-is-raw-pty]], [[agent-inbox-unread]]
