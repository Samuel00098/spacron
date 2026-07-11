import { useEffect, useMemo, useRef, useState } from 'react';
import { useWorkspaceStore } from '$lib/stores/zustand/workspace';
import { useGitBranchStore } from '$lib/stores/zustand/gitBranch';
import {
  isProjectHUDOpen,
  recentWorkspaces,
  activeWorkspaceId,
  activeProjectId,
  openWorkspace,
  switchToProject,
  createNewWorkspace,
  renameWorkspace,
  removeProjectFromCollection,
  deleteCollection,
  openProject,
  newFolderPromptOpen
} from '$lib/stores/workspace';
import { useStore } from '$lib/react/useStore';
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

function getProjectColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  // Dynamic, vibrant gradient
  return `linear-gradient(135deg, hsl(${hue} 65% 55%), hsl(${(hue + 60) % 360} 70% 45%))`;
}

interface FlatProjectItem {
  workspaceId: string;
  workspaceName: string;
  path: string;
  name: string;
}

export default function ProjectHUD() {
  const isOpen = useStore(isProjectHUDOpen);
  const workspaces = useWorkspaceStore((s) => s.recentWorkspaces);
  const activeWsId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const activeProjId = useWorkspaceStore((s) => s.activeProjectId);
  const projectsMap = useWorkspaceStore((s) => s.projects);
  const branchInfo = useGitBranchStore((s) => s.branchInfoByProject);

  const [search, setSearch] = useState('');
  const [hoveredIndex, setHoveredIndex] = useState(0);
  const [newWsName, setNewWsName] = useState('');
  const [editingWsId, setEditingWsId] = useState<string | null>(null);
  const [editingWsName, setEditingWsName] = useState('');
  const [showWsMenuId, setShowWsMenuId] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

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
          name: getFilename(path)
        });
      }
    }
    return list;
  }, [workspaces]);

  // Filter projects by search query
  const filteredProjects = useMemo(() => {
    const q = search.toLowerCase();
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
    isProjectHUDOpen.set(false);
  }

  // Handle create new collection
  function handleCreateCollection(e: React.FormEvent) {
    e.preventDefault();
    const name = newWsName.trim();
    if (!name) return;
    createNewWorkspace(name);
    setNewWsName('');
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

  // Keyboard controls
  useEffect(() => {
    if (!isOpen) return;

    // Focus input on mount
    setTimeout(() => inputRef.current?.focus(), 50);

    const handleGlobalKeys = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        isProjectHUDOpen.set(false);
      } else if (e.key === 'ArrowDown') {
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
      }
    };

    window.addEventListener('keydown', handleGlobalKeys);
    return () => window.removeEventListener('keydown', handleGlobalKeys);
  }, [isOpen, filteredProjects, hoveredIndex, activeWsId, projectsMap]);

  // Keep hovered card visible when using arrow keys
  useEffect(() => {
    if (!listRef.current) return;
    const activeEl = listRef.current.querySelector('.project-hud-card.hovered');
    if (activeEl) {
      activeEl.scrollIntoView({ block: 'nearest' });
    }
  }, [hoveredIndex]);

  // Render context/move menu
  function toggleMoveMenu(e: React.MouseEvent, path: string) {
    e.stopPropagation();
    setShowWsMenuId(showWsMenuId === path ? null : path);
  }

  function handleMoveProject(projectPath: string, sourceWsId: string, targetWsId: string) {
    // If it's already there, do nothing
    if (sourceWsId === targetWsId) return;

    recentWorkspaces.update((list) =>
      list.map((w) => {
        if (w.id === sourceWsId) {
          const paths = w.project_paths.filter((p) => p !== projectPath);
          return {
            ...w,
            project_paths: paths,
            active_project_path: w.active_project_path === projectPath ? (paths[0] ?? null) : w.active_project_path,
          };
        }
        if (w.id === targetWsId) {
          const paths = w.project_paths.includes(projectPath) ? w.project_paths : [...w.project_paths, projectPath];
          return {
            ...w,
            project_paths: paths,
          };
        }
        return w;
      })
    );
    setShowWsMenuId(null);
  }

  if (!isOpen) return null;

  return (
    <div className="project-hud-overlay" onClick={() => isProjectHUDOpen.set(false)}>
      <div className="project-hud" onClick={(e) => e.stopPropagation()}>
        
        {/* Header Search */}
        <header className="project-hud-header">
          <div className="hud-search-field">
            <svg className="hud-search-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              ref={inputRef}
              type="text"
              className="hud-search-input"
              placeholder="Search projects or collections… (↑↓ to navigate, Enter to open)"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <button
            type="button"
            className="hud-close-btn"
            onClick={() => isProjectHUDOpen.set(false)}
            title="Close"
            aria-label="Close"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </header>

        {/* Content list */}
        <div ref={listRef} className="project-hud-body scrollable">
          {workspaces.map((ws) => {
            // Filter project paths in this workspace
            const wsProjects = (ws.project_paths || []).map((path) => ({
              path,
              name: getFilename(path),
              isActive: activeWsId === ws.id && activeProjPath === path
            })).filter((p) => {
              if (!search) return true;
              const q = search.toLowerCase();
              return p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q) || ws.name.toLowerCase().includes(q);
            });

            if (search && wsProjects.length === 0) return null;

            return (
              <section key={ws.id} className="hud-collection-section">
                <header className="hud-collection-header">
                  {editingWsId === ws.id ? (
                    <input
                      className="hud-collection-rename-input"
                      value={editingWsName}
                      onChange={(e) => setEditingWsName(e.target.value)}
                      onBlur={() => saveRename(ws.id)}
                      onKeyDown={(e) => e.key === 'Enter' && saveRename(ws.id)}
                      onClick={(e) => e.stopPropagation()}
                      autoFocus
                    />
                  ) : (
                    <span className="hud-collection-title">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                      </svg>
                      {ws.name}
                      <span className="hud-project-count">({ws.project_paths.length})</span>
                    </span>
                  )}

                  <div className="hud-collection-actions">
                    <button
                      className="hud-action-btn"
                      onClick={() => startRename(ws.id, ws.name)}
                      title="Rename collection"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                        <path d="M18.5 2.5a2.122 2.122 0 1 1 3 3L12 15l-4 1 1-4z" />
                      </svg>
                    </button>
                    
                    <button
                      className="hud-action-btn"
                      onClick={async () => {
                        // Create the new folder inside this collection: make it the
                        // active workspace first (the modal creates into the active
                        // one), then close the HUD and open the New Folder dialog.
                        if (activeWsId !== ws.id) {
                          await openWorkspace(ws.id);
                        }
                        isProjectHUDOpen.set(false);
                        newFolderPromptOpen.set(true);
                      }}
                      title="New folder in collection"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                        <line x1="12" y1="11" x2="12" y2="17" />
                        <line x1="9" y1="14" x2="15" y2="14" />
                      </svg>
                    </button>

                    <button
                      className="hud-action-btn add-btn"
                      onClick={async () => {
                        // Activate workspace first if not active
                        if (activeWsId !== ws.id) {
                          await openWorkspace(ws.id);
                        }
                        await openProject();
                      }}
                      title="Add existing folder to collection"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                        <line x1="12" y1="5" x2="12" y2="19" />
                        <line x1="5" y1="12" x2="19" y2="12" />
                      </svg>
                    </button>

                    <button
                      className="hud-action-btn danger"
                      onClick={() => {
                        if (confirm(`Delete collection "${ws.name}"? (Your project files will not be deleted)`)) {
                          deleteCollection(ws.id);
                        }
                      }}
                      title="Delete collection"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      </svg>
                    </button>
                  </div>
                </header>

                <div className="hud-project-grid">
                  {wsProjects.map((p) => {
                    // Match corresponding index in filteredProjects
                    const globalIdx = filteredProjects.findIndex((item) => item.path === p.path && item.workspaceId === ws.id);
                    const isHovered = globalIdx === hoveredIndex;

                    // Git details for active loaded project
                    const gitInfo = activeWsId === ws.id && activeProjId && projectsMap.get(activeProjId)?.root_path === p.path
                      ? branchInfo[activeProjId]
                      : null;

                    return (
                      <div
                        key={p.path}
                        className={`project-hud-card${isHovered ? ' hovered' : ''}${p.isActive ? ' active' : ''}`}
                        onClick={() => handleOpen(ws.id, p.path)}
                        onMouseEnter={() => setHoveredIndex(globalIdx)}
                      >
                        <div className="project-hud-card-avatar">
                          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="hud-folder-icon">
                            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" fill="currentColor" fillOpacity="0.15" />
                          </svg>
                        </div>
                        <div className="project-hud-card-info">
                          <div className="project-hud-card-name-row">
                            <span className="project-hud-card-name">{p.name}</span>
                            {p.isActive && (
                              <span className="hud-active-badge">
                                <span className="hud-active-dot" />
                                Active
                              </span>
                            )}
                          </div>
                          <span className="project-hud-card-path" title={p.path}>
                            {shortPath(p.path)}
                          </span>
                          
                          {gitInfo && (
                            <span className="project-hud-card-git">
                              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                <line x1="6" y1="3" x2="6" y2="15" />
                                <circle cx="18" cy="6" r="3" />
                                <circle cx="6" cy="18" r="3" />
                                <path d="M18 9a9 9 0 0 1-9 9" />
                              </svg>
                              {gitInfo.current}
                            </span>
                          )}
                        </div>

                        {/* Card controls */}
                        <div className="hud-card-actions" onClick={(e) => e.stopPropagation()}>
                          <button
                            className="hud-card-action-btn"
                            onClick={(e) => toggleMoveMenu(e, p.path)}
                            title="Move to collection..."
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <circle cx="12" cy="12" r="1" />
                              <circle cx="12" cy="5" r="1" />
                              <circle cx="12" cy="19" r="1" />
                            </svg>
                          </button>

                          <button
                            className="hud-card-action-btn hover-danger"
                            onClick={() => removeProjectFromCollection(ws.id, p.path)}
                            title="Remove project from collection"
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <line x1="18" y1="6" x2="6" y2="18" />
                              <line x1="6" y1="6" x2="18" y2="18" />
                            </svg>
                          </button>

                          {/* Move to another workspace popup */}
                          {showWsMenuId === p.path && (
                            <div className="hud-move-menu">
                              <div className="hud-move-menu-label">Move to collection</div>
                              {workspaces
                                .filter((other) => other.id !== ws.id)
                                .map((other) => (
                                  <button
                                    key={other.id}
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
                    );
                  })}
                </div>
              </section>
            );
          })}

          {filteredProjects.length === 0 && (
            <div className="hud-empty-state">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <h3>No projects found</h3>
              <p>Try searching for a different name or path, or create a new collection below.</p>
            </div>
          )}
        </div>

        {/* Footer controls */}
        <footer className="project-hud-footer">
          <form className="hud-new-collection-form" onSubmit={handleCreateCollection}>
            <input
              type="text"
              placeholder="New Collection name..."
              className="hud-new-collection-input"
              value={newWsName}
              onChange={(e) => setNewWsName(e.target.value)}
            />
            <button type="submit" className="hud-new-collection-btn">
              Create Collection
            </button>
          </form>
          
          <div className="hud-shortcuts-help">
            <span><kbd>↑↓</kbd> Navigate</span>
            <span><kbd>Enter</kbd> Open</span>
          </div>
        </footer>

      </div>
    </div>
  );
}
