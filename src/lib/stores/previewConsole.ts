import { writable, get } from '$lib/stores/storeCompat';

export interface ConsoleLogEntry {
  id: number;
  level: 'log' | 'info' | 'warn' | 'error' | 'debug';
  message: string;
  url?: string;
  timestamp: string;
  /** How many times this exact message repeated back-to-back (browsers collapse
   *  identical consecutive output into one row with a counter). Always >= 1. */
  count: number;
}

const MAX_ENTRIES = 500;
let nextId = 1;

export const previewConsoleLogs = writable<ConsoleLogEntry[]>([]);

export function pushConsoleLog(entry: Omit<ConsoleLogEntry, 'id' | 'count'>): void {
  previewConsoleLogs.update((logs) => {
    // Collapse an identical consecutive message into a repeat counter instead of
    // appending a new row. A dev server that logs the same HMR/warning line on
    // every tick otherwise pushes everything else out of the 500-entry window.
    const last = logs[logs.length - 1];
    if (last && last.level === entry.level && last.message === entry.message && last.url === entry.url) {
      const next = logs.slice(0, -1);
      next.push({ ...last, count: last.count + 1, timestamp: entry.timestamp });
      return next;
    }
    const next = [...logs, { ...entry, id: nextId++, count: 1 }];
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
