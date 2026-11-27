# Unified Multi-Agent Structured Chat (Standalone & In-Project)

This document records the architecture and implementation plan for unifying Spacron's outside-of-project standalone chat and in-project structured chat under one shared multi-agent `TerminalChatView` experience.

## Goals
1. **Outside-of-project structured chat**: Replace `StandaloneChatPanel`'s legacy orchestrator chat with the full `TerminalChatView` structured chat backed by Spacron's isolated scratch workspace (`chat_workspace_open`), zero PTY allocation, lazy process start on first send, and preserved **Create project from chat** promotion.
2. **Unified Agent -> Model -> Reasoning picker**: Surface all 11 structured-chat agents (`codex`, `claude`, `antigravity`, `opencode`, `pi`, `cursor`, `hermes`, `grok`, `copilot`, `kimi`, `omp`) in both standalone and project structured chats, listing installed agents first (with favourite pinning) and uninstalled agents greyed out below with install doc links (`openAgentInstallDocs`).
3. **Mid-conversation switching**:
   - Same agent, different model or reasoning effort: live update (`setModel` / `setEffort`) without restarting.
   - Different agent between turns: flush outgoing provider to `StructuredEventJournal`, append an inline switch `notice` divider, close outgoing provider, and launch the target provider in the same `cwd` with `seedContext` populated from the normalized journal.
4. **Full composer parity**: `/` commands (plus `/agent` and `/sidebar`), `@` file mentions (`cwd` passed from scratch workspace or project root), and right-sidebar `/sidebar` / `/side` / `/btw` side chats working both inside and outside a project.

## Decision after review (2026-11-27)
Goals 2 and 3 apply to **standalone chats only**. The user wants a project chat (and its side chats) to stay on
its own agent and offer only that agent's models.

## Module Layout
- `src/lib/services/structured-chat/agent-catalog.ts` — canonical structured agent catalog, install detection, live/cached model resolution, and reasoning-level enrichment.
- `src/lib/services/structured-chat/panes.ts` — `commandForStructuredAgent` mapping alongside `structuredChatAgentFor`.
- `src/lib/services/structured-chat/session-store.ts` — `switchStructuredAgent`, virtual pane IDs (`< 0`), standalone record CRUD, virtual side-chat support, and idempotent legacy standalone migration.
- `src/lib/services/structured-chat/standalone-structured.ts` — lazy scratch-workspace setup, virtual pane lifecycle, first-send launch, and `promoteStandaloneStructuredChatToProject`.
- `src/lib/services/structured-chat/commands.ts` — `/agent` (`/switch`), `/sidebar`, and lazy-start command handling.
- `src/lib/services/structured-chat/side-chat-source.ts` — standalone-aware side-chat source selection.
- `src/lib/components/terminal/StructuredAgentModelPicker.tsx` & `.css` — two-column Agent + Model + Reasoning + Toggles picker.
- `src/lib/components/terminal/TerminalChatView.tsx`, `TerminalPane.tsx`, `SideChatPane.tsx`, `StandaloneChatPanel.tsx`, `StandaloneChatsSidebar.tsx`, `NewFolderModal.tsx`, `AppShell.tsx`.
