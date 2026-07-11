# Spacron Agent Intelligence — Design

## The Goal

Make Spacron's fleet **smart enough to divide a goal and ship it in parallel** with
minimal relaying through the user. Today the orchestrator is a hub: you talk, it spawns or
messages agents, agents report back to you, and you carry information between them. The next
step is to let a **team** of agents share a goal, split the work, talk to each other, and
build on what the previous agent learned — while you stay in the loop as director and
approver, not as a message bus.

The two closest competitors already do this, and this doc is about borrowing the ideas that
fit Spacron without giving up what makes Spacron different (BYO-key, no meter, fully local,
whole-app voice, personality). See [`market-research-2026.md`](./market-research-2026.md)
for the competitive picture.

---

## What we're borrowing (and from where)

| Idea | Source | What it adds |
|---|---|---|
| Shared mailbox / message bus | BridgeSpace | Agents talk to each other, not only to the user |
| Formal agent roles | BridgeSpace | Coordinator plans · Builder writes · Scout explores · Reviewer gates |
| File ownership / collision avoidance | BridgeSpace | Two agents never edit the same file at once |
| Knowledge-graph memory | BridgeSpace (BridgeMemory) | Wikilinked markdown every agent reads *and writes* |
| Bi-directional flow | CNVS | Agent → user "here's what I did, here's next" + agent → agent handoff |

