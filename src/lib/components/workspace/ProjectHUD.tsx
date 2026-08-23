import { useEffect, useMemo, useRef, useState } from 'react';
import { useWorkspaceStore } from '$lib/stores/zustand/workspace';
import { useGitBranchStore } from '$lib/stores/zustand/gitBranch';
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
} from '$lib/stores/workspace';
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

interface FlatProjectItem {
  workspaceId: string;
  workspaceName: string;
  path: string;
  name: string;
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

  const inputRef = useRef<HTMLInputElement | null>(null);
  const newCollectionInputRef = useRef<HTMLInputElement | null>(null);
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

  function handleMoveProject(projectPath: string, sourceWsId: string, targetWsId: string) {
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

          return (
            <section key={ws.id} className="projects-collection-group">
              <header className="projects-collection-header">
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
                  <span className="projects-collection-title">
                    <svg className="projects-collection-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                    </svg>
                    <span className="projects-collection-name">{ws.name}</span>
                    <span className="projects-collection-count">({ws.project_paths?.length || 0})</span>
                  </span>
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

                  return (
                    <div
                      key={p.path}
                      className={`project-sidebar-card${isHovered ? ' hovered' : ''}${p.isActive ? ' active' : ''}`}
                      onClick={() => handleOpen(ws.id, p.path)}
                      onMouseEnter={() => setHoveredIndex(globalIdx)}
                    >
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
                  );
                })}

                {wsProjects.length === 0 && !search && (
                  <div className="projects-collection-empty">
                    <span>No projects in this collection</span>
                  </div>
                )}
              </div>
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

      {/* Bottom Footer Section */}
      <footer className="projects-sidebar-footer">
        <form className="projects-new-collection-footer-form" onSubmit={handleCreateCollection}>
          <input
            type="text"
            placeholder="New Collection name…"
            className="projects-new-collection-footer-input"
            value={newWsName}
            onChange={(e) => setNewWsName(e.target.value)}
          />
          <button type="submit" className="projects-new-collection-footer-btn" disabled={!newWsName.trim()} title="Create collection">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
        </form>
      </footer>
    </div>
  );
}
