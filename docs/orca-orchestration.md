# Orca orchestration — worktrees, shared-project agents, and how it all comes back together

Status: **RESEARCH / DECISION INPUT** — nothing implemented from this document yet.

Researched 2026-08-10 from primary sources: `github.com/stablyai/orca` (MIT, public),
`skills/*/SKILL.md`, `src/main/agent-hooks/*`, `src/main/git/*`, `src/main/ipc/worktree-*`,
`src/shared/tui-agent-*`. Everything below is quoted from those, not guessed. Companion
to `docs/orca-feature-gap.md` (the full feature inventory) — this document zooms into the
one question: **how do multiple agents work on one project, and how does the result get
back into one codebase?**

The short answer, stated once: **Orca runs two coordination modes.** Parallel work happens
in isolated git worktrees (one branch, one terminal, one agent per worktree), and *team*
work happens either as dispatched tasks inside a single worktree (the orchestration skill:
task DAGs, decision gates, worker_done waits) or as a full ownership handoff to another
worktree (the orca-cli skill). Both modes funnel back into the main branch through the
review pane — an explicit approve/merge gate — not through automatic merging.

---

## 1. Mode one — per-task git worktrees (isolation)

Every agent task runs in its own `git worktree` with its own branch:

- `src/main/git/worktree.ts` — worktree create/remove/refresh.
- `src/main/ipc/worktree-branch-name.ts` — branch naming for a new worktree.
- `src/main/ipc/worktrees.ts` — the worktree lifecycle IPC surface.
- `src/main/ipc/worktree-logic.ts`, `worktree-metadata-merge.ts` — how Orca's own
  per-worktree metadata is kept in sync as worktrees churn.
- `src/main/ipc/ssh-worktree-create-root-registration.ts` — the same model over SSH
  (agents on a remote box, full editing + terminals + git).
- A "primary" worktree is the repo root; everything else is a child worktree.

The naming discipline matters as much as the isolation: `src/main/agent-hooks/` contains
**first-work renames** — `first-work-branch-rename.ts`, `first-work-folder-rename.ts`,
`first-work-workspace-title-rename.ts` — which rename the branch, the folder and the
workspace title from the agent's *first real work* instead of a pool name. The sidebar
then reads like a to-do list ("improve-readme" / `[orca] Jinwoo-H/improve-readme`) instead
of `agent-7`. See `docs/orca-feature-gap.md` #11.

## 2. Mode two — orchestration inside a shared context

The orchestration model is shipped as **a skill the agent reads**. The skill is a
deliberately tiny *discovery stub*; the full, version-matched guide is served by the `orca`
binary itself (`ORCA skills get orchestration`), so the guide can never drift from the
binary that runs the commands:

> `skills/orchestration/SKILL.md` — frontmatter description (quoted):
> "Use Orca orchestration for structured multi-agent coordination: **threaded messages,
> blocking ask/reply flows, task dispatch, worker_done/escalation waits, task DAGs,
> decision gates, coordinator loops, or decomposing work across agents**."

And a second skill for the other half of the story:

> `skills/orca-cli/SKILL.md` — "Use `orca-cli` instead for **full ownership handoffs**,
> including requests phrased as 'hand off', 'handoff', 'handover', 'give this to another
> agent', or 'another worktree' … Use the orca-cli skill … for ordinary terminal control,
> worktree management …".

So the mental model Orca gives its agents is:

| If the user wants… | Orca's mechanism |
|---|---|
| several agents on *different* work | one git worktree per agent, own branch |
| one agent to *take over* a task | full ownership handoff to another worktree (`orca worktree` + worktree comments) |
| a *team* on one goal in one worktree | orchestration skill: tasks with a DAG, `worker_done`/escalation waits, decision gates, a coordinator loop |
| an agent to ask a question mid-task | blocking `ask`/`reply` flows (threaded messages) |

Both skills are stubs on purpose — the heavy protocol lives in the binary, delivered via
`ORCA skills get <skill>`. The stubs exist to make the *decision of which mode to use* the
agent's first correct move.

## 3. How it all comes back together

