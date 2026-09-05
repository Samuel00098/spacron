import { useSyncExternalStore } from 'react';

// Independent of Spacron's workspace theme: branding follows the OS preference.
const query = '(prefers-color-scheme: light)';
const subscribe = (notify: () => void) => {
  if (typeof window.matchMedia !== 'function') return () => {};
  const media = window.matchMedia(query);
  media.addEventListener('change', notify);
  return () => media.removeEventListener('change', notify);
};
const snapshot = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  ? window.matchMedia(query).matches : false;

export function useSystemIcon() {
  const light = useSyncExternalStore(subscribe, snapshot, () => false);
  return `/icon${light ? '-dark' : ''}.png?v=system-1`;
}
