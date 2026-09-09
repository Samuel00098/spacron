import { useState } from 'react';
import { useAppIcon } from '$lib/react/useAppIcon';
import {
  openProject,
  openWorkspace,
  cloneRepoPromptOpen,
  newFolderPromptOpen,
} from '$lib/stores/workspace';
import { useWorkspaceStore } from '$lib/stores/zustand/workspace';
import { formatShortcutLabel } from '$lib/utils/shortcut-label';
import type { Workspace } from '$lib/types/workspace';
import './EmptyWorkbench.css';

function FolderIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function GitIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2C6.48 2 2 6.48 2 12c0 4.42 2.87 8.17 6.84 9.5.5.09.68-.22.68-.48l-.01-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.89 1.53 2.34 1.09 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02a9.56 9.56 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.69-4.57 4.94.36.31.68.92.68 1.85l-.01 2.75c0 .27.18.58.69.48A10 10 0 0 0 22 12c0-5.52-4.48-10-10-10z" />
    </svg>
  );
}

function PlusIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function shortPath(path: string) {
  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/');
  return parts.length <= 2 ? normalized : `.../${parts.slice(-2).join('/')}`;
}

function formatRelativeTime(ts?: string): string {
  if (!ts) return '';
  try {
    const n = parseInt(ts, 10);
    if (Number.isNaN(n)) return '';
    const diff = Date.now() - n;
    const m = Math.floor(diff / 60000);
    const h = Math.floor(diff / 3600000);
    const d = Math.floor(diff / 86400000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    if (h < 24) return `${h}h ago`;
    if (d < 7) return `${d}d ago`;
    return new Date(n).toLocaleDateString();
  } catch {
    return '';
  }
}

export default function EmptyWorkbench() {
  const iconSrc = useAppIcon();
  const [iconError, setIconError] = useState(false);
  const recentList = useWorkspaceStore((s) => s.recentWorkspaces) || [];
  const topRecents = recentList.slice(0, 5);

  return (
    <div className="empty-workbench">
      <div className="empty-wb-container">
        {/* Hero */}
        <div className="empty-wb-hero">
          <div className="empty-wb-logo">
            {!iconError ? (
              <img src={iconSrc} alt="Spacron" onError={() => setIconError(true)} />
            ) : (
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#aeb6c2" strokeWidth="2">
                <polyline points="4 17 10 11 4 5" />
                <line x1="12" y1="19" x2="20" y2="19" />
              </svg>
            )}
          </div>
          <h1 className="empty-wb-title">Spacron</h1>
          <p className="empty-wb-subtitle">Open a project folder to start working</p>
        </div>

        {/* Primary Actions */}
        <div className="empty-wb-actions">
          <button
            type="button"
            className="empty-wb-btn primary"
            onClick={() => void openProject()}
          >
            <div className="empty-wb-btn-left">
              <span className="empty-wb-btn-icon"><FolderIcon /></span>
              <span>Open Project</span>
            </div>
            <kbd>{formatShortcutLabel('Ctrl+O')}</kbd>
          </button>

          <button
            type="button"
            className="empty-wb-btn secondary"
            onClick={() => newFolderPromptOpen.set(true)}
          >
            <div className="empty-wb-btn-left">
              <span className="empty-wb-btn-icon"><PlusIcon /></span>
              <span>New Project Folder</span>
            </div>
            <kbd>{formatShortcutLabel('Ctrl+N')}</kbd>
          </button>

          <button
            type="button"
            className="empty-wb-btn secondary"
            onClick={() => cloneRepoPromptOpen.set(true)}
          >
            <div className="empty-wb-btn-left">
              <span className="empty-wb-btn-icon"><GitIcon /></span>
              <span>Clone from GitHub</span>
            </div>
          </button>
        </div>

        {/* Recent Projects (if any exist) */}
        {topRecents.length > 0 && (
          <div className="empty-wb-recents">
            <div className="empty-wb-recents-header">
              <span className="empty-wb-recents-title">Recent Projects</span>
            </div>
            <div className="empty-wb-recents-list">
              {topRecents.map((ws: Workspace) => {
                const displayPath = ws.project_paths.length > 0
                  ? ws.project_paths.map(shortPath).join(', ')
                  : 'Empty project';
                const timeAgo = formatRelativeTime(ws.last_opened);
                return (
                  <button
                    key={ws.id}
                    type="button"
                    className="empty-wb-recent-item"
                    onClick={() => void openWorkspace(ws.id)}
                  >
                    <div className="empty-wb-recent-left">
                      <span className="empty-wb-recent-icon"><FolderIcon size={14} /></span>
                      <div className="empty-wb-recent-meta">
                        <span className="empty-wb-recent-name">{ws.name}</span>
                        <span className="empty-wb-recent-path">{displayPath}</span>
                      </div>
                    </div>
                    {timeAgo && <span className="empty-wb-recent-time">{timeAgo}</span>}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Footer shortcuts */}
        <div className="empty-wb-footer">
          <div className="empty-wb-hint">
            <span>Quick switch</span>
            <kbd>{formatShortcutLabel('Ctrl+K')}</kbd>
          </div>
          <span>•</span>
          <div className="empty-wb-hint">
            <span>Commands</span>
            <kbd>{formatShortcutLabel('Ctrl+Shift+P')}</kbd>
          </div>
        </div>
      </div>
    </div>
  );
}