**Sources:** [BridgeSpace](https://www.bridgemind.ai/products/bridgespace) ·
[BridgeSwarm](https://www.bridgemind.ai/bridgeswarm) ·
[BridgeMCP](https://www.bridgemind.ai/bridgemcp) · [CNVS](https://cnvs.dev/)

---

## Where Spacron stands today

Grounding the plan in what already exists, so we extend rather than rebuild:

- **Orchestrator routing** — `src/lib/services/orchestrator-brain.ts` routes a user message
  (voice or text) to actions: spawn an agent, or send a sub-task to a running one. It already
  supports "plan first, then delegate sub-tasks to open agents"
  (`orchestrator-brain.ts` ~line 699). **Shape: hub-and-spoke.** Everything flows
  *user ↔ agent*; there is no *agent ↔ agent* channel.
- **Named agents / personality** — `src/lib/services/orchestrator/agent-names.ts` gives agents
  character names (Neo, Trinity, …). This is the CNVS "named characters" idea, already shipped.
  We are **not** behind here.
- **Isolation** — `commands::workspace::workspace_git_create_worktree` + `agent/worktree-manager.ts`
  give each agent its own git worktree on a branch under `.spacron-worktrees/`. This is the
  substrate for file-ownership: agents already can't physically collide on disk.
- **Review** — `agent/review-gate.ts` + the confirmation gate already gate work before it lands.
  This is the Reviewer role in embryo.
- **Memory** — `src/lib/services/orchestrator/memory.ts` stores **≤40 one-line task outcomes**
  per project in `.spacron/orchestrator-memory.json`, deduped by normalized key, top-8 injected
  into context. It is a **learning log, not a knowledge graph**: one-directional (learns from
  finished tasks only), flat (no links/entities), and per-project (no shared graph agents author).

So the two real gaps are: **(1) no agent-to-agent channel**, and **(2) memory is a flat log,
not an authored graph.** Roles, handoff, and bi-directional flow all sit on top of (1).

---

## Core Idea: the mailbox is the keystone

Roles, handoff, and bi-directional flow are all *messages between agents*. Build the channel
first; everything else is a message type on top of it. Building roles or handoff without the
bus means inventing an ad-hoc channel twice.

```
        ┌──────────────── you (director / approver) ────────────────┐
        │  voice / text                              approvals ▲     │
        ▼                                                      │     │
   Orchestrator ──► Coordinator ──┬─► Builder  ──┐             │     │
   (brain.ts)       (planner)     ├─► Builder  ──┤             │     │
                                  ├─► Scout    ──┤             │     │
                                  └─► Reviewer ◄─┘ (gates)     │     │
                                       │                       │     │
                                       └──── shared mailbox ───┘─────┘
                              (agent ↔ agent messages: claim, handoff,
                               ask, report, done — persisted per project)
```

### The mailbox

A per-project append-only message log the orchestrator and every agent can read and write,
persisted next to the existing memory at `.spacron/mailbox.json` (or `.spacron/mailbox/`).
Reuses the same `backendInvoke('fs_read_file' / 'fs_write_file')` seam
`memory.ts` already uses, so it works locally **and** over the remote-workspace transport for
free. Message shape (sketch):

```ts
interface MailboxMessage {
  id: string;
  from: string;            // agent id / name, or "orchestrator" / "user"
  to: string | null;       // agent id, or null = broadcast to the team
  kind: 'claim' | 'handoff' | 'ask' | 'report' | 'done' | 'note';
  taskId?: string;
  files?: string[];        // for claim: files this task will own
  text: string;
  createdAt: number;
}
```

Agents post to and poll the mailbox as part of their turn (via their rules file / MCP, the
same way they already read the injected memory). The orchestrator watches it to surface
agent-to-agent traffic to the user and to drive the bi-directional reporting loop.

### Roles

A role is a **charter preset** (extends the existing `agent/agent-charter.ts`) the orchestrator
assigns when it breaks a goal into a plan:

- **Coordinator** — turns a goal into ordered sub-tasks, assigns them, sequences shared deps.
- **Builder** — implements one sub-task in its own worktree.
- **Scout** — read-only exploration / recon (`agent/recon.ts` is a starting point).
- **Reviewer** — gates every merge (wire to the existing `review-gate.ts`).

The orchestrator brain already plans-then-delegates; roles make the plan explicit and give
each agent a charter that tells it how to behave and how to use the mailbox.

### File ownership

Extend the worktree layer with a **claim**: before a Builder starts, it posts a `claim`
message listing the files its task owns. The Coordinator refuses to dispatch a second task
that claims an overlapping file until the first releases it (sequences shared dependencies).
Worktrees already prevent physical collisions; claims prevent *logical* ones (two agents
solving the same file in parallel and conflicting at merge).

### Bi-directional flow

Two message types close the loop:

- **Agent → user report** — an agent posts a `report` ("did X, next is Y"); the orchestrator
  renders it as a structured, approvable card (extends `agent/agent-signals.ts` + the
  confirmation gate) instead of raw terminal scroll. You approve or redirect.
- **Agent → agent handoff** — a Builder posts `done` + `handoff` to the Reviewer; the Reviewer
  gates and either merges or bounces it back with a `note`. No user relay required.

### Memory → knowledge graph

Evolve `memory.ts` from a flat outcome log toward **BridgeMemory-style** authored knowledge:
plain markdown files under `.spacron/memory/` that agents **write** (not just the app), linked
with `[[wikilinks]]`, so "what one agent learns, the next one starts with." This mirrors how
Spacron's own `~/.claude` memory already works — the pattern is familiar to the team. Keep the
current flat log as the fast-path recency layer; layer the graph above it. This is the largest
single piece and can land last.

---

## Build order

1. **New Folder** ✅ *shipped* — create an empty project folder from inside the app (see below).
2. **Mailbox** ✅ *shipped* — the per-project message bus + persistence + orchestrator visibility.
   `orchestrator/mailbox.ts` (append-only log at `.spacron/mailbox.json`, `postMailboxMessage`,
   `getMailboxLines`); wired into the store's project load and the brain's context (`ctx.mailbox`).
   The orchestrator posts each agent's turn outcome (`done` / `note`) so team traffic is captured.
3. **Roles** ✅ *shipped* — Coordinator / Builder / Scout / Reviewer as compact charter presets
   (`ROLE_BRIEFS` in `agent-charter.ts`). The planner assigns one via the spawn action's `role`
   field; it rides both delivery channels (pasted charter + rules-file task message) and is stored
   on the task (`OrchestratorTask.role`).
4. **File ownership** ✅ *shipped* — `claim` / `release` messages + `findClaimConflicts` /
   `activeClaims` in `mailbox.ts`. A builder declares its files via the spawn action's `files`
   field; the store posts a claim on dispatch and holds any spawn whose files overlap a live claim.
   A task's `done` releases its claim.
5. **Bi-directional flow** ✅ *shipped* — on completion a Builder auto-posts a
   `handoff` to a team Reviewer (no user relay); `getMailboxCards` exposes structured, approvable
   cards (report / handoff / ask flagged `actionable`). The UI is `orchestrator/AgentMailboxCards.tsx`:
   a "Needs you" strip pinned above the orchestrator transcript that renders the actionable cards with
   **Approve / Reply / Dismiss**. Approve tells the sending agent to proceed; Reply delivers the user's
   words straight into its live REPL — both via `replyToMailboxCard` / `approveMailboxCard` in
   `stores/orchestrator.ts`, which post the decision to the shared mailbox (kind `note`, from `user`)
   and route it through the existing `sendFollowUpToAgent` plumbing. Handled cards drop out of the strip
   via the in-memory `mailboxSeen` set (`dismissMailboxCard`); the message stays in the log.
6. **Knowledge-graph memory** ✅ *shipped* — `orchestrator/knowledge.ts`: authored, wikilinked
   markdown notes under `.spacron/memory/*.md` the app reads (`loadKnowledgeGraph`) and writes
   (`writeKnowledgeNote`), injected into the brain (`ctx.knowledge`). The standing rules-file brief
   now tells agents to author notes there and link them with `[[wikilinks]]`, so what one agent
   learns the next one starts with. The flat log in `memory.ts` stays the recency fast-path.
   A **graph view** now visualizes it (`orchestrator/KnowledgeGraphOverlay.tsx`): nodes are notes,
   edges are `[[wikilinks]]`, laid out by a deterministic force sim (`knowledge-layout.ts`, `buildNoteGraph`).
   Opened from the orchestrator header, the command palette (*Memory Graph…*), or `knowledgeGraphOpen`.
   A local, free counterpart to BridgeMemory's paywalled graph view.

---

## Non-goals

- **Cloud / async agents.** CNVS orchestrates cloud agents; Spacron stays local, BYO-key, no
  meter. The mailbox is local (or on the user's own remote box), never a hosted service.
- **A separate product suite.** BridgeMind ships four products (Code / Voice / MCP / Space);
  Spacron stays **one unified window**.
- **Replacing personality.** Named agents already exist; roles sit *alongside* personality, they
  don't replace it.

---

## Appendix: New Folder (shipped)

The "start fresh" entry point — create a brand-new empty folder from inside the app, then open
it as a project. Before this, Spacron could only *open an existing* folder.

- **Backend:** `commands::workspace::workspace_create_project(parent, name)` — validates the
  name (single path segment, no separators / `..` / control or Windows-reserved chars), creates
  exactly one directory under `parent`, and registers it as a project root in one step. It
  deliberately sits beside `fs_create_dir` (which requires the target to already be inside a
  root) so a folder can be created *outside* every existing root.
- **Frontend:** `createProjectFolder(parentDir, name)` in `stores/workspace.ts` calls the
  command and attaches the result to the active collection via the shared
  `attachProjectToActiveWorkspace` helper (also used by `addFolderToWorkspace`).
- **UI:** a `NewFolderModal` (name + native location picker), triggered from the Welcome
  screen launchpad, the Empty Workspace panel, and the command palette (`New Folder…`). State
  flag: `newFolderPromptOpen`.
