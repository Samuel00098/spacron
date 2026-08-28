import { useEffect, lazy, Suspense } from 'react';
import { get } from '$lib/stores/storeCompat';
import { getCurrentWindow } from '@tauri-apps/api/window';
import AppShell from '$lib/components/layout/AppShell.tsx';
import CommandPalette from '$lib/components/shared/CommandPalette.tsx';
import FloatingSearch from '$lib/components/shared/FloatingSearch.tsx';
import Toasts from '$lib/components/shared/Toasts.tsx';
import QuickCaptureModal from '$lib/components/shared/QuickCaptureModal.tsx';
import AgentSpawnModal from '$lib/components/shared/AgentSpawnModal.tsx';
import AgentPlacementModal from '$lib/components/shared/AgentPlacementModal.tsx';
import WorkspaceNameModal from '$lib/components/shared/WorkspaceNameModal.tsx';
import NewFolderModal from '$lib/components/shared/NewFolderModal.tsx';
import CloneRepoModal from '$lib/components/shared/CloneRepoModal.tsx';
import SettingsModal from '$lib/components/shared/SettingsModal.tsx';
import AgentNotifications from '$lib/components/orchestrator/AgentNotifications.tsx';
import InboxPanel from '$lib/components/orchestrator/InboxPanel.tsx';
import UsageCounter from '$lib/components/usage/UsageCounter.tsx';
import UsagePanel from '$lib/components/usage/UsagePanel.tsx';
import { useStore } from '$lib/react/useStore';
import {
  settingsOpen,
  closeSettings,
  quickCaptureOpen,
  closeQuickCapture,
  agentSpawnOpen,
  closeAgentSpawn,
} from '$lib/stores/layout';
import {
  newWorkspacePromptOpen,
  newFolderPromptOpen,
  cloneRepoPromptOpen,
  initializeWorkspaces,
  saveProjectState,
  activeProjectId,
} from '$lib/stores/workspace';
import { loadThemes } from '$lib/stores/theme';
import { initDefaultCommands } from '$lib/stores/commandpalette';
import { requestNotificationPermission } from '$lib/stores/notification';
import { maybeAutoReconnectRemote, hydrateRemoteTokens } from '$lib/stores/remoteWorkspace';
import {
  uiZoom,
  fontSize,
  resolvedFontFamily,
  userShortcuts,
  matchShortcut,
  type KeyboardShortcut,
  onboardingCompleted,
  reconcileOnboardingFlag,
  backgroundImageEnabled,
  interfaceTransparency,
  backgroundImageBlur,
  closeBehavior,
} from '$lib/stores/settings';
import {
  initBackground,
  applyBackgroundImage,
  applyInterfaceFrost,
  applyBackgroundAppearance,
} from '$lib/stores/background';
import { initNavigationHistory } from '$lib/stores/navigation';
import { initApiKeyCache } from '$lib/services/ai-keychain';
import { initMcpBridge } from '$lib/stores/mcpBridge';
import { ensureWindowUsable, isTauriRuntime } from '$lib/utils/tauri';
import { isModalOpen } from '$lib/react/useModalFocus';

const ZOOM_LEVELS = [50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200] as const;

/**
 * How long quitting will wait for agent worktrees to be reclaimed before
 * closing anyway. Generous enough for a few `git apply` round-trips, short
 * enough that quit never feels stuck; the next project load sweeps the rest.
 */
const EXIT_RECLAIM_BUDGET_MS = 4_000;

const OnboardingWalkthrough = lazy(() => import('$lib/components/workspace/OnboardingWalkthrough.tsx'));

function zoomIn() {
  uiZoom.update((z) => {
    const next = ZOOM_LEVELS.find((level) => level > z);
    return next ?? z;
  });
}

function zoomOut() {
  uiZoom.update((z) => {
    const next = [...ZOOM_LEVELS].reverse().find((level) => level < z);
    return next ?? z;
  });
}

