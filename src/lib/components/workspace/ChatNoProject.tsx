import { openProject, openWorkspace, switchToProject } from '$lib/stores/workspace';
import { useWorkspaceStore } from '$lib/stores/zustand/workspace';
import { formatShortcutLabel } from '$lib/utils/shortcut-label';

/**
 * Chat with no project open. The chat works inside a project's folder (its
 * conversations are saved per project, and it reads files, runs commands and
 * launches agents there), so this screen's only job is to get one open:
 * the projects already in this workspace, the recent ones, or Open Project.
 */

function shortPath(path: string) {
  const parts = path.replace(/\\/g, '/').split('/');
  return parts.length <= 2 ? parts.join('/') : `…/${parts.slice(-2).join('/')}`;
}

function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

export default function ChatNoProject() {
  const projects = useWorkspaceStore((s) => s.projects);
  const recents = useWorkspaceStore((s) => s.recentWorkspaces) || [];
  // Projects already loaded in this workspace switch instantly; recents
  // reopen their workspace. A path listed in both shows once, as the former.
  const open = [...projects.values()];
  const openPaths = new Set(open.map((project) => project.root_path));
  const recentRows = recents
    .filter((ws) => !(ws.project_paths?.length && ws.project_paths.every((path) => openPaths.has(path))))
    .slice(0, 6);

  return (
    <section className="chat-mode-panel empty chat-no-project" aria-label="Chat">
      <div className="chat-no-project-inner">
        <h2 className="chat-mode-empty-heading">Pick a project to chat about</h2>
        <p className="chat-no-project-copy">
          The chat works inside a project: it reads its files, runs commands and starts agents there.
        </p>

        {open.length > 0 && (
          <div className="chat-no-project-list" role="list" aria-label="Projects in this workspace">
            {open.map((project) => (
              <button
                key={project.id}
                type="button"
                role="listitem"
                className="chat-no-project-item"
                onClick={() => switchToProject(project.id)}
              >
                <FolderIcon />
                <span className="chat-no-project-name">{project.name}</span>
                <span className="chat-no-project-path">{shortPath(project.root_path)}</span>
              </button>
            ))}
          </div>
        )}

        {recentRows.length > 0 && (
          <div className="chat-no-project-list" role="list" aria-label="Recent projects">
            <span className="chat-no-project-label">Recent</span>
            {recentRows.map((ws) => (
              <button
                key={ws.id}
                type="button"
                role="listitem"
                className="chat-no-project-item"
                onClick={() => void openWorkspace(ws.id)}
              >
                <FolderIcon />
                <span className="chat-no-project-name">{ws.name}</span>
                <span className="chat-no-project-path">
                  {ws.project_paths?.length ? ws.project_paths.map(shortPath).join(', ') : 'Empty project'}
                </span>
              </button>
            ))}
          </div>
        )}

        <button type="button" className="chat-no-project-open" onClick={() => void openProject()}>
          <FolderIcon />
          <span>Open Project</span>
          <kbd>{formatShortcutLabel('Ctrl+O')}</kbd>
        </button>
      </div>
    </section>
  );
}
