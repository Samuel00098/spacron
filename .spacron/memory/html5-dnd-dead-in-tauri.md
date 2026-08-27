# HTML5 drag-and-drop is dead inside the Tauri window

The Tauri v2 window keeps its default `dragDropEnabled` (`src-tauri/tauri.conf.json`
has no override), so on Windows/WebView2 the renderer's native HTML5 DnD pipeline is
disabled — `draggable`, `onDragStart`, `dataTransfer` never fire anywhere in the app.
That is the price of OS file drops arriving via
`getCurrentWindow().onDragDropEvent(...)`, which FloatingPromptBar.tsx,
TerminalPane.tsx and AgentPanelImages.tsx all rely on.

**Never "fix" this by setting `dragDropEnabled: false`** — every file-drop UX breaks.

So any in-app drag surface must use pointer events. The tasks-panel kanban does
(TasksPanel.tsx): press on card body → arm after 5px travel → live hit-test each
pointermove with `document.elementsFromPoint` into `{col, beforeId}` → release runs
the same cross-column exit / reorder commit path the old drop handler had. Gotchas
learned there: `preventDefault()` on the card's pointerdown stops text selection
without breaking the follow-up click; guard presses landing on buttons/inputs/the run
menu; and keep the ~320ms post-drop click guard or the release-click opens the task
editor.

The Projects panel (ProjectHUD.tsx) drags projects between collections the same
way, hit-testing into `{workspaceId, beforePath}`. Same gotchas, same guard —
there the release-click would open the project you just moved.