1. **Every worktree is a branch.** No one merges into `main` silently.
2. **First-work renames** give every branch/folder a name that states the work.
3. **The review pane is the gate.** Diffs are reviewed in-app (diff viewer + inline
   annotations shipped back to the agent — feature-gap #20), and merge/PR happens from the
   review surface. `src/main/ipc/worktree-push-target-setup.ts` /
   `worktree-push-target-cleanup.ts` manage where a worktree pushes.
4. **Attribution**: `src/main/attribution/terminal-attribution.ts` attributes terminal
   output to the agent that produced it, so a merged worktree's history carries who did what.

There is **no "auto-merge everything" path**. The coordination contract is: agents finish
a worktree → it goes through review → an approved worktree is merged. Spacron's reviewer
role encodes the same gate in text ("APPROVED \<branch\> auto-approves and merges") — Orca
just has it as product UI rather than a role brief line.

## 4. Honest status comes from hooks, not screenscraping

`src/main/agent-hooks/` is a whole subsystem that installs hooks into each agent's own
config: `managed-hook-registry.ts`, `managed-hook-install-lock.ts`,
`hook-config-write-path.ts`, `hooks-json-read.ts`, `server.ts` (the hook server), plus
WSL relay variants. The hooks report real lifecycle events (started, working, needs-you,
done) and drive the first-work renames. Spacron's equivalent is the per-session append-only
signal file (`src-tauri/src/commands/agent_signals.rs`) — same insight, independently —
but Orca additionally has an install/repair path for the hooks themselves
(feature-gap #10).

## 5. Spacron's model today, compared

Spacron deliberately runs **one shared working tree** — per-task git worktree isolation
was built and then removed (see the module header of
`src/lib/services/orchestrator/agent-charter.ts`). With no filesystem isolation, safety
comes from the standing brief:

| Concern | Orca | Spacron |
|---|---|---|
| Isolation | git worktree + branch per agent | none — agents share the checkout |
| Collision prevention | filesystem boundary | brief rules: **disjoint file claims**, stated up front |
| Team structure | orchestration skill: tasks + DAG + decision gates | roles (coordinator/builder/scout/reviewer/orchestrator) + `.spacron/orchestrator-brief.md` protocol file |
| Done signal | `worker_done` waits | **report files** (`.spacron/reports/`) — deterministic, agent-agnostic |
| Review gate | review pane, approve/merge UI | reviewer role: `APPROVED <branch>` auto-merges / `BOUNCE BACK: <fixes>` |
| Handoff | full ownership handoff, worktree comments | `send_to_agent` MCP tool + shared mailbox |
| Status | hooks installed into agent config | per-session signal file (`agent_signals.rs`) |
| Discovery | skills the agent reads | MCP tools (`list_agents`, `spawn_agent`, `send_to_agent`, `read_agent_output`) + Claude skill at `.claude/skills/orchestrate-fleet/SKILL.md` |
| Naming | first-work rename of branch/folder/title | worker names from a pool (feature-gap #11 — **not built**) |
| Attribution | line-level attribution | nothing (feature-gap #22) |

Spacron already covers Orca's orchestration *functionality* (dispatch, claims, handoffs,
review gates, waits) through its MCP-based protocol; what Orca has that we don't is
mostly **surface**: a UI where the DAG and its decision gates are visible, first-work
renames, hook install/repair, and worktree comments.

## 6. What's worth adopting (each independently shippable)

1. **First-work auto-rename** (feature-gap #11) — the highest-signal, lowest-effort item:
   rename branch/folder/room title from the agent's first real work. Orca and CNVS
   "Shorthand" arrived at the same conclusion independently: *an agent row must say what
   the agent is doing, not what tool it is running.*
2. **A "fix my hooks" affordance** (feature-gap #10) — the signal-file channel exists;
   a repair path (detect the CLI, reinstall the hook, report presence) is the missing half.
3. **Visible coordination state** — Spacron's orchestrator already sequences work
   (claims, handoffs, reviewer gate). Surfacing "who owns which files / who is waiting on
   whom" in the fleet panel is a UI pass over data we already keep.
4. **Worktree comments** — a thin layer over the existing inbox; low value relative to the
   above.

**Deliberately not adopted:** per-task worktree isolation (reverted once already — the
shared tree plus brief discipline is the current design), and the full merge/PR machinery
(Spacron already has a source-control panel and GitHub auth; feature-gap #23's PR/issue
browsing is the real gap there).

## Sources

- `github.com/stablyai/orca` — `skills/orchestration/SKILL.md`,
  `skills/orca-cli/SKILL.md`, `src/main/git/*`, `src/main/ipc/worktree-*`,
  `src/main/agent-hooks/*`, `src/main/attribution/*`, `src/shared/tui-agent-config.ts`
  (the 31-agent CLI registry), `src/shared/tui-agent-permissions.ts` (the Yolo table),
  `src/shared/agent-icons/` (bundled per-agent PNGs).
- Spacron side: `src/lib/services/orchestrator/agent-charter.ts`,
  `src/lib/services/orchestrator/orchestrator-brief.ts`,
  `src/lib/services/orchestrator/agent-rules-file.ts`, `src/lib/stores/orchestrator.ts`.
