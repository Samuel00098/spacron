# Project worktrees (Orca-style rows) vs agent worktrees

Two separate mechanisms share the word "worktree":

- **Project worktrees** — the user's, listed under each project in the sidebar
  (`ProjectWorktreeList`), created from the Create worktree dialog. Live in
  `<root>/.spacron/trees/`, metadata in `.spacron/trees.json`. Any number of
  agents share one. Backend: `commands/project_worktrees.rs` (also wired into
  `remote/mod.rs` dispatch — keep both in step).
- **Agent worktrees** — one per isolated agent/thread, in
  `<root>/.spacron/worktrees/`, owned by the orchestrator.

Trap: `sweepOrphanWorktrees` deletes every folder in `.spacron/worktrees/` that
no task or session claims. A project worktree placed there would vanish on the
next sweep with no agent in it. Never move them into that area.

The selected row ("active worktree", `stores/projectWorktrees.ts`) is honoured
only where new work starts *without* an explicit folder: `createTerminalSession`'s
cwd fallback, `TerminalPanel.getStartingCwd`, `AgentSpawnModal` "main"
placement, `quickSpawnAgent`, and `createChatThread` (attaches a `shared`
worktree). Restores pass their own cwd and must stay unaffected. A new spawn
path that should follow the selection has to call `workingRootFor`.

Sidebar grouping: when a project's worktree list loads, `ProjectHUD` lists
every agent, terminal and chat thread *under* the worktree that owns its
folder (`worktreeForPath` — deepest match wins, the main checkout takes the
rest, including agent-isolated `.spacron/worktrees/` checkouts). Rooms such
as the editor and preview stay at project level. Non-git projects keep the
old flat layout.

A thread's `worktree.shared` means "joined, not owned": leaving detaches only,
never removes. See [[agent-pane-survival]].
