import { useEffect, useMemo, useRef, useState } from 'react';
import { useWorkspaceStore } from '$lib/stores/zustand/workspace';
import { useGitBranchStore } from '$lib/stores/zustand/gitBranch';
import { useStore } from '$lib/react/useStore';
import {
  recentWorkspaces,
  openWorkspace,
  switchToProject,
  createNewWorkspace,
  renameWorkspace,
  removeProjectFromCollection,
  deleteCollection,
  openProject,
  newFolderPromptOpen,
  cloneRepoPromptOpen,
  projectOpenRooms,
  isProjectSwitching,
  moveProjectBetweenCollections,
} from '$lib/stores/workspace';
import {
  allProjectSessions,
  getSessionPromptTargetLabel,
  getSessionPaneDisplayTitle,
  isAgentSession,
  type TerminalSessionInfo,
} from '$lib/stores/terminal';
import { requestRoomControl } from '$lib/stores/layoutControl';
import './ProjectHUD.css';

function getFilename(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/');
  return parts[parts.length - 1] || path;
}

function shortPath(path: string) {
  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/');
  return parts.length <= 2 ? normalized : `.../${parts.slice(-2).join('/')}`;
}

const COLLAPSED_KEY = 'spacron.hud.collapsedCollections';
const EXPANDED_PROJECTS_KEY = 'spacron.hud.expandedProjects';

// Past this a press is a drag, not a click. HTML5 drag-and-drop never fires
// inside the Tauri window (the window owns an OS-level file-drop handler, which
// disables the WebView's native DnD pipeline), so moving a project between
// collections is pointer-driven — the same shape the tasks kanban uses.
const DRAG_ARM_THRESHOLD_PX = 5;

// Two clicks on the same card inside this window are one double-tap. Matches the
// platform default closely enough that a deliberate double-tap is never split
// into two project opens.
const DOUBLE_TAP_MS = 400;

// Room ids as AppShell spells them, so a click here can be handed straight to
// `requestRoomControl`. Kept to the rooms `projectOpenRooms` can report.
const ROOM_LABELS: Record<string, string> = {
  terminal: 'Terminal',
  editor: 'Editor',
  preview: 'Preview',
  review: 'Review',
  tasks: 'Tasks',
  sketch: 'Sketch',
};

interface FlatProjectItem {
  workspaceId: string;
  workspaceName: string;
  path: string;
  name: string;
}

/** Where a dragged project would land: a collection, and the card it goes before. */
interface DropTarget {
  workspaceId: string;
  beforePath: string | null;
}

