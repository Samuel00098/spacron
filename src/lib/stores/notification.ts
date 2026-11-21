import { writable } from '$lib/stores/storeCompat';
import { useNotificationStore, type Toast, requestNotificationPermission } from './zustand/notification';

export { requestNotificationPermission };

export const toasts = writable<Toast[]>([]);

// Keep the writable in sync with the Zustand store
useNotificationStore.subscribe((state) => {
  toasts.set(state.toasts);
});


export function showToast(
  messageOrObj: string | { title?: string; message?: string; tone?: string; type?: Toast['type']; duration?: number },
  type: Toast['type'] = 'info',
  duration?: number,
  notifySystem = false,
  action?: { label: string; onClick: () => void },
  explained?: { hint?: string; details?: string }
) {
  let finalMessage: string;
  let finalType = type;
  let finalDuration = duration;

  if (typeof messageOrObj === 'object' && messageOrObj !== null) {
    finalMessage = messageOrObj.title || messageOrObj.message || '';
    if (messageOrObj.tone) {
      finalType = (messageOrObj.tone === 'success' || messageOrObj.tone === 'error' || messageOrObj.tone === 'warning')
        ? messageOrObj.tone
        : 'info';
    } else if (messageOrObj.type) {
      finalType = messageOrObj.type;
    }
    if (messageOrObj.duration !== undefined) {
      finalDuration = messageOrObj.duration;
    }
  } else {
    finalMessage = String(messageOrObj ?? '');
  }

  useNotificationStore.getState().showToast(finalMessage, finalType, finalDuration, notifySystem, action, explained);
}

export function dismissToast(id: string) {
  useNotificationStore.getState().dismissToast(id);
}
