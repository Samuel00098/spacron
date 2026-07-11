import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { get } from '$lib/stores/storeCompat';
import { isHtmlPath } from '$lib/stores/editor';
import EmptyWorkspace from './EmptyWorkspace.tsx';
import FileIcon from './FileIcon.tsx';
import FileNode from './FileNode.tsx';
import {
  cancelCreate,
  cancelRename,
  confirmCreate,
  confirmRename,
  contextMenu,
  creatingPath,
  creatingType,
  creatingValue,
  deletePaths,
  hideContextMenu,
  loadRootDirectory,
  loadingProjectRoots,
  projectRootNodes,
  renamingPath,
  selectedPaths,
  startCreate,
  startRename,
} from '$lib/stores/explorer';
import { activeProject, openProject } from '$lib/stores/workspace';
import { createTerminalSession } from '$lib/stores/terminal';
import { useStore } from '$lib/react/useStore';
import './FileExplorer.css';

function FilePlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <polyline points="14,2 14,8 20,8" />
      <line x1="12" y1="18" x2="12" y2="12" />
      <line x1="9" y1="15" x2="15" y2="15" />
    </svg>
  );
}

function FolderPlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
      <line x1="12" y1="11" x2="12" y2="17" />
      <line x1="9" y1="14" x2="15" y2="14" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="23,4 23,10 17,10" />
      <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
    </svg>
  );
}

function AddRootIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M16 5V1" />
      <path d="M14 3h4" />
    </svg>
  );
}

function RenameIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  );
}

function DeleteIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="3,6 5,6 21,6" />
      <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
    </svg>
  );
}

function TerminalIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}

function PreviewIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export default function FileExplorer() {
  const menu = useStore(contextMenu);
  const project = useStore(activeProject);
  const rootNodesByPath = useStore(projectRootNodes);
  const loadingRoots = useStore(loadingProjectRoots);
  const createPath = useStore(creatingPath);
  const createType = useStore(creatingType);
  const createValue = useStore(creatingValue);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);

  function handleContextAction(action: string) {
    const { path, isDir } = menu;
    hideContextMenu();

    switch (action) {
      case 'new-file':
        startCreate(path, 'file');
        break;
      case 'new-dir':
        startCreate(path, 'dir');
        break;
      case 'rename':
        startRename(path);
        break;
      case 'delete': {
        const targets = Array.from(get(selectedPaths));
        const list = targets.length > 0 ? targets : path ? [path] : [];
        if (list.length === 0) break;
        const label = list.length === 1
          ? `${isDir ? 'folder' : 'file'} "${list[0].split(/[\\/]/).pop()}"`
          : `${list.length} items`;
        if (confirm(`Delete ${label}?`)) {
          void deletePaths(list);
        }
        break;
      }
      case 'open-terminal': {
        const cwd = isDir ? path : path.split(/[\\/]/).slice(0, -1).join('/');
        void createTerminalSession(cwd);
        break;
      }
      case 'preview-file': {
        void import('$lib/stores/preview').then(({ previewLocalFile }) => {
          previewLocalFile(path);
        });
        break;
      }
    }
  }

  function startNewFile() {
    if (project) startCreate(project.root_path, 'file');
  }

  function startNewDir() {
    if (project) startCreate(project.root_path, 'dir');
  }

  function refreshExplorer() {
    if (project) void loadRootDirectory(project.root_path);
  }

  useEffect(() => {
    if (project && !rootNodesByPath.has(project.root_path)) {
      void loadRootDirectory(project.root_path);
    }
  }, [project, rootNodesByPath]);

  // Instant updates: watch the active project root and refresh the moment
  // anything changes on disk (an agent editing a file, a new file, a rename…).
  // The refresh is silent (skipLoading) so it never flashes; unchanged rows keep
  // their identity via FileNode's memo, so only what actually changed re-renders.
  useEffect(() => {
    if (!project) return;
    const root = project.root_path;
    void invoke('start_fs_watch', { path: root }).catch(() => {});
    const unlisten = listen<string>('fs-change', (event) => {
      if (event.payload === root) {
        void loadRootDirectory(root, true);
      }
    });
    return () => {
      void invoke('stop_fs_watch', { path: root }).catch(() => {});
      void unlisten.then((fn) => fn());
    };
  }, [project]);

  // Slow backstop poll in case the OS watch misses events or can't be
  // established (e.g. inotify watch limit on a very large tree). Silent, so it
  // never flashes; the watcher above is what makes updates feel instant.
  useEffect(() => {
    if (!project) return;
    const interval = setInterval(() => {
      void loadRootDirectory(project.root_path, true);
    }, 15000);
    return () => clearInterval(interval);
  }, [project]);

  useEffect(() => {
    function handleKeydown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        cancelCreate();
        cancelRename();
        hideContextMenu();
      }
      if (event.key === 'Enter') {
        if (get(creatingPath) !== null) void confirmCreate();
        if (get(renamingPath)) void confirmRename();
      }
      if (event.key === 'Delete') {
        const target = event.target as HTMLElement | null;
        if (!target || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
        if (!target.closest('.file-explorer')) return;
        if (get(renamingPath) || get(creatingPath) !== null) return;
        const targets = Array.from(get(selectedPaths));
        if (targets.length === 0) return;
        event.preventDefault();
        const label = targets.length === 1 ? `"${targets[0].split(/[\\/]/).pop()}"` : `${targets.length} items`;
        if (confirm(`Delete ${label}?`)) void deletePaths(targets);
      }
    }

    function handleMouseDown(event: MouseEvent) {
      const target = event.target as HTMLElement | null;
      if (!target) return;

      if (get(contextMenu).visible && contextMenuRef.current && !contextMenuRef.current.contains(target)) {
        hideContextMenu();
      }

      if (get(creatingPath) !== null && !target.closest('.create-input')) {
        cancelCreate();
      }

      if (get(renamingPath) && !target.closest('.rename-input')) {
        cancelRename();
      }
    }

    window.addEventListener('keydown', handleKeydown);
    window.addEventListener('mousedown', handleMouseDown);
    return () => {
      window.removeEventListener('keydown', handleKeydown);
      window.removeEventListener('mousedown', handleMouseDown);
    };
  }, []);

  const rootChildren = project ? rootNodesByPath.get(project.root_path) ?? [] : [];
  const rootLoading = project ? loadingRoots.has(project.root_path) : false;

  return (
    <div className="file-explorer">
      <div className="explorer-header">
        {project && (
          <>
            <button className="header-btn" onClick={startNewFile} title="New File">
              <FilePlusIcon />
            </button>
            <button className="header-btn" onClick={startNewDir} title="New Folder">
              <FolderPlusIcon />
            </button>
            <button className="header-btn" onClick={refreshExplorer} title="Refresh">
              <RefreshIcon />
            </button>
          </>
        )}
        <button className="header-btn add-root-btn" onClick={openProject} title="Add Folder to Workspace">
          <AddRootIcon />
        </button>
      </div>

      <div className="explorer-content">
        {project ? (
          <div className="root-list" role="tree">
            <section className="root-section">
              {createPath === project.root_path && (
                <div className="create-input" style={{ paddingLeft: 24 }}>
                  <FileIcon name={createValue} isDir={createType === 'dir'} />
                  <input
                    type="text"
                    placeholder={createType === 'file' ? 'filename.ts' : 'folder-name'}
                    value={createValue}
                    onChange={(event) => creatingValue.set(event.target.value)}
                    autoFocus
                    onBlur={cancelCreate}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        void confirmCreate();
                      } else if (event.key === 'Escape') {
                        event.preventDefault();
                        cancelCreate();
                      }
                    }}
                  />
                </div>
              )}

              {rootLoading ? (
                <div className="tree-loading">
                  <span className="loading-spinner"></span>
                  <span>Loading files...</span>
                </div>
              ) : rootChildren.length > 0 ? (
                <div className="root-children">
                  {rootChildren.map((node) => <FileNode key={node.entry.path} node={node} />)}
                </div>
              ) : (
                <div className="tree-empty">
                  <p>No files found</p>
                </div>
              )}
            </section>
          </div>
        ) : (
          <EmptyWorkspace />
        )}
      </div>

      {menu.visible && createPortal(
        <div
          ref={contextMenuRef}
          className="context-menu"
          style={{ left: menu.x, top: menu.y }}
          onMouseLeave={hideContextMenu}
        >
          {menu.isDir && (
            <>
              <button className="context-item" onClick={() => handleContextAction('new-file')}>
                <FilePlusIcon />
                New File
              </button>
              <button className="context-item" onClick={() => handleContextAction('new-dir')}>
                <FolderPlusIcon />
                New Folder
              </button>
            </>
          )}
          <button className="context-item" onClick={() => handleContextAction('rename')}>
            <RenameIcon />
            Rename
          </button>
          <button className="context-item" onClick={() => handleContextAction('open-terminal')}>
            <TerminalIcon />
            Open in Terminal
          </button>
          {!menu.isDir && isHtmlPath(menu.path) && (
            <button className="context-item" onClick={() => handleContextAction('preview-file')}>
              <PreviewIcon />
              Preview in Panel
            </button>
          )}
          <button className="context-item danger" onClick={() => handleContextAction('delete')}>
            <DeleteIcon />
            Delete
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
}
