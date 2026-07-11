import { useEffect, lazy, Suspense } from 'react';
import { get } from '$lib/stores/storeCompat';
import { getCurrentWindow } from '@tauri-apps/api/window';
import AppShell from '$lib/components/layout/AppShell.tsx';
import BackgroundMedia from '$lib/components/shared/BackgroundMedia.tsx';
import CommandPalette from '$lib/components/shared/CommandPalette.tsx';
import FloatingSearch from '$lib/components/shared/FloatingSearch.tsx';
import Toasts from '$lib/components/shared/Toasts.tsx';
import QuickCaptureModal from '$lib/components/shared/QuickCaptureModal.tsx';
import AgentSpawnModal from '$lib/components/shared/AgentSpawnModal.tsx';
import WorkspaceNameModal from '$lib/components/shared/WorkspaceNameModal.tsx';
import NewFolderModal from '$lib/components/shared/NewFolderModal.tsx';
import SettingsModal from '$lib/components/shared/SettingsModal.tsx';
import ProjectHUD from '$lib/components/workspace/ProjectHUD.tsx';
import KnowledgeGraphOverlay from '$lib/components/orchestrator/KnowledgeGraphOverlay.tsx';
import AgentNotifications from '$lib/components/orchestrator/AgentNotifications.tsx';
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
  initializeWorkspaces,
  saveProjectState,
  activeProjectId,
} from '$lib/stores/workspace';
import { loadThemes } from '$lib/stores/theme';
import { initDefaultCommands } from '$lib/stores/commandpalette';
import { requestNotificationPermission } from '$lib/stores/notification';
import { maybeAutoReconnectRemote } from '$lib/stores/remoteWorkspace';
import {
  uiZoom,
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
import { isTauriRuntime } from '$lib/utils/tauri';

const ZOOM_LEVELS = [50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200] as const;

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

    let activeShortcuts: KeyboardShortcut[] = [];
    const unsubscribeShortcuts = userShortcuts.subscribe((value) => {
      activeShortcuts = value || [];
    });

    const handleKeyDown = (event: KeyboardEvent) => {
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
      unlistenClose?.();
      unsubscribeShortcuts();
      unsubFrost();
      unsubBgEnabled();
      unsubBgBlur();
    };
  }, []);

  return (
    <>
      <BackgroundMedia />
      <AppShell />

      <CommandPalette />
      <FloatingSearch />
      <ProjectHUD />
      <KnowledgeGraphOverlay />
      <AgentNotifications />
      <Toasts />

      {isSettingsOpen && <SettingsModal onclose={closeSettings} />}

      {isQuickCaptureOpen && <QuickCaptureModal onclose={closeQuickCapture} />}

      {isAgentSpawnOpen && <AgentSpawnModal onclose={closeAgentSpawn} />}

      {isNewWorkspacePromptOpen && <WorkspaceNameModal />}
      {isNewFolderPromptOpen && <NewFolderModal />}

      {!hasCompletedOnboarding && (
        <Suspense fallback={null}>
          <OnboardingWalkthrough />
        </Suspense>
      )}

    </>
  );
}