export default function App() {
  const isSettingsOpen = useStore(settingsOpen);
  const isQuickCaptureOpen = useStore(quickCaptureOpen);
  const isAgentSpawnOpen = useStore(agentSpawnOpen);
  const isNewWorkspacePromptOpen = useStore(newWorkspacePromptOpen);
  const isNewFolderPromptOpen = useStore(newFolderPromptOpen);
  const isCloneRepoPromptOpen = useStore(cloneRepoPromptOpen);
  const hasCompletedOnboarding = useStore(onboardingCompleted);

  useEffect(() => {
    if (isTauriRuntime()) {
      initApiKeyCache();
      loadThemes();
      initBackground();
      reconcileOnboardingFlag();
    }

    initializeWorkspaces();
    initDefaultCommands();
    if (isTauriRuntime()) {
      requestNotificationPermission();
      // A restarted Windows dev window can occasionally be restored at a
      // tiny native size (visible to the OS, but effectively hidden). Recover
      // only that invalid geometry and leave normal user sizing untouched.
      void ensureWindowUsable();
      initMcpBridge();
      // Tokens live in the OS keychain; load them into session memory so the
      // remote manager can prefill edit forms and reconnect without waiting.
      void hydrateRemoteTokens();
      // Opt-in: if a remote is flagged to reconnect on startup, dial it so a
      // workspace whose agents are still running on the box comes back on its own.
      // Fails fast + rolls back to Local if the box is offline, so this can't hang boot.
      void maybeAutoReconnectRemote();
    }
    initNavigationHistory();

    const unsubFrost = interfaceTransparency.subscribe((value) => {
      applyInterfaceFrost(value);
    });

    const unsubBgEnabled = backgroundImageEnabled.subscribe(() => applyBackgroundImage());

    let bgAppearanceRuns = 0;
    const applyAppearanceLive = () => {
      if (bgAppearanceRuns < 2) {
        bgAppearanceRuns += 1;
        return;
      }
      applyBackgroundAppearance(get(backgroundImageBlur));
    };
    const unsubBgBlur = backgroundImageBlur.subscribe(applyAppearanceLive);

    let unlistenClose: (() => void) | undefined;
    if (isTauriRuntime()) {
      const win = getCurrentWindow();
      win
        .onCloseRequested(async (event) => {
          const projectId = get(activeProjectId);
          if (projectId) saveProjectState(projectId);

          if (get(closeBehavior) === 'minimize') {
            event.preventDefault();
            await win.minimize();
            return;
          }

          // Reclaim agent worktrees so quitting doesn't leave checkouts behind
          // in `.spacron/worktrees/`. Each one is staged onto its branch first,
          // and anything git says still holds work is kept — see
          // `reclaimProjectWorktrees`.
          //
          // Bounded, because quit must not hang on a slow or locked git repo.
          // Whatever this run doesn't finish is swept on the next project load,
          // so being cut off is safe rather than lossy.
          if (projectId) {
            event.preventDefault();
            try {
              const { reclaimProjectWorktrees } = await import('$lib/stores/orchestrator');
              await Promise.race([
                reclaimProjectWorktrees(projectId),
                new Promise((resolve) => setTimeout(resolve, EXIT_RECLAIM_BUDGET_MS)),
              ]);
            } catch (e) {
              console.error('Worktree reclaim on exit failed:', e);
            }
            await win.destroy();
          }
        })
        .then((unlisten) => {
          unlistenClose = unlisten;
        });
    }

    const handleScroll = () => {
      if (window.scrollX !== 0 || window.scrollY !== 0) {
        window.scrollTo(0, 0);
      }
    };
    window.addEventListener('scroll', handleScroll, { passive: true });

    const unsubscribeZoom = uiZoom.subscribe((zoom) => {
      document.documentElement.style.setProperty('--ui-zoom-percent', `${zoom}`);
    });

    // Publish the editor typeface globally. Plenty of surfaces outside the
    // editor render code (diffs, problems, the source-control panel) and already
    // ask for `var(--editor-font-family)` — but CodeEditor only sets it inline on
    // its own container, so every one of them silently fell back to plain
    // `monospace` at whatever hardcoded size it picked. Setting both vars on the
    // root is what makes those existing references resolve.
    const unsubscribeFontSize = fontSize.subscribe((size) => {
      document.documentElement.style.setProperty('--editor-font-size', `${size}px`);
    });
    const unsubscribeFontFamily = resolvedFontFamily.subscribe((family) => {
      document.documentElement.style.setProperty('--editor-font-family', family);
    });

    let activeShortcuts: KeyboardShortcut[] = [];
    const unsubscribeShortcuts = userShortcuts.subscribe((value) => {
      activeShortcuts = value || [];
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (isModalOpen()) return;
      const zoomInShortcut = activeShortcuts.find((shortcut) => shortcut?.id === 'zoomIn');
      const zoomOutShortcut = activeShortcuts.find((shortcut) => shortcut?.id === 'zoomOut');
      const resetZoomShortcut = activeShortcuts.find((shortcut) => shortcut?.id === 'resetZoom');

      if (zoomInShortcut && matchShortcut(event, zoomInShortcut.keys)) {
        event.preventDefault();
        zoomIn();
      } else if (zoomOutShortcut && matchShortcut(event, zoomOutShortcut.keys)) {
        event.preventDefault();
        zoomOut();
      } else if (resetZoomShortcut && matchShortcut(event, resetZoomShortcut.keys)) {
        event.preventDefault();
        uiZoom.set(100);
      }
    };
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('scroll', handleScroll);
      window.removeEventListener('keydown', handleKeyDown);
      unsubscribeZoom();
      unsubscribeFontSize();
      unsubscribeFontFamily();
      unlistenClose?.();
      unsubscribeShortcuts();
      unsubFrost();
      unsubBgEnabled();
      unsubBgBlur();
    };
  }, []);

  return (
    <>
      <AppShell />

      <CommandPalette />
      <FloatingSearch />
      <AgentNotifications />
      <InboxPanel />
      {/* Bottom-left corner dock + the popover it opens above itself. Both are
          siblings of `.app-shell` so they float over the workspace instead of
          reserving a strip of it. */}
      <UsageCounter />
      <UsagePanel />
      <Toasts />

      {isSettingsOpen && <SettingsModal onclose={closeSettings} />}

      {isQuickCaptureOpen && <QuickCaptureModal onclose={closeQuickCapture} />}

      {isAgentSpawnOpen && <AgentSpawnModal onclose={closeAgentSpawn} />}

      {/* Layers over the spawn modal — every spawn path (manual or orchestrator)
          routes its "worktree or main repo?" question through this one host. */}
      <AgentPlacementModal />

      {isNewWorkspacePromptOpen && <WorkspaceNameModal />}
      {isNewFolderPromptOpen && <NewFolderModal />}
      {isCloneRepoPromptOpen && <CloneRepoModal />}

      {!hasCompletedOnboarding && (
        <Suspense fallback={null}>
          <OnboardingWalkthrough />
        </Suspense>
      )}

    </>
  );
}
