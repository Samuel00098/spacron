# Spacron Agent Loops — Design

## The Goal

Open a CLI agent in a Spacron pane — Claude Code, Codex, Gemini, Cursor, whichever the
user prefers — give it one task (typed, or by voice through the floating bar), and let it
**run the whole job**:

1. spin up two or three worker agents in the app,
2. wait for them to finish,
3. review what they produced,
4. send back what isn't right, pointing at the specific problems,
5. repeat until everything checks out,
6. report back to the user — done, here's what changed.

The user directs and approves. They are not the message bus and not the reviewer.

## The architecture: Spacron is the tool provider, not the loop

**The orchestrator is itself a CLI agent** — a process in a terminal pane, with its own
agentic loop, its own shell and file tools, its own judgment. It is not the app's built-in
brain (`orchestrator-brain.ts`), and the app does not drive the iteration.

That division is the whole design:

| Owner | Responsibility |
|---|---|
| **The orchestrator agent** (any CLI agent, in a pane) | Decompose the task · dispatch workers · decide when work is good · iterate · report |
| **Spacron** | Expose *reliable tools* for reaching other agents, and *truthful state* about what they're doing |

Everything Spacron needs to build is on the second row. There is no `ReviewCycle` record,
no polling driver, no app-side round counter — the agent already does iteration. It just
needs to be able to see and reach the other agents.

### Orchestrator is a role, not an agent type

Nothing distinguishes an orchestrator from a worker except the prompt it was given. The
MCP registry doesn't type them, any registered agent can call the tools, and any can be a
target. **Don't add an "orchestrator" flag** — mixed fleets (a Codex orchestrating Claude
Code workers, or the reverse) are a first-class case, not an edge case, and they're a real
differentiator for a BYO-key multi-vendor app.

Claude Code appears throughout this doc as the worked example because its MCP discovery is
wired and its tool loop is strong. It is not a requirement.

### What "any agent" actually costs

Three things vary by preset, and the design has to surface them rather than pretend
they're uniform:

**1. MCP discovery is uneven.** Per [[mcp-architecture]]: Claude Code (env var), Codex
(`~/.codex/config.toml`), Cursor (`.cursor/mcp.json`) and Aider (env var) are wired; Gemini
CLI is TBD; everything else falls back to a generic `SPACRON_MCP_URL` env var that an agent
only benefits from **if it happens to read that variable** — which most won't. So the real
gate on "can this agent orchestrate" is: has someone wired its discovery mechanism? That
matrix is the feature, and it should be visible in the UI rather than discovered by an
agent silently having no tools.

**2. Turn signals degrade per agent** — see the `wait_for_agent` gap below. Hook sentinels
are exact but not universally supported; without them the app is inferring from bells and
idle time. An orchestrator needs to know which it's getting.

**3. Loop quality differs.** This design puts the entire loop — decompose, dispatch, wait,
review, bounce, terminate — inside the orchestrator's own reasoning. A weaker or cheaper
CLI may not reliably hold three workers' state, poll patiently, or resist declaring victory
early. The app shouldn't *prevent* any agent from orchestrating, but the canned
orchestrator prompt (step 6) should be tuned per preset, and the docs should be honest
about which agents have actually been driven through a full loop.