export default function ProjectHUD() {
  const workspaces = useWorkspaceStore((s) => s.recentWorkspaces);
  const activeWsId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const activeProjId = useWorkspaceStore((s) => s.activeProjectId);
  const projectsMap = useWorkspaceStore((s) => s.projects);
  const branchInfo = useGitBranchStore((s) => s.branchInfoByProject);

  const [search, setSearch] = useState('');
  const [hoveredIndex, setHoveredIndex] = useState(0);
  const [newWsName, setNewWsName] = useState('');
  const [showNewCollection, setShowNewCollection] = useState(false);
  const [editingWsId, setEditingWsId] = useState<string | null>(null);
  const [editingWsName, setEditingWsName] = useState('');
  const [showWsMenuId, setShowWsMenuId] = useState<string | null>(null);
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(COLLAPSED_KEY);
      return new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      return new Set<string>();
    }
  });

  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(EXPANDED_PROJECTS_KEY);
      return new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      return new Set<string>();
    }
  });
  const [dragPath, setDragPath] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const newCollectionInputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const pointerDragRef = useRef<{
    path: string;
    workspaceId: string;
    startX: number;
    startY: number;
    armed: boolean;
    detach: () => void;
  } | null>(null);
  // A release ends with a click on the card, which would open the project the
  // drag just moved. Swallow it for a beat, like the tasks board does.
  const justDraggedRef = useRef(false);
  // Double-tapping a card expands it, and a double-tap is delivered as two
  // clicks plus a `dblclick`. Without this the second click runs `handleOpen`
  // again — a second `switchToProject` into a switch that is still restoring.
  // Single-click stays instant: the FIRST click is never delayed, only a
  // repeat one on the same card inside the double-tap window is dropped.
  const lastCardClickRef = useRef<{ path: string; at: number }>({ path: '', at: 0 });

  // Every running session in every project, so a project's processes are
  // readable without switching into it. `sessions` only ever holds the active
  // project's.
  const crossProjectSessions = useStore(allProjectSessions);
  const openRoomsByProject = useStore(projectOpenRooms);

  // A project only has a stable id once it has been opened at least once, and
  // only an opened project can have anything running in it — so a path with no
  // id here is simply a project with nothing to show.
  const projectIdByPath = useMemo(() => {
    const byPath = new Map<string, string>();
    for (const project of projectsMap.values()) byPath.set(project.root_path, project.id);
    return byPath;
  }, [projectsMap]);

  const sessionsByProject = useMemo(() => {
    const byProject = new Map<string, TerminalSessionInfo[]>();
    for (const session of crossProjectSessions) {
      if (!session.isRunning) continue;
      const list = byProject.get(session.projectId);
      if (list) list.push(session);
      else byProject.set(session.projectId, [session]);
    }
    return byProject;
  }, [crossProjectSessions]);

  // Derive active project's path
  const activeProjPath = useMemo(() => {
    if (!activeProjId) return null;
    return projectsMap.get(activeProjId)?.root_path ?? null;
  }, [activeProjId, projectsMap]);

  // Flatten projects list for global search and keyboard navigation
  const flatProjectsList = useMemo(() => {
    const list: FlatProjectItem[] = [];
    const listWorkspaces = workspaces || [];
    for (const ws of listWorkspaces) {
      for (const path of ws.project_paths || []) {
        list.push({
          workspaceId: ws.id,
          workspaceName: ws.name,
          path,
          name: getFilename(path),
        });
      }
    }
    return list;
  }, [workspaces]);

  // Filter projects by search query
  const filteredProjects = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return flatProjectsList;
    return flatProjectsList.filter(
      (item) =>
        item.name.toLowerCase().includes(q) ||
        item.path.toLowerCase().includes(q) ||
        item.workspaceName.toLowerCase().includes(q)
    );
  }, [search, flatProjectsList]);

  // Adjust hoveredIndex when search changes to prevent it going out of bounds
  useEffect(() => {
    setHoveredIndex(0);
  }, [search]);

  // Handle click-outside for move-to-collection popup menu
  useEffect(() => {
    if (!showWsMenuId) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.hud-move-menu') && !target.closest('.hud-card-action-btn')) {
        setShowWsMenuId(null);
      }
    };
    window.addEventListener('click', handleClickOutside);
    return () => window.removeEventListener('click', handleClickOutside);
  }, [showWsMenuId]);

  // Handle open project
  async function handleOpen(wsId: string, path: string) {
    if (wsId !== activeWsId) {
      // Set the clicked project as the active project path of that workspace before opening
      recentWorkspaces.update((list) =>
        list.map((w) => (w.id === wsId ? { ...w, active_project_path: path } : w))
      );
      await openWorkspace(wsId);
    } else {
      const proj = Array.from(projectsMap.values()).find((p) => p.root_path === path);
      if (proj) {
        switchToProject(proj.id);
      }
    }
  }

  // Handle create new collection
  function handleCreateCollection(e: React.FormEvent) {
    e.preventDefault();
    const name = newWsName.trim();
    if (!name) return;
    createNewWorkspace(name);
    setNewWsName('');
    setShowNewCollection(false);
  }

  // Start renaming a collection
  function startRename(id: string, currentName: string) {
    setEditingWsId(id);
    setEditingWsName(currentName);
  }

  // Save renamed collection
  function saveRename(id: string) {
    const name = editingWsName.trim();
    if (name) {
      renameWorkspace(id, name);
    }
    setEditingWsId(null);
  }

  // Collapse / expand a collection (persisted across sessions)
  function toggleCollapsed(id: string) {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify(Array.from(next)));
      } catch {
        /* storage unavailable — collapse state stays session-only */
      }
      return next;
    });
  }

  // Expand / collapse a project's contents (persisted across sessions)
  function toggleProjectExpanded(path: string) {
    setExpandedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      try {
        localStorage.setItem(EXPANDED_PROJECTS_KEY, JSON.stringify(Array.from(next)));
      } catch {
        /* storage unavailable — expansion stays session-only */
      }
      return next;
    });
  }

  // ── Jumping to a room from the panel ───────────────────────────────────────
  // A room only exists on the stage once its project is active, and switching
  // projects restores that project's whole saved arrangement asynchronously —
  // a focus sent before that lands is simply overwritten by it. So the request
  // waits for `isProjectSwitching` to go true and back to false rather than for
  // the switch call to return, which is several awaits too early.
  const pendingFocusRef = useRef<(() => void) | null>(null);

  function focusRoomAfterSwitch(room: string) {
    pendingFocusRef.current?.();

    let settled = false;
    let sawSwitch = false;
    let unsubscribe: (() => void) | null = null;
    let timer = 0;

    function cancel() {
      window.clearTimeout(timer);
      unsubscribe?.();
      unsubscribe = null;
      if (pendingFocusRef.current === cancel) pendingFocusRef.current = null;
    }

    function finish() {
      if (settled) return;
      settled = true;
      cancel();
      requestRoomControl('focus', room);
    }

    pendingFocusRef.current = cancel;
    unsubscribe = isProjectSwitching.subscribe((busy) => {
      if (busy) sawSwitch = true;
      else if (sawSwitch) finish();
    });
    // A switch can also be a no-op (nothing to restore), and then the flag never
    // flips and there is nothing to wait for. The fallback only applies while no
    // switch has been seen — a slow restore is waited out by the subscription.
    timer = window.setTimeout(() => {
      if (!sawSwitch) finish();
    }, 800);
  }

  useEffect(() => () => pendingFocusRef.current?.(), []);

  async function openRoom(wsId: string, path: string, room: string) {
    const projectId = projectIdByPath.get(path);
    if (projectId && activeProjId === projectId) {
      requestRoomControl('focus', room);
      return;
    }
    focusRoomAfterSwitch(room);
    await handleOpen(wsId, path);
  }

  // Keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHoveredIndex((prev) => (filteredProjects.length === 0 ? 0 : (prev + 1) % filteredProjects.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHoveredIndex((prev) =>
        filteredProjects.length === 0 ? 0 : (prev - 1 + filteredProjects.length) % filteredProjects.length
      );
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const selected = filteredProjects[hoveredIndex];
      if (selected) {
        handleOpen(selected.workspaceId, selected.path).catch(console.error);
      }
    } else if (e.key === 'Escape') {
      if (search) {
        e.preventDefault();
        setSearch('');
      }
    }
  };

  // Keep hovered card visible when using arrow keys
  useEffect(() => {
    if (!listRef.current) return;
    const activeEl = listRef.current.querySelector('.project-sidebar-card.hovered');
    if (activeEl) {
      activeEl.scrollIntoView({ block: 'nearest' });
    }
  }, [hoveredIndex]);

  // Render context/move menu
  function toggleMoveMenu(e: React.MouseEvent, path: string) {
    e.stopPropagation();
    setShowWsMenuId(showWsMenuId === path ? null : path);
  }

  // Both ways of moving a project — this menu and the drag below — commit
  // through the same list surgery.
  function handleMoveProject(
    projectPath: string,
    sourceWsId: string,
    targetWsId: string,
    beforePath: string | null = null
  ) {
    if (sourceWsId === targetWsId && beforePath === projectPath) return;
    recentWorkspaces.update((list) =>
      moveProjectBetweenCollections(list, projectPath, sourceWsId, targetWsId, beforePath)
    );
    setShowWsMenuId(null);
  }

  // ── Dragging a project between collections ─────────────────────────────────
  // Pointer events, not HTML5 DnD: the Tauri window's OS-level file-drop handler
  // disables the WebView's native drag pipeline, so `draggable`/`onDragStart`
  // never fire. A press on the card body arms a drag past the threshold, every
  // move hit-tests the list into a `{workspaceId, beforePath}` target, and the
  // release runs the same move the "Move to collection" menu does.

  function hitTestDrop(clientX: number, clientY: number, draggedPath: string): DropTarget | null {
    const stack = document.elementsFromPoint(clientX, clientY);
    const groupEl = stack.find(
      (el): el is HTMLElement => el instanceof HTMLElement && el.classList.contains('projects-collection-group')
    );
    const workspaceId = groupEl?.dataset.wsId;
    if (!workspaceId) return null;

    let beforePath: string | null = null;
    for (const cardEl of groupEl.querySelectorAll<HTMLElement>('.project-sidebar-card')) {
      const path = cardEl.dataset.projectPath;
      if (!path || path === draggedPath) continue;
      const rect = cardEl.getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) {
        beforePath = path;
        break;
      }
    }
    return { workspaceId, beforePath };
  }

  function endPointerDrag(dropAt?: { x: number; y: number }) {
    const drag = pointerDragRef.current;
    if (!drag) return;
    pointerDragRef.current = null;
    drag.detach();

    // Released before the threshold: an ordinary click, which the card's own
    // onClick handles.
    if (!drag.armed) return;

    setDragPath(null);
    setDropTarget(null);
    justDraggedRef.current = true;
    window.setTimeout(() => {
      justDraggedRef.current = false;
    }, 320);

    if (!dropAt) return; // pointercancel / Escape / released off the list
    const target = hitTestDrop(dropAt.x, dropAt.y, drag.path);
    if (!target) return;
    handleMoveProject(drag.path, drag.workspaceId, target.workspaceId, target.beforePath);
  }

  function onCardPointerDown(e: React.PointerEvent, wsId: string, path: string) {
    if (e.button !== 0) return;
    // Presses on the card's own controls (expand chevron, move menu, remove)
    // belong to those controls — a drag starts from the card body only.
    const target = e.target as HTMLElement;
    if (target.closest('button') || target.closest('input') || target.closest('.hud-move-menu')) return;
    e.preventDefault();

    const drag: NonNullable<typeof pointerDragRef.current> = {
      path,
      workspaceId: wsId,
      startX: e.clientX,
      startY: e.clientY,
      armed: false,
      detach: () => {},
    };
    pointerDragRef.current = drag;

    const onMove = (ev: PointerEvent) => {
      if (pointerDragRef.current !== drag) return;
      if (!drag.armed) {
        if (Math.hypot(ev.clientX - drag.startX, ev.clientY - drag.startY) < DRAG_ARM_THRESHOLD_PX) return;
        drag.armed = true;
        setDragPath(drag.path);
        document.body.style.userSelect = 'none';
      }
      ev.preventDefault();
      setDropTarget(hitTestDrop(ev.clientX, ev.clientY, drag.path));
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.button !== 0) return;
      endPointerDrag(drag.armed ? { x: ev.clientX, y: ev.clientY } : undefined);
    };
    const onCancel = () => endPointerDrag();
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') endPointerDrag();
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey, true);
    drag.detach = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey, true);
      document.body.style.userSelect = '';
    };
  }

  // A drag in flight when the panel unmounts must not leave its window
  // listeners (or the body's `user-select: none`) behind.
  useEffect(() => () => pointerDragRef.current?.detach(), []);

  return (
    <div className="projects-sidebar-panel">
      {/* Top Header Toolbar */}
      <div className="projects-panel-header">
        <span className="projects-panel-title">Projects</span>
        <div className="projects-header-actions">
          <button
            type="button"
            className="projects-header-btn"
            onClick={() => {
              setShowNewCollection(true);
              setTimeout(() => newCollectionInputRef.current?.focus(), 50);
            }}
            title="New Collection"
            aria-label="New Collection"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              <line x1="12" y1="11" x2="12" y2="17" />
              <line x1="9" y1="14" x2="15" y2="14" />
            </svg>
          </button>
          <button
            type="button"
            className="projects-header-btn"
            onClick={() => openProject()}
            title="Open Folder..."
            aria-label="Open Folder..."
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
          </button>
          <button
            type="button"
            className="projects-header-btn"
            onClick={() => cloneRepoPromptOpen.set(true)}
            title="Clone Git Repository..."
            aria-label="Clone Git Repository..."
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="18" cy="18" r="3" />
              <circle cx="6" cy="6" r="3" />
              <circle cx="6" cy="18" r="3" />
              <path d="M18 15V9a4 4 0 0 0-4-4H9" />
              <line x1="6" y1="9" x2="6" y2="15" />
            </svg>
          </button>
        </div>
      </div>

      {/* Filter / Search Bar */}
      <div className="projects-search-section">
        <div className="projects-search-field">
          <svg className="projects-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            className="projects-search-input"
            placeholder="Filter projects or collections…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          {search && (
            <button
              type="button"
              className="projects-search-clear"
              onClick={() => setSearch('')}
              title="Clear search"
              aria-label="Clear search"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Inline New Collection Creator (if opened via header button) */}
      {showNewCollection && (
        <form className="projects-new-collection-inline" onSubmit={handleCreateCollection}>
          <input
            ref={newCollectionInputRef}
            type="text"
            className="projects-inline-input"
            placeholder="New Collection name…"
            value={newWsName}
            onChange={(e) => setNewWsName(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setShowNewCollection(false)}
          />
          <button type="submit" className="projects-inline-btn primary" disabled={!newWsName.trim()}>
            Create
          </button>
          <button
            type="button"
            className="projects-inline-btn"
            onClick={() => setShowNewCollection(false)}
          >
            Cancel
          </button>
        </form>
      )}

      {/* Main Scrollable Projects List */}
      <div ref={listRef} className="projects-panel-body scrollable">
        {workspaces.map((ws) => {
          // Filter project paths in this workspace
          const wsProjects = (ws.project_paths || []).map((path) => ({
            path,
            name: getFilename(path),
            isActive: activeWsId === ws.id && activeProjPath === path,
          })).filter((p) => {
            if (!search) return true;
            const q = search.toLowerCase().trim();
            return (
              p.name.toLowerCase().includes(q) ||
              p.path.toLowerCase().includes(q) ||
              ws.name.toLowerCase().includes(q)
            );
          });

          if (search && wsProjects.length === 0) return null;

          // While searching every group stays open so matches are never hidden
          const isCollapsed = !search && collapsedIds.has(ws.id);

          const isDropTarget = dropTarget?.workspaceId === ws.id;

          return (
            <section
              key={ws.id}
              className={`projects-collection-group${isDropTarget ? ' drop-target' : ''}`}
              data-ws-id={ws.id}
            >
              <header className={`projects-collection-header${isCollapsed ? ' collapsed' : ''}`}>
                {editingWsId === ws.id ? (
                  <input
                    className="projects-collection-rename-input"
                    value={editingWsName}
                    onChange={(e) => setEditingWsName(e.target.value)}
                    onBlur={() => saveRename(ws.id)}
                    onKeyDown={(e) => e.key === 'Enter' && saveRename(ws.id)}
                    onClick={(e) => e.stopPropagation()}
                    autoFocus
                  />
                ) : (
                  <button
                    type="button"
                    className="projects-collection-title"
                    onClick={() => toggleCollapsed(ws.id)}
                    aria-expanded={!isCollapsed}
                    title={isCollapsed ? 'Expand collection' : 'Collapse collection'}
                  >
                    <svg className="projects-collection-chevron" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                    <svg className="projects-collection-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                    </svg>
                    <span className="projects-collection-name">{ws.name}</span>
                    <span className="projects-collection-count">({ws.project_paths?.length || 0})</span>
                  </button>
                )}

                <div className="projects-collection-actions">
                  <button
                    type="button"
                    className="projects-action-btn"
                    onClick={() => startRename(ws.id, ws.name)}
                    title="Rename collection"
                    aria-label="Rename collection"
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                      <path d="M18.5 2.5a2.122 2.122 0 1 1 3 3L12 15l-4 1 1-4z" />
                    </svg>
                  </button>

                  <button
                    type="button"
                    className="projects-action-btn"
                    onClick={async () => {
                      if (activeWsId !== ws.id) {
                        await openWorkspace(ws.id);
                      }
                      newFolderPromptOpen.set(true);
                    }}
                    title="New folder in collection"
                    aria-label="New folder in collection"
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                      <line x1="12" y1="11" x2="12" y2="17" />
                      <line x1="9" y1="14" x2="15" y2="14" />
                    </svg>
                  </button>

                  <button
                    type="button"
                    className="projects-action-btn add-btn"
                    onClick={async () => {
                      if (activeWsId !== ws.id) {
                        await openWorkspace(ws.id);
                      }
                      await openProject();
                    }}
                    title="Add existing folder to collection"
                    aria-label="Add existing folder to collection"
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                      <line x1="12" y1="5" x2="12" y2="19" />
                      <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                  </button>

                  <button
                    type="button"
                    className="projects-action-btn danger"
                    onClick={() => {
                      if (confirm(`Delete collection "${ws.name}"? (Your project files will not be deleted)`)) {
                        deleteCollection(ws.id);
                      }
                    }}
                    title="Delete collection"
                    aria-label="Delete collection"
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    </svg>
                  </button>
                </div>
              </header>

              {!isCollapsed && (
                <div className="projects-collection-items">
                  {wsProjects.map((p) => {
                    const globalIdx = filteredProjects.findIndex(
                      (item) => item.path === p.path && item.workspaceId === ws.id
                    );
                    const isHovered = globalIdx === hoveredIndex;

                    const gitInfo =
                      activeWsId === ws.id && activeProjId && projectsMap.get(activeProjId)?.root_path === p.path
                        ? branchInfo[activeProjId]
                        : null;

                    const projectId = projectIdByPath.get(p.path) ?? null;
                    const projectSessions = projectId ? sessionsByProject.get(projectId) ?? [] : [];
                    const projectRooms = projectId ? openRoomsByProject.get(projectId) ?? [] : [];
                    const workingCount = projectSessions.filter((session) => session.isExecuting).length;
                    const hasContents = projectSessions.length > 0 || projectRooms.length > 0;
                    const isExpanded = expandedProjects.has(p.path);

                    return (
                      <div key={p.path} className="project-sidebar-entry">
                        {isDropTarget && dropTarget?.beforePath === p.path && (
                          <div className="projects-drop-line" />
                        )}
                        <div
                          data-project-path={p.path}
                          className={`project-sidebar-card${isHovered ? ' hovered' : ''}${p.isActive ? ' active' : ''}${
                            dragPath === p.path ? ' dragging' : ''
                          }${isExpanded ? ' expanded' : ''}`}
                          onClick={() => {
                            if (justDraggedRef.current) return;
                            const now = Date.now();
                            const last = lastCardClickRef.current;
                            lastCardClickRef.current = { path: p.path, at: now };
                            // Second half of a double-tap: the expand handler
                            // owns it, and the project was already opened by the
                            // first click.
                            if (last.path === p.path && now - last.at < DOUBLE_TAP_MS) return;
                            handleOpen(ws.id, p.path);
                          }}
                          onDoubleClick={(e) => {
                            // Double-tap anywhere on the card is the big target
                            // for the same thing the disclosure chevron does.
                            e.preventDefault();
                            if (justDraggedRef.current) return;
                            toggleProjectExpanded(p.path);
                          }}
                          onPointerDown={(e) => onCardPointerDown(e, ws.id, p.path)}
                          onMouseEnter={() => setHoveredIndex(globalIdx)}
                        >
                          <button
                            type="button"
                            className={`project-disclosure-btn${isExpanded ? ' open' : ''}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleProjectExpanded(p.path);
                            }}
                            aria-expanded={isExpanded}
                            title={
                              isExpanded
                                ? 'Hide what is open in this project'
                                : 'Show what is open in this project (or double-click the card)'
                            }
                            aria-label={isExpanded ? 'Hide project contents' : 'Show project contents'}
                          >
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="9 6 15 12 9 18" />
                            </svg>
                          </button>

                          <div className="project-sidebar-card-avatar">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="project-folder-icon">
                              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" fill="currentColor" fillOpacity="0.12" />
                            </svg>
                          </div>

                          <div className="project-sidebar-card-info">
                            <div className="project-sidebar-card-name-row">
                              <span className="project-sidebar-card-name">{p.name}</span>
                              {p.isActive && (
                                <span className="project-active-badge">
                                  <span className="project-active-dot" />
                                  Active
                                </span>
                              )}
                            </div>

                            <div className="project-sidebar-card-meta-row">
                              <span className="project-sidebar-card-path" title={p.path}>
                                {shortPath(p.path)}
                              </span>

                              {gitInfo && (
                                <span className="project-sidebar-card-git" title={`Git Branch: ${gitInfo.current}`}>
                                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                    <line x1="6" y1="3" x2="6" y2="15" />
                                    <circle cx="18" cy="6" r="3" />
                                    <circle cx="6" cy="18" r="3" />
                                    <path d="M18 9a9 9 0 0 1-9 9" />
                                  </svg>
                                  <span className="git-branch-text">{gitInfo.current}</span>
                                </span>
                              )}

                              {/* Collapsed summary, so a glance is enough: how many
                                  agents are running here, and whether any is working. */}
                              {!isExpanded && projectSessions.length > 0 && (
                                <span
                                  className="project-sidebar-card-agents"
                                  title={
                                    workingCount > 0
                                      ? `${workingCount} of ${projectSessions.length} working`
                                      : `${projectSessions.length} running`
                                  }
                                >
                                  <span className={`hud-status-dot${workingCount > 0 ? ' working' : ''}`} />
                                  {projectSessions.length}
                                </span>
                              )}
                            </div>
                          </div>

                          {/* Card Hover Action Buttons */}
                          <div className="project-card-actions" onClick={(e) => e.stopPropagation()}>
                            <button
                              type="button"
                              className="hud-card-action-btn"
                              onClick={(e) => toggleMoveMenu(e, p.path)}
                              title="Move to collection..."
                              aria-label="Move to collection..."
                            >
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <circle cx="12" cy="12" r="1" />
                                <circle cx="12" cy="5" r="1" />
                                <circle cx="12" cy="19" r="1" />
                              </svg>
                            </button>

                            <button
                              type="button"
                              className="hud-card-action-btn hover-danger"
                              onClick={() => removeProjectFromCollection(ws.id, p.path)}
                              title="Remove project from collection"
                              aria-label="Remove project from collection"
                            >
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <line x1="18" y1="6" x2="6" y2="18" />
                                <line x1="6" y1="6" x2="18" y2="18" />
                              </svg>
                            </button>

                            {/* Move to another workspace popup menu */}
                            {showWsMenuId === p.path && (
                              <div className="hud-move-menu">
                                <div className="hud-move-menu-label">Move to collection</div>
                                {workspaces
                                  .filter((other) => other.id !== ws.id)
                                  .map((other) => (
                                    <button
                                      key={other.id}
                                      type="button"
                                      className="hud-move-menu-item"
                                      onClick={() => handleMoveProject(p.path, ws.id, other.id)}
                                    >
                                      {other.name}
                                    </button>
                                  ))}
                                {workspaces.filter((other) => other.id !== ws.id).length === 0 && (
                                  <div className="hud-move-menu-empty">No other collections</div>
                                )}
                              </div>
                            )}
                          </div>
                        </div>

                      {isExpanded && (
                        <div className="project-contents">
                          {!hasContents && (
                            <div className="project-contents-empty">Nothing open in this project</div>
                          )}
                          {projectSessions.length > 0 && (
                            <div className="project-contents-section">
                              <div className="project-contents-label">Running</div>
                              {projectSessions.map((session) => {
                                const isAgent = isAgentSession(session);
                                const name = isAgent
                                  ? getSessionPromptTargetLabel(session, projectSessions)
                                  : session.title;
                                const detail = getSessionPaneDisplayTitle(session, projectSessions);
                                return (
                                  <button
                                    key={session.id}
                                    type="button"
                                    className="project-process-row"
                                    onClick={() =>
                                      openRoom(ws.id, p.path, isAgent ? `agent:${session.id}` : 'terminal').catch(
                                        console.error
                                      )
                                    }
                                    title={session.isExecuting ? `${name} — working` : `${name} — running`}
                                  >
                                    <span
                                      className={`hud-status-dot${session.isExecuting ? ' working' : ''}`}
                                      aria-hidden="true"
                                    />
                                    <span className="project-process-name">{name}</span>
                                    {detail && detail !== name && (
                                      <span className="project-process-detail">{detail}</span>
                                    )}
                                  </button>
                                );
                              })}
                            </div>
                          )}

                          {projectRooms.length > 0 && (
                            <div className="project-contents-section">
                              <div className="project-contents-label">Rooms</div>
                              <div className="project-room-chips">
                                {projectRooms.map((room) => (
                                  <button
                                    key={room}
                                    type="button"
                                    className="project-room-chip"
                                    onClick={() => openRoom(ws.id, p.path, room).catch(console.error)}
                                    title={`Open ${ROOM_LABELS[room] ?? room}`}
                                  >
                                    {ROOM_LABELS[room] ?? room}
                                  </button>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                      </div>
                    );
                  })}

                  {isDropTarget && dropTarget?.beforePath === null && (
                    <div className="projects-drop-line" />
                  )}

                  {wsProjects.length === 0 && !search && (
                    <div className="projects-collection-empty">
                      <span>No projects in this collection</span>
                    </div>
                  )}
                </div>
              )}
            </section>
          );
        })}

        {filteredProjects.length === 0 && (
          <div className="projects-empty-state">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <p className="projects-empty-title">No projects found</p>
            {search ? (
              <button
                type="button"
                className="projects-empty-action-btn"
                onClick={() => setSearch('')}
              >
                Clear Search
              </button>
            ) : (
              <button
                type="button"
                className="projects-empty-action-btn"
                onClick={() => {
                  setShowNewCollection(true);
                  setTimeout(() => newCollectionInputRef.current?.focus(), 50);
                }}
              >
                Create Collection
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
