import { useState, useEffect, useMemo, useRef, Suspense, lazy } from 'react';
import { useStore } from '$lib/react/useStore';
import { useWorkspaceStore } from '$lib/stores/zustand/workspace';
import { openProject, switchToProject } from '$lib/stores/workspace';
import { getProjectChat } from '$lib/stores/orchestrator';
import { openFile } from '$lib/stores/editor';
import { showToast } from '$lib/stores/notification';
import { usePinnedStore } from '$lib/stores/zustand/pinned';
import { getSessionOutputBuffer } from '$lib/stores/terminal';
import { invoke } from '@tauri-apps/api/core';

// ── icons & subcomponents ───────────────────────────────────────────────────
import FlowCard from '$lib/components/orchestrator/FlowCard.tsx';
import FloatingPromptBar from '$lib/components/terminal/FloatingPromptBar.tsx';
import './FlowAppShell.css';

// ── lazy-loaded IDE panels for overlay ────────────────────────────────────────
const EditorPanel = lazy(() => import('$lib/components/editor/EditorPanel.tsx'));
const TerminalPanel = lazy(() => import('$lib/components/terminal/TerminalPanel.tsx'));
const PreviewPanel = lazy(() => import('$lib/components/preview/PreviewPanelLazy.tsx'));

export default function FlowAppShell() {
  const projectsMap = useWorkspaceStore((s: any) => s.projects);
  const activeProjId = useWorkspaceStore((s: any) => s.activeWorkspaceId) || useWorkspaceStore((s: any) => s.activeProjectId) || '';
  const projectsList = useMemo(() => Array.from(projectsMap.values() as IterableIterator<any>), [projectsMap]);
  const activeProject = useMemo(() => projectsMap.get(activeProjId) || projectsList[0] || null, [projectsMap, activeProjId, projectsList]);
  const projectId = activeProject?.id ?? '';

  // Chat message store
  const chatStore = useMemo(() => getProjectChat(projectId), [projectId]);
  const messages = useStore(chatStore);

  // Layout overlay view state
  const [overlayView, setOverlayView] = useState<'editor' | 'terminal' | 'preview' | null>(null);
  const [overlayArg, setOverlayArg] = useState<any>(null);

  // Pinned store
  const pinnedCards = usePinnedStore((s) => s.pinnedCards);
  const unpinCard = usePinnedStore((s) => s.unpinCard);

  // Auto scroll bottom
  const streamScrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = streamScrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages?.length]);

  // Keyboard navigation: Escape key closes the overlay
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOverlayView(null);
        setOverlayArg(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Add flow-theme-active class to body for body::after blooms
  useEffect(() => {
    document.body.classList.add('flow-theme-active');
    return () => document.body.classList.remove('flow-theme-active');
  }, []);

  const handleExpand = async (type: 'editor' | 'terminal' | 'preview', arg: any) => {
    if (type === 'editor' && typeof arg === 'string' && activeProject) {
      // Set active file and open editor
      const absPath = `${activeProject.root_path}/${arg}`;
      try {
        await openFile(absPath);
      } catch (e) {
        console.error('Failed to open file in editor:', e);
      }
    }
    setOverlayView(type);
    setOverlayArg(arg);
  };

  const handleApproveDiff = async (filePath: string) => {
    if (!projectId) return;
    try {
      await invoke('workspace_git_commit', {
        projectId,
        message: `Approve edits to ${filePath.split('/').pop()}`,
        files: [filePath],
      });
      showToast('File changes approved and committed!', 'success');
    } catch (err) {
      showToast(String(err) || 'Failed to approve changes', 'error');
    }
  };

  const handleTweakDiff = async (filePath: string) => {
    if (!activeProject) return;
    const absPath = `${activeProject.root_path}/${filePath}`;
    try {
      await openFile(absPath);
      setOverlayView('editor');
    } catch (e) {
      showToast('Failed to open file in editor', 'error');
    }
  };

  return (
    <div className="flow-shell">
      {/* Top Bar */}
      <header className="flow-top">
        <div className="lights"><i></i><i></i><i></i></div>
        <div className="brand"><span className="mark"></span> Spacron</div>
        <div className="meta">
          <span>🔑 <b>your key</b></span>
          <span>🎙 offline voice</span>
          <span><b>own it once</b></span>
        </div>
      </header>

      <div className="flow-body-grid">
        {/* Left Column: Threads / Projects */}
        <aside className="flow-threads">
          <div className="section-title">Threads</div>
          <div className="list">
            {projectsList.map((p: any) => {
              const isActive = p.id === projectId;
              return (
                <div
                  key={p.id}
                  className={`flow-thread-item${isActive ? ' active' : ''}`}
                  onClick={() => switchToProject(p.id)}
                >
                  <div className="avatar">{p.name[0]?.toUpperCase()}</div>
                  <div className="tx">
                    <div className="name">
                      {p.name}
                      {isActive && <span className="live-indicator"></span>}
                    </div>
                    <div className="last-msg">Active project workspace</div>
                  </div>
                </div>
              );
            })}
          </div>
        </aside>

        {/* Center Column: The Flow Stream */}
        <main className="flow-center">
          <div className="flow-center-header">
            <div>
              <div className="t">{activeProject?.name || 'No active project'}</div>
              <div className="s">Flow active</div>
            </div>
            <div className="active-agents">
              <span className="agent-mini-av">A</span>
              <span className="agent-mini-av">W</span>
            </div>
          </div>

          <div className="flow-stream-scroll" ref={streamScrollRef}>
            {messages?.length === 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--flow-faint)', gap: '12px' }}>
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
                <div style={{ fontSize: '14px', maxWidth: '360px', textAlign: 'center' }}>
                  Ask me about your project, tell me to open files, or describe what to build — I'll handle it.
                </div>
              </div>
            ) : (
              messages.map((msg) => (
                <FlowCard
                  key={msg.id}
                  msg={msg}
                  projectId={projectId}
                  onExpand={handleExpand}
                  onApproveDiff={() => msg.completion?.taskTitle && handleApproveDiff(msg.completion.taskTitle)}
                  onTweakDiff={() => msg.completion?.taskTitle && handleTweakDiff(msg.completion.taskTitle)}
                />
              ))
            )}
          </div>

          {/* Integrated Prompt Bar at bottom of Flow stream */}
          <div className="flow-layout">
            <FloatingPromptBar />
          </div>
        </main>

        {/* Right Column: Pinned Columns */}
        <aside className="flow-pinned">
          <div className="section-title">
            <span>Pinned</span>
            {pinnedCards.length > 0 && <span className="n">{pinnedCards.length}</span>}
          </div>
          <div className="wrap">
            {pinnedCards.length === 0 ? (
              <div className="empty-state">
                Nothing pinned yet.<br /><br />
                Hit <b>⌖ Pin</b> on any card — a terminal, a preview — to keep it <b>here beside you</b> while the flow keeps moving.
              </div>
            ) : (
              pinnedCards.map((card) => (
                <div key={card.id} className="ptile">
                  <div className="pth">
                    <span className="dot"></span>
                    <span>{card.label}</span>
                    <button className="x" onClick={() => unpinCard(card.id)}>✕</button>
                  </div>
                  <div className="ptb" style={{ padding: '8px' }}>
                    {card.type === 'prev' && (
                      <div style={{ color: 'var(--flow-dim)', fontSize: '11px', textAlign: 'center', padding: '10px 0' }}>
                        Preview server ready: <a href={card.data.url} target="_blank" rel="noreferrer" style={{ color: 'var(--flow-sage)', textDecoration: 'underline' }}>{card.data.url}</a>
                      </div>
                    )}
                    {card.type === 'term' && (
                      <div style={{ fontSize: '10.5px', fontFamily: 'monospace', color: '#bcae97', maxHeight: '100px', overflow: 'auto', whiteSpace: 'pre-wrap' }}>
                        {getSessionOutputBuffer(card.data.sessionId).split('\n').slice(-6).join('\n') || 'Terminal active...'}
                      </div>
                    )}
                    {card.type === 'diff' && (
                      <div style={{ fontSize: '10.5px', fontFamily: 'monospace', color: '#9bc59b', padding: '4px' }}>
                        Modified: {card.data.filePath}
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </aside>
      </div>

      {/* Full Screen Overlay Sheet */}
      {overlayView && (
        <div className="flow-overlay" onClick={(e) => e.target === e.currentTarget && setOverlayView(null)}>
          <div className="flow-sheet">
            <div className="sh">
              ◆ <b style={{ color: 'var(--flow-cream)' }}>&nbsp;{overlayView.toUpperCase()} — Spacron Workspace</b>
              <button className="x" onClick={() => { setOverlayView(null); setOverlayArg(null); }}>✕ esc</button>
            </div>
            <div className="sx">
              <Suspense fallback={<div style={{ display: 'grid', placeItems: 'center', height: '100%', color: 'var(--flow-dim)' }}>Loading pane...</div>}>
                {overlayView === 'editor' && <EditorPanel />}
                {overlayView === 'terminal' && <TerminalPanel />}
                {overlayView === 'preview' && <PreviewPanel />}
              </Suspense>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
