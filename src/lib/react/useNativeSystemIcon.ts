import { useEffect } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { isTauriRuntime } from '$lib/utils/tauri';
import { useSystemIcon } from './useSystemIcon';

export function useNativeSystemIcon() {
  const source = useSystemIcon();
  useEffect(() => {
    if (!isTauriRuntime()) return;
    const abort = new AbortController();
    // Pass PNG bytes: setIcon's string argument is a filesystem path, not a URL.
    void fetch(source, { signal: abort.signal })
      .then(response => {
        if (!response.ok) throw new Error(`Icon request failed: ${response.status}`);
        return response.arrayBuffer();
      })
      .then(bytes => {
        if (!abort.signal.aborted) return getCurrentWindow().setIcon(new Uint8Array(bytes));
      })
      .catch(error => {
        if (!abort.signal.aborted) console.warn('Unable to update system-themed icon', error);
      });
    return () => abort.abort();
  }, [source]);
}
