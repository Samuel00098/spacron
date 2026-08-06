import { create } from 'zustand';
import { get } from '$lib/stores/storeCompat';
import { notificationsEnabled } from '../settings';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { isPermissionGranted, requestPermission } from '@tauri-apps/plugin-notification';

export interface Toast {
  id: string;
  message: string;
  type: 'info' | 'success' | 'warning' | 'error';
  duration?: number;
  action?: { label: string; onClick: () => void };
}

interface NotificationState {
  toasts: Toast[];
  showToast: (
    message: string,
    type?: Toast['type'],
    duration?: number,
    notifySystem?: boolean,
    action?: { label: string; onClick: () => void }
  ) => void;
  dismissToast: (id: string) => void;
}

/** Timers for toasts that auto-dismiss, so an early dismiss can cancel them. */
const toastTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Call once on app startup to prompt the user for notification permission. */
export async function requestNotificationPermission() {
  if (!get(notificationsEnabled)) return;

  try {
    const granted = await isPermissionGranted();
    if (!granted) {
      await requestPermission();
    }
  } catch (err) {
    console.error('Failed to initialize notification permission:', err);
  }
}


async function focusCurrentWindow() {
  try {
    const win = getCurrentWindow();
    await win.show();
    await win.unminimize();
    await win.setFocus();
    window.focus();
  } catch (err) {
    console.error('Failed to focus window on notification click:', err);
  }
}

function showBrowserNotification(title: string, message: string) {
  const notification = new window.Notification(title, { body: message });
  notification.onclick = () => {
    void focusCurrentWindow();
    notification.close();
  };
}

/**
 * Show a desktop (system) notification.
 *
 * Re-checks permission on every call — the OS setting can change while the app
 * runs, and a stale `granted` flag silently dropped notifications before. The
 * native command's failure falls back to the Web Notification API.
 */
async function showDesktopNotification(message: string, type: Toast['type']) {
  if (!get(notificationsEnabled)) return;

  try {
    const granted = await isPermissionGranted();
    if (!granted) {
      const res = await requestPermission();
      if (res !== 'granted') return;
    }
  } catch (err) {
    console.error('Failed to read notification permission:', err);
    return;
  }

  const titles: Record<Toast['type'], string> = {
    error: 'Spacron - Error',
    warning: 'Spacron - Warning',
    success: 'Spacron - Done',
    info: 'Spacron',
  };

  try {
    await invoke('notification_show', {
      title: titles[type],
      body: message,
    });
  } catch (err) {
    console.warn('Native notification command failed, falling back to Web Notification:', err);
    showBrowserNotification(titles[type], message);
  }
}

export const useNotificationStore = create<NotificationState>((set, getState) => ({
  toasts: [],

  showToast: (
    message: string,
    type: Toast['type'] = 'info',
    duration?: number,
    notifySystem = false,
    action?: { label: string; onClick: () => void }
  ) => {
    const defaultDuration = type === 'error' ? 6000 : 3000;
    const actualDuration = duration ?? defaultDuration;

    const activeToasts = getState().toasts;
    if (activeToasts.some((t) => t.message === message && t.type === type)) return;

    const id = Math.random().toString(36).substring(2, 9);
    const newToast: Toast = { id, message, type, duration: actualDuration, action };

    set((s) => {
      const next = [...s.toasts, newToast];
      return { toasts: next.length > 5 ? next.slice(next.length - 5) : next };
    });

    if (notifySystem) {
      void showDesktopNotification(message, type);
    }

    if (actualDuration > 0) {
      const timer = setTimeout(() => {
        toastTimers.delete(id);
        getState().dismissToast(id);
      }, actualDuration);
      toastTimers.set(id, timer);
    }
  },

  dismissToast: (id: string) => {
    const timer = toastTimers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      toastTimers.delete(id);
    }
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
}));
