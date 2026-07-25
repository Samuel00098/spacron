import { writable, get } from '$lib/stores/storeCompat';

export interface ConsoleLogEntry {
  id: number;
  level: 'log' | 'info' | 'warn' | 'error' | 'debug';
  message: string;
  url?: string;
  timestamp: string;
}

const MAX_ENTRIES = 500;
let nextId = 1;

export const previewConsoleLogs = writable<ConsoleLogEntry[]>([]);

export function pushConsoleLog(entry: Omit<ConsoleLogEntry, 'id'>): void {
  previewConsoleLogs.update((logs) => {
    const next = [...logs, { ...entry, id: nextId++ }];
    return next.length > MAX_ENTRIES ? next.slice(-MAX_ENTRIES) : next;
  });
}

export function clearConsoleLogs(): void {
  previewConsoleLogs.set([]);
}

export function getConsoleLogs(level?: string, limit?: number): ConsoleLogEntry[] {
  let logs = get(previewConsoleLogs);
  if (level && level !== 'all') {
    logs = logs.filter((l) => l.level === level);
  }
  if (limit) {
    logs = logs.slice(-limit);
  }
  return logs;
}
