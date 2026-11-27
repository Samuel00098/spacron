import { create } from 'zustand';
import type { Update } from '@tauri-apps/plugin-updater';
import { showToast } from '$lib/stores/notification';

export interface UpdateInfo {
  version: string;
  body: string | null;
}

interface UpdaterState {
  pendingUpdate: UpdateInfo | null;
  updateChecking: boolean;
  updateDownloading: boolean;
  updateProgress: number;
  checkForUpdate: () => Promise<void>;
  installUpdate: () => Promise<void>;
}

let cachedUpdate: Update | null = null;

export const useUpdaterStore = create<UpdaterState>((set) => ({
  pendingUpdate: null,
  updateChecking: false,
  updateDownloading: false,
  updateProgress: 0,

  checkForUpdate: async () => {
    // A check mid-download would replace the update being installed.
    if (useUpdaterStore.getState().updateDownloading) return;
    set({ updateChecking: true });
    try {
      const { check } = await import('@tauri-apps/plugin-updater');
      const update = await check();
      cachedUpdate = update ?? null;
      if (update?.available) {
        set({ pendingUpdate: { version: update.version, body: update.body ?? null } });
      } else {
        set({ pendingUpdate: null });
      }
    } catch {
      // Offline now says nothing about the update already found: keep it.
      throw new Error('Failed to check for updates');
    } finally {
      set({ updateChecking: false });
    }
  },

  installUpdate: async () => {
    const { relaunch } = await import('@tauri-apps/plugin-process');

    set({ updateDownloading: true, updateProgress: 0 });

    try {
      const update = cachedUpdate;
      if (!update?.available) return;

      let downloaded = 0;
      let total = 0;

      await update.downloadAndInstall((event) => {
        if (event.event === 'Started') {
          total = event.data.contentLength ?? 0;
        } else if (event.event === 'Progress') {
          downloaded += event.data.chunkLength;
          if (total > 0) set({ updateProgress: Math.round((downloaded / total) * 100) });
        } else if (event.event === 'Finished') {
          set({ updateProgress: 100 });
        }
      });

      set({ pendingUpdate: null });
      await relaunch();
    } catch (e) {
      console.error('Update install failed:', e);
      showToast('Spacron could not install the update. Try again.', 'error', 7000);
    } finally {
      set({ updateDownloading: false });
    }
  },
}));

/** A release can land while the app sits open for days. */
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 5000;

/** Check shortly after launch, then on a timer. Returns a stop function. */
export function startAppUpdateChecks(): () => void {
  const check = () => void useUpdaterStore.getState().checkForUpdate().catch(() => {});
  const first = setTimeout(check, FIRST_CHECK_DELAY_MS);
  const timer = setInterval(check, CHECK_INTERVAL_MS);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
