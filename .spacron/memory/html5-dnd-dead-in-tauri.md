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

(ProjectHUD.tsx used to drag projects between collections this way. It has no
drag handlers left — the panel is a flat project list reordered from the card
menu — so take the pattern from the task board, not from there.)

## Every drop surface hears every drop

`onDragDropEvent` and the explorer's `spacron-explorer-drag-*` events are
**window-level broadcasts** — each mounted surface has to decide for itself
whether a drop was meant for it, and a `getBoundingClientRect()` containment
test is the wrong way. Hidden rooms stay mounted and laid out at full stage size
(`.stage-hidden`, parked `.terminal-project-layer`, the CLI layer behind chat
mode), so their rect contains every point on the stage and all of them claim the
same drop — one dragged file landed in every open agent terminal at once.

Use `isPointOverDropTarget` (`src/lib/utils/drop-target.ts`): hit testing via
`document.elementsFromPoint` skips `visibility: hidden` / `pointer-events: none`
subtrees. It does **not** settle occlusion — covered elements stay in the stack —
so a surface that must not steal from one above it (TerminalPane vs the
`#floating-prompt-bar`) still needs its own explicit check. See
[[image-attach-delivery]] for what each surface does with the path once it wins.
