import { useMemo, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { saveProjectState } from '$lib/stores/workspace';
import { useWorkspaceStore } from '$lib/stores/zustand/workspace';
import {
  homeScreenOpen,
  openQuickCapture,
  RIGHT_DRAWER_TOOLS,
  rightDrawerToolOf,
  rightSidebarVisible,
  setRightDrawerTool,
  setRightSidebarVisible,
  toggleSidebar,
} from '$lib/stores/layout';
import { useLayoutStore } from '$lib/stores/zustand/layout';
import { useSettingsStore } from '$lib/stores/zustand/settings';
import { canGoBack, canGoForward, navigateBack, navigateForward } from '$lib/stores/navigation';
import { isTauriRuntime, restoreWindowToRelativeSize } from '$lib/utils/tauri';
import { useStore } from '$lib/react/useStore';
import { formatShortcutLabel } from '$lib/utils/shortcut-label';
import RemoteStatus from '$lib/components/layout/RemoteStatus';
import InboxBell from '$lib/components/orchestrator/InboxBell';
import { useAppIcon } from '$lib/react/useAppIcon';
import './TitleBar.css';

export default function TitleBar() {
  const win = useMemo(() => (isTauriRuntime() ? getCurrentWindow() : null), []);

  const iconSrc = useAppIcon();

  const [iconError, setIconError] = useState(false);

  // Reactive store reads — the React equivalent of `$store`.
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const goBackEnabled = useStore(canGoBack);
  const goForwardEnabled = useStore(canGoForward);
  // Home is an overlay over the live workspace, so `workspaceId` stays set while
  // it's up. Workspace-scoped tools (switcher, capture, search, settings) key off
  // this instead so they disappear on the welcome screen too.
  const homeOpen = useStore(homeScreenOpen);
  const showWorkspaceTools = Boolean(workspaceId) && !homeOpen;
  const sidebarVisible = useLayoutStore((s) => s.sidebarVisible);
  const rightDrawerTool = useLayoutStore((s) => rightDrawerToolOf(s));
  const rightSidebarOpen = useStore(rightSidebarVisible);

  async function minimize() {
    await win?.minimize();
  }
  async function toggleMaximize() {
    if (!win) return;
    if (await win.isMaximized()) {
      await restoreWindowToRelativeSize();
    } else {
      await win.maximize();
    }
  }
  async function close() {
    const currProjectId = useWorkspaceStore.getState().activeProjectId;
    if (currProjectId) saveProjectState(currProjectId);
    if (!win) return;
    if (useSettingsStore.getState().closeBehavior === 'minimize') {
      await win.minimize();
    } else {
      await win.destroy();
    }
  }

  // Home is an overlay over the live workspace, not a teardown. Nulling
  // `activeWorkspaceId` here used to unmount every room — disposing each xterm
  // and forcing a reattach-by-replay on return, which broke running agents'
  // rendering. Raising the overlay leaves every PTY view mounted and fitted.
  function goHome() {
    const pid = useWorkspaceStore.getState().activeProjectId;
    if (pid) saveProjectState(pid);
    homeScreenOpen.set(true);
  }

  async function goBack() {
    await navigateBack();
  }
  async function goForward() {
    await navigateForward();
  }

  function toggleRightSidebar() {
    if (rightSidebarOpen) {
      setRightSidebarVisible(false);
      setRightDrawerTool(null);
    } else {
      setRightSidebarVisible(true);
      setRightDrawerTool(rightDrawerTool ?? RIGHT_DRAWER_TOOLS[0]);
    }
  }

  return (
    <div className="titlebar" data-tauri-drag-region>
      {/* Brand */}
      <div className="titlebar-brand">
        <div className="titlebar-icon">
          {!iconError ? (
            <img
              src={iconSrc}
              alt="Spacron"
              className="titlebar-app-icon"
              onError={() => setIconError(true)}
            />
          ) : (
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              className="titlebar-app-icon"
              aria-hidden="true"
            >
              <rect width="16" height="16" rx="3.5" fill="#2f343b" />
              <polyline
                points="2.5,10 4.5,8 2.5,6"
                fill="none"
                stroke="#aeb6c2"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <rect x="5.5" y="7.3" width="5" height="1.2" rx="0.6" fill="rgba(255,255,255,0.5)" />
            </svg>
          )}
        </div>
      </div>

      {/* Navigation: Home, sidebar, Back, Forward */}
      <div className="titlebar-nav">
        <button className="nav-btn" onClick={goHome} aria-label="Go to home" title="Home">
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M3 12L12 3l9 9" />
            <path d="M9 21V12h6v9" />
          </svg>
        </button>
        {showWorkspaceTools && (
          <button
            className={`nav-btn sidebar-toggle-btn${sidebarVisible ? ' active' : ''}`}
            onClick={toggleSidebar}
            aria-label={sidebarVisible ? 'Hide left sidebar' : 'Show left sidebar'}
            aria-pressed={sidebarVisible}
            title={sidebarVisible ? 'Hide left sidebar' : 'Show left sidebar'}
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <path d="M9 4v16" />
              <path d="M6 8h1M6 12h1M6 16h1" />
            </svg>
          </button>
        )}
        <button
          className="nav-btn tb-collapse-2"
          onClick={goBack}
          disabled={!goBackEnabled}
          aria-label="Go back"
          title="Back"
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <button
          className="nav-btn tb-collapse-2"
          onClick={goForward}
          disabled={!goForwardEnabled}
          aria-label="Go forward"
          title="Forward"
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
      </div>

      {/* Centre drag region */}
      <div
        className="titlebar-center"
        data-tauri-drag-region
      />

      {/* Right side: Mode switcher + Settings + Window controls */}
      <div className="titlebar-right">

        {showWorkspaceTools && (
          <>
            {/* Right utility drawer toggle. Keep the currently selected tool
                intact when closing and reopen the default drawer tool when
                the drawer is summoned from the titlebar. */}
            <button
              className={`icon-btn sidebar-toggle-btn${rightSidebarOpen ? ' active' : ''}`}
              onClick={toggleRightSidebar}
              aria-label={rightSidebarOpen ? 'Hide right sidebar' : 'Show right sidebar'}
              aria-pressed={rightSidebarOpen}
              title={rightSidebarOpen ? 'Hide right sidebar' : 'Show right sidebar'}
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <rect x="3" y="4" width="18" height="16" rx="2" />
                <path d="M15 4v16" />
                <path d="M17 8h1M17 12h1M17 16h1" />
              </svg>
            </button>

            <button
              className="icon-btn tb-collapse-1"
              onClick={openQuickCapture}
              aria-label="Quick Capture"
              title={`Quick Capture (${formatShortcutLabel('Ctrl+Shift+Space')})`}
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
            </button>

          </>
        )}

        {/* Agent usage is a changing readout rather than a fixed-size titlebar
            action, so it lives in the unified left-sidebar status banner. */}

        {/* Finished agent work and pending decisions remain globally visible. */}
        {showWorkspaceTools && <InboxBell />}

        {/* Connection mode stays in the top-right chrome: it affects the whole
            workspace, not the currently selected Navigator context. */}
        <RemoteStatus dropdownUp={false} />

        {/* Window controls — rendered unconditionally on every OS. The window is
            frameless (decorations:false), so macOS shows no native traffic
            lights and these custom controls are always needed. */}
        <div className="titlebar-controls">
          <button className="wc-btn wc-min" onClick={minimize} aria-label="Minimize" title="Minimize">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <line x1="1" y1="5" x2="9" y2="5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
          <button className="wc-btn wc-max" onClick={toggleMaximize} aria-label="Maximize" title="Maximize">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <rect x="1" y="3" width="7" height="7" rx="1.2" stroke="currentColor" strokeWidth="1.3" />
              <path
                d="M4 3V2a1 1 0 011-1h5a1 1 0 011 1v5a1 1 0 01-1 1H9"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
              />
            </svg>
          </button>
          <button className="wc-btn wc-close" onClick={close} aria-label="Close" title="Close">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
