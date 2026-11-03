import { get, writable } from '$lib/stores/storeCompat';
import { loadJson } from '$lib/utils/storage';

const STORAGE_KEY = 'spacron_acp_registry_settings';

type AcpSettings = {
  disabledCommands: string[];
  enabled?: boolean;
};

const initial = loadJson<AcpSettings>(STORAGE_KEY, { disabledCommands: [], enabled: true });
export const acpRegistryEnabled = writable(initial.enabled !== false);
export const acpDisabledCommands = writable<string[]>(Array.isArray(initial.disabledCommands) ? initial.disabledCommands : []);

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      enabled: get(acpRegistryEnabled),
      disabledCommands: get(acpDisabledCommands),
    }));
  } catch {}
}

acpRegistryEnabled.subscribe(persist);
acpDisabledCommands.subscribe(persist);

export function isAcpEnabled(command: string): boolean {
  const normalized = command.trim().toLowerCase();
  return get(acpRegistryEnabled) && !get(acpDisabledCommands).includes(normalized);
}

export function setAcpCommandEnabled(command: string, enabled: boolean): void {
  const normalized = command.trim().toLowerCase();
  if (!normalized) return;
  acpDisabledCommands.update((commands) => {
    const next = new Set(commands);
    if (enabled) next.delete(normalized);
    else next.add(normalized);
    return [...next];
  });
}