> Earlier drafts of this doc designed an app-side loop (a peer Builder↔Reviewer cycle, then
> an orchestrator-brain evaluator). Both were the wrong layer. Kept as
> [Appendix A](#appendix-a-the-peer-builder--reviewer-path) only because the peer path
> ships today and has a live bug.

---

## What already works

The agent-to-agent plumbing is built: an in-process **Rust MCP server** (HTTP+SSE,
JSON-RPC 2.0) at [`src-tauri/src/mcp/mod.rs`](../src-tauri/src/mcp/mod.rs), bound to
`127.0.0.1` on a random port with a `?token=` shared secret. See [[mcp-architecture]].

| Tool | What it does |
|---|---|
| `delegate_task(preset, prompt, files?, name?)` | Spawns a worker **and waits for its report** — one call per round |
| `bounce_task(handle, feedback)` | Sends a worker back for another round and waits; clears the stale report first |
| `check_task(handle)` | Resumes waiting on a worker that came back `working` |
| `spawn_agent(preset, prompt?, name?)` | Fire-and-forget launch, for driving a worker yourself |
| `list_agents()` | Registered agents — name, preset, label, session id, `branch` |
| `send_to_agent(name, message)` | Writes text straight into that agent's PTY |
| `read_agent_output(name)` | Reads its recent terminal output |

### Why the top three exist: out-compete the in-harness path, don't block it

An agent reaches for its own in-process sub-agents because that is **one call that returns
a result**. A raw spawn/poll/read/send protocol is a chore, so the model takes the easy
road — which is why sub-agents kept running invisibly instead of appearing as panes.

`delegate_task` closes that ergonomics gap: one call, one result, same shape as a native
sub-agent, but the worker is a real pane on its own branch that the user can watch and
steer. The brief then only has to say which tool is better for which work, instead of
fighting the agent.

**A `PreToolUse` hook denying the native tool was considered and rejected.** It couples
Spacron to another vendor's tool names and settings file, it writes behaviour changes into
a file the user also uses outside Spacron, it has no Codex equivalent (so it would make
Codex second-class by construction) — and the conditional version cannot be built at all,
since deciding "will this prompt write code?" from a prompt string is an LLM judgment, not
something a hook can do deterministically.

The division that ships instead: **read-only research → in-harness sub-agents; work that
writes code → panes.**

Config is injected per preset by [`mcpBridge.ts`](../src/lib/stores/mcpBridge.ts)
(`injectMcpConfigForAgent`), so Claude Code, Codex, Cursor and Aider discover the server
on launch. The orchestrator also has its own Bash, so it can `git diff` and run tests
itself.

**This means the loop is already possible today**, with nothing but a good prompt.

### Test it before building anything — once per preset

Spawn an agent in Spacron and ask it to run `list_agents`. **Repeat for every preset you
intend to allow as an orchestrator**, because each uses a different discovery mechanism and
they fail independently.

If it can't see the tool, everything below is moot until that's fixed — and the failure is
**silent**. `terminal.ts` injects `CLAUDE_CODE__MCP__SERVERS` for Claude Code; if that isn't
a config surface it actually reads, the agent boots with no Spacron tools and simply never
mentions it. The same question applies to Codex's `config.toml` block, Cursor's
`.cursor/mcp.json`, and Aider's env var. `getMcpUrl`'s own comment warns about this class of
failure: a URL missing its token "authenticates as nobody and the agent silently loses every
cross-agent tool."

The result of that sweep is the orchestrator-capability matrix — worth recording in
[[mcp-architecture]] rather than rediscovering.

---

## What's missing

Ranked by what breaks worst, not by effort.

> **Status:** gaps 1, 2, 4 and 5 are **fixed**. Gap 2 (no completion signal) was solved by
> `delegate_task`/`bounce_task`/`check_task` waiting on the worker's report file
> server-side, which is deterministic and preset-independent — better than the
> `wait_for_agent` turn-watch bridge originally proposed here, since it needs no
> per-preset turn detection at all. Gaps 3 (live status) and 6 (`report_to_user`) remain
> open. **Nothing here has been exercised end to end** — see *Test it before building
> anything* above.

### ~~1. MCP-spawned agents have no isolation — the loop is destructive as-is~~ — FIXED

`initMcpBridge`'s spawn handler calls:

```ts
createTerminalSession(undefined, undefined, undefined, { agentPreset: preset })
```

`cwd` is `undefined`, so it resolves to `terminalProjectRoots.get(projectId)` — **the main
checkout**. `createTerminalSession` creates a PTY and nothing else: no `OrchestratorTask`,
no worktree, no placement, no file claim.

So three MCP-spawned workers all edit **the same working tree at once**. That is precisely
what the worktree isolation exists to prevent ([[agent-worktrees]]) and what the standing
agent brief warns about. Left as-is, a three-worker loop doesn't just review badly — it
corrupts its own inputs.

It also means there are no per-worker branches, so the orchestrator has nothing to
`git diff` and must review by reading scrollback — the wrong input for judging code.

**Fixed** in `mcpBridge.ts`: an MCP spawn now calls `createTaskWorktree` first and launches
the session with the worktree as its `cwd`, then registers it with `setSessionWorktree` —
which is what makes the reconciler stage the branch back and makes closing the pane reclaim
it rather than orphan it. A non-git or empty repo still returns null and falls back to the
project root, unchanged.

Isolated is the **unconditional default** here, deliberately: the placement gate
([[agent-placement-gate]]) blocks on a per-agent modal, and there is no user in this path
to answer it — the spawn arrives from a background agent process. A `placement` parameter
on `spawn_agent` is the natural follow-up if main-checkout workers are ever wanted.

⚠️ **Consequence for the protocol:** workers now live in separate checkouts, so a worker
writing a report to a *relative* path writes it inside its own worktree where the
orchestrator never sees it. The shipped brief therefore makes the orchestrator resolve an
**absolute** reports path in its own checkout and hand that to every worker. Changing
either side without the other silently breaks the completion signal.

### 2. There is no completion signal

`read_agent_output` returns a scrollback tail. Nothing distinguishes *"this agent finished
its turn"* from *"still thinking."* The orchestrator must busy-poll — a full tool
round-trip each time, burning its own context — and still can't tell, so it reviews
half-written work.

Spacron already solved this internally:
[`agent-turn-watch.ts`](../src/lib/services/orchestrator/agent-turn-watch.ts) resolves a
turn via hook sentinel → bell → attention prompt → idle fallback, with
[`agent-hook-signals.ts`](../src/lib/services/orchestrator/agent-hook-signals.ts) giving
exact sentinels where the CLI supports them. **None of it is exposed over MCP.**

**Fix — one tool:**

```
wait_for_agent(name, timeout_ms)
  -> { status: 'finished'|'blocked'|'timeout',
       confidence: 'signalled'|'inferred',
       output }
```

Blocks server-side until the turn-watch fires. This converts the orchestrator's loop from
polling to events, and is the single highest-value addition.

**`confidence` is not optional decoration.** Hook sentinels are exact; bell and idle are
guesses, and the idle fallback is 15 minutes when a sentinel channel exists but far shorter
when it doesn't. Since any preset can be a worker, the orchestrator must be told whether
"finished" means *the agent said so* or *we stopped seeing output* — those warrant different
levels of trust, and an orchestrator that can't tell will review half-written work from
exactly the agents whose signals are weakest.

The Rust server already has the deferred-response plumbing: `pending_browser:
PendingRequests` + `resolve_browser_request` hold a `oneshot` sender per in-flight request
while the frontend works. `wait_for_agent` is the same shape with a different resolver.

### 3. `list_agents` doesn't say what agents are doing

The registry is `name → AgentEntry { session_id, name, preset, label }`. No status, no
branch, no last-activity. The orchestrator can't tell which worker is stuck waiting on
input versus working.

**Fix:** enrich the payload with `status` (`working|idle|blocked|failed`), `branch`, and
`last_activity`. The store already has all of it (`OrchestratorTask.status`,
`worktree.branch`) — it just isn't in the response. Falls out of #1.

### 4. `spawn_agent` can't name or role its workers

Only `preset` and `prompt`. Names are auto-assigned by `pickAssistantName()`, so the
orchestrator must call `list_agents` afterwards to learn what its workers got called —
racy with three spawns in flight, and it can't tell which returned name is which task.

**Fix:** `name` and `role` parameters, echoed back in the spawn result.

### 5. Prompt delivery is a 3-second guess

The bridge sends the initial prompt via `setTimeout(…, 3000)`. If the CLI takes longer
than three seconds to boot — routine for Claude Code — the prompt lands in a REPL that
isn't listening and is mangled or lost. The app's own dispatch path uses
`sendOrchestratorFollowUpWhenReady` for exactly this; the MCP path doesn't.

**Fix:** reuse the readiness-aware send.

### 6. There's no way to report back to the user

The final step of the flow — "reply back to me and confirm it's done" — has no surface.
The orchestrator is in a terminal pane; the user has to go look at it.

**Fix:** a `report_to_user(summary)` tool that posts into the orchestrator chat and fires
the completion nudge (soft chime + card, per [[completion-announcements]]). This is what
actually closes the user's loop.

---

## Termination: the discipline has to live in the prompt

With the loop inside Claude Code, **Spacron has no control over when it stops.** There is
no round cap and no gate unless one is asked for.

That matters because of a result worth taking seriously: **Huang et al. (ICLR 2024)** found
LLMs cannot reliably self-correct without external feedback, and that performance
*sometimes degrades* after self-correction. Anthropic's guidance agrees from the other
direction — agents work because they get "ground truth from the environment at each step
(such as tool call results or code execution)." Every framework surveyed also ships a hard
cap; LangGraph's `recursion_limit` defaults to 25.

An orchestrator reviewing worker diffs is still an LLM judging an LLM. So the orchestrator
prompt must carry what the app can't enforce:

- **Gate on something deterministic.** Tests/typecheck decide *done*; the orchestrator's
  judgment decides *what to say and who redoes what*. Never merge on taste alone.
- **Cap the rounds** (3 is a sane default), then stop and ask the user.
- **Stop on stagnation** — if a worker's branch didn't move, or the same critique repeats,
  escalate rather than re-sending.
- **Escalate, never silently stop.** A loop that ends quietly is invisible.

A server-side round counter on `send_to_agent` is a possible backstop, but the prompt is
the primary control. Ship a canned orchestrator prompt (a role preset) rather than
expecting the user to write these rules each time.

**Sources:** [Building Effective AI Agents](https://www.anthropic.com/engineering/building-effective-agents) ·
[LLMs Cannot Self-Correct Reasoning Yet](https://arxiv.org/abs/2310.01798) ·
[Self-Refine](https://arxiv.org/abs/2303.17651) ·
[LangGraph recursion limit](https://docs.langchain.com/oss/python/langgraph/errors/GRAPH_RECURSION_LIMIT) ·
[AutoGen termination](https://microsoft.github.io/autogen/stable//user-guide/agentchat-user-guide/tutorial/termination.html)

---

## Build order

0. **Verify the connection, per preset.** Spawn each candidate agent, ask it to call
   `list_agents`. Everything else depends on this working, and it fails independently per
   agent. Produces the orchestrator-capability matrix.
1. **Spawn parity** (gap 1) — MCP spawns get a task record, a worktree, a name, a file
   claim, and a `placement` parameter. *Without this the loop damages the repo.*
2. **`wait_for_agent`** (gap 2) — the deferred-response tool over `agent-turn-watch`.
   *Without this the loop can't tell when to look.*
3. **Enriched `list_agents`** (gap 3) — status + branch + last-activity.
4. **`spawn_agent` name/role params** (gap 4) and **readiness-aware prompt delivery**
   (gap 5).
5. **`report_to_user`** (gap 6) — closes the loop back to the human.
6. **A canned orchestrator prompt** — the termination discipline above, shipped as a role
   preset so it isn't retyped. It rides the delivery split that already exists in
   [`agent-charter.ts`](../src/lib/services/orchestrator/agent-charter.ts): rules-file
   agents (Claude Code, Codex, Cursor, OpenCode, Antigravity) get it via
   CLAUDE.md/AGENTS.md through `agent-rules-file.ts`; everything else gets it pasted. Tune
   per preset where loop quality differs.

Steps 1–2 are the difference between a demo and something that works. 3–5 are what make it
pleasant. 6 is what keeps it from running forever.

**Security note:** these tools let one local process spawn processes and write into other
agents' terminals. The `?token=` secret is what stands between that and any other process
on the machine. Widening the tool surface raises the stakes on it — see
[[security-trust-boundaries]] before adding anything that writes.

---

## Non-goals

- **An app-side loop engine.** The orchestrator agent owns the iteration. Spacron provides
  tools and truthful state. If the app starts deciding when work is done, this design has
  been re-litigated.
- **A privileged orchestrator agent type.** Orchestrator is a role conferred by a prompt,
  not a flag on a session. Any agent that can reach the tools can run a loop; any agent can
  be a worker.
- **"Loop until perfect."** No such stopping condition exists — cap, gate, and escalate.
- **Managing worker context.** We drive CLI REPLs; their context is theirs. When
  accumulated context is the problem, the answer is a fresh worker on the same branch.
- **Cloud execution.** Unchanged: local or the user's own remote box, never a hosted
  service.

---

## Appendix A: the peer Builder → Reviewer path

A different loop already ships: a Builder hands off to a spawned **Reviewer agent**, which
merges or bounces. It is not the design above and the two should not be conflated.

Working today: Builder completion auto-posts a `handoff`; `parseReviewerVerdict` reads
`APPROVED <branch>` / `BOUNCE BACK: …` from the transcript; approval auto-merges with a
branch-name equality check; a bounce is typed straight into the Builder's live REPL.

**It dies at round 2, silently.** A Reviewer must be `status: 'complete'` for its verdict
to be read (both handlers open with `if (task.status !== 'complete') return`), but
`findTeamReviewer` **excludes** reviewers that are `complete`, and `complete` is terminal
(`ALLOWED_TRANSITIONS.complete = []`). The bounce path revives the Builder and never the
Reviewer. Round 2's handoff finds no reviewer, is never posted, and the work stops with no
card and no toast. Both handlers also re-derive the Builder↔Reviewer pairing by
reverse-scanning the mailbox for the last `handoff`, which picks the wrong one once there
are two builders or a second round.

Same root cause the worktree reconciler documented in [[agent-worktree-staging]] — *"a
`complete` task is terminal so no later turn could re-raise the prompt"*.

**Decide deliberately:** fix it, or retire the `reviewer` role in favour of the MCP
orchestrator above. Leaving a loop that stops without telling anyone is the worst option.

---

## Appendix B: the MCP notes contradict each other

[[mcp-integration]] says *"MCP layer — REMOVED 2026-07-15. Do not re-add"* and files "a
server exposed to the spawned agent CLIs" under **future, not now**. [[mcp-architecture]]
documents that exact server as built.

Both are right about different things: what was removed was the **renderer-internal glue**
(`src/lib/services/mcp/`, client and server in the same renderer over
`InMemoryTransport`); the deferred bet — a real server for the agent CLIs — was
subsequently built in Rust. Read cold, the first note reads as "this whole direction is off
the table," which is wrong and would stop this work before it starts.
