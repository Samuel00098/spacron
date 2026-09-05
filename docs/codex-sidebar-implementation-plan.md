# Implement ChatGPT Codex-Style Sidebar ("Agent Command Center") in Spacron

Build a dedicated, agent-centric Codex sidebar inside Spacron that mirrors the command center architecture of OpenAI's Codex app (and the ChatGPT desktop app), seamlessly harmonized with Spacron's liquid-glass `.bento-card` theme, wallpaper background, and multi-CLI orchestration engine.

---

## User Review Required

> [!IMPORTANT]
> **Sidebar Navigation Mode**:
> In Spacron today, the left utility panel is a classic IDE sidebar (`Files`, `Git`, `Problems`, `Snapshots`, `Snippets`).
> We propose introducing a new primary **`Agents` / `Codex`** tab at the top of the left utility drawer (or making it the default initial tab when opening a workspace). It provides a full agent cockpit without breaking existing IDE panels (File Explorer, Git Source Control, etc.).
>
> Review choices:
> 1. **(Recommended)** `Agents` as the premier tab on the Left Utility Drawer with quick shortcuts to Files & Git nested inside.
> 2. A dual-tier sidebar (a slim icon activity rail on the far left, with the Codex thread list in the secondary pane).

---

## Architecture & Design

### 1. Visual & Functional Hierarchy of the Codex Sidebar

```
┌────────────────────────────────────────────────────────┐
│  📁 my-project  ▾ [main]              [+ New Task]     │  <- Repo picker & Quick Spawn
├────────────────────────────────────────────────────────┤
│  ▼ ACTIVE RUNS (2)                                     │
│  ● 🟢 Claude 3.7   "Refactor auth middleware"   · 2m   │  <- Live pulsing agent runs
│  ● 🟡 Codex        "Generate Vitest suite"      · [Diff]│  <- Needs-input indicator
├────────────────────────────────────────────────────────┤
│  ▼ RECENT THREADS                                      │
│  ✓ Antigravity   "Fix modal containment"       · 1h   │  <- Past completed turns
│  ✗ OpenCode      "Docker container build"      · 3h   │  <- Failed/exited turns
├────────────────────────────────────────────────────────┤
│  ▼ WORKSPACE & CONTEXT                                 │
│  📁 File Explorer                                      │  <- One-click inline expand/jump
│  🌿 Git & Worktrees (2 branches)                       │
│  ⚡ Rules & Skills (AGENTS.md)                          │
├────────────────────────────────────────────────────────┤
│  👤 Samuel (Codex CLI)                 🪙 12.4k tokens │  <- Account & Token usage dock
└────────────────────────────────────────────────────────┘
```

### 2. Integration with Spacron's Background & Liquid-Glass System
- Inherits `.bento-card` frosted glass styling:
  - `backdrop-filter: blur(var(--glass-blur, 40px)) saturate(var(--glass-saturate, 210%))`
  - Dynamic specular sheen and rim catch lighting.
  - Transparent glass body allowing the active wallpaper and adaptive color palette (`bg-palette-dark` / `bg-palette-light`) to glow through.
- Respects the bottom `--overlay-clear` padding to prevent collision with the floating prompt bar (`FloatingPromptBar.tsx`).

---

## Proposed Changes

### Left Utility Panel & Navigation

#### [MODIFY] [layout.ts](file:///c:/Users/samue/OneDrive/Documents/Projects/Real%20Projects/spacron/src/lib/types/layout.ts)
- Add `'agents'` to `SidebarTab`:
  ```ts
  export type SidebarTab = 'projects' | 'files' | 'git' | 'problems' | 'snapshots' | 'snippets' | 'agents';
  ```

#### [NEW] [CodexSidebar.tsx](file:///c:/Users/samue/OneDrive/Documents/Projects/Real%20Projects/spacron/src/lib/components/explorer/CodexSidebar.tsx)
- Create the core Codex Sidebar component:
  - **Header**: Active project name, Git branch badge, and `+ New Task` action (`openAgentSpawn()`).
  - **Active Runs Section**: Derived from `terminalSessions` and `allProjectSessions` where `isAgentSession(session) && session.isRunning`.
    - Shows agent logo (`AgentBrandMark`), target prompt label, running duration, and status indicator.
    - Clicking a running agent invokes `onSelectRoom('agent:${session.id}')` to switch the stage.
  - **Recent Threads Section**: Derived from `inboxState.entries` and `orchestratorTasks`.
    - Shows status icon (`done`, `blocked`, `failed`, `report`), task summary, timestamp, and review links.
  - **Context Links**: Quick launchers to switch to `files`, `git`, or open `review` (code review room).
  - **Footer Dock**: Displays the active account identity (`agentAccounts`) and token cost counter (`usageStats`).

#### [NEW] [CodexSidebar.css](file:///c:/Users/samue/OneDrive/Documents/Projects/Real%20Projects/spacron/src/lib/components/explorer/CodexSidebar.css)
- Styling for the Codex sidebar:
  - Scrollable thread container with custom glass scrollbar styling.
  - Pulse animations for active runs (`.codex-status-dot.pulse`).
  - Smooth hover states using `rgba(255, 255, 255, 0.05)` and accent highlights.
  - Compact typography with subtle metadata contrast.

#### [MODIFY] [AppShell.tsx](file:///c:/Users/samue/OneDrive/Documents/Projects/Real%20Projects/spacron/src/lib/components/layout/AppShell.tsx)
- Update `LEFT_DRAWER_TOOLS` to include `'agents'`:
  ```ts
  const LEFT_DRAWER_TOOLS = ['agents', 'projects', 'files', 'git', 'problems', 'snapshots', 'snippets'] as const;
  ```
- Define icon and metadata in `LEFT_TOOL_META`:
  ```tsx
  agents: {
    title: 'Agents & Threads',
    icon: <Icon><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><polyline points="16 11 18 13 22 9" /></Icon>,
  },
  ```
- In `SidebarContent({ tab })`:
  ```tsx
  if (tab === 'agents') return <CodexSidebar onSelectRoom={focusRoom} />;
  ```

---

## Verification Plan

### Automated Tests
- Run type check to ensure no regressions in layout types or props:
  ```pwsh
  npm run check
  ```
- Run unit test suite:
  ```pwsh
  npm test
  ```

### Manual Verification
1. **Visual Appearance**:
   - Verify that the Codex sidebar renders with the frosted glass `.bento-card` background over various wallpapers (dark and light themes).
   - Ensure header, active runs, recent threads, and footer dock fit cleanly within the drawer width.
2. **Interactive Behaviors**:
   - Click `+ New Task`: Ensure `AgentSpawnModal` opens as expected.
   - Spawn an agent (e.g., Codex or Claude): Verify that an "Active Runs" card appears with a live pulsing dot.
   - Click on an active run card: Verify the ambient stage immediately focuses that agent's room (`agent:<id>`).
   - Trigger a task finish or "needs input" event: Verify that the status dot updates to the appropriate status badge (green check / amber warning).
   - Resize the left drawer: Ensure thread items, truncated summaries, and header elements scale smoothly without clipping.
