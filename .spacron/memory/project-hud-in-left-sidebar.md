# Project HUD in Left Sidebar

## Overview
The Project Launcher / HUD is now hosted as a first-class drawer tool in the left utility panel (`SidebarTab = 'projects'`), rather than opening as a full-screen pop-up overlay modal.

## Key Seams & Architecture
- **Sidebar Tab & Meta**: `'projects'` is the leading tab in `LEFT_DRAWER_TOOLS` within `src/lib/components/layout/AppShell.tsx` and a valid member of `SidebarTab` in `src/lib/types/layout.ts` and `src/lib/stores/zustand/layout.ts`.
- **Toggle Triggers**: Both the TitleBar breadcrumb trigger button (`onClick={toggleProjectHUD}`) and the `Ctrl+K` keyboard shortcut trigger `toggleProjectHUD()`, which in turn dispatches `toggleSidebarTab('projects')`.
- **Project Switching & Persistence**: Clicking a project invokes `handleOpen(wsId, path)`, which switches active projects and workspaces. Layout state (`sidebarTab: 'projects'` and `sidebarVisible: true`) is validated by `sanitiseSidebarTab` and persists across workspace restores.

## Collections UI (2026-08-24)
- "Collection" is the **user-facing** name for what the store still calls a *workspace* (`recentWorkspaces`, `createNewWorkspace`, `openWorkspace`). Rename copy only — don't rename the store seams.
- Creating a collection has exactly one entry point in the HUD: the folder-plus button in `.projects-panel-header`, which reveals the inline `projects-new-collection-inline` form. The old always-on footer bar (`.projects-sidebar-footer`) was a duplicate of it and is deleted.
- Collection groups collapse from their header title button; collapsed ids persist in `localStorage` under `spacron.hud.collapsedCollections`. A non-empty search force-expands every group so matches can't hide.
- The collection-header action icons (rename / new folder / add / delete) are always visible at `opacity: .7` and go full on hover — deliberately not hover-only.
- The OS folder picker opened by `openProject()` (`src/lib/stores/workspace.ts`) is titled "Add Folder to Collection".
