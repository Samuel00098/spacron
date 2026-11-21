import type { TerminalChatItem } from '$lib/services/terminal-chat';

/**
 * Groups the tool calls still in flight by what they are, using only what every
 * adapter already reports (`toolName`, `toolInput`, `toolStatus`). No protocol
 * here lists background shells or monitors, so a row is always a tool call the
 * provider said is running — never an invented one. Provider-agnostic on purpose:
 * Claude, Codex, ACP agents and Pi all emit the same item shape.
 */
export type RunningToolGroupKind = 'shell' | 'edit' | 'web' | 'other';

export interface RunningToolRow {
  id: string;
  name: string;
  /** The command, path or URL, when the input carries one. */
  detail: string;
  /** Claude's Bash tool can ask to run detached; shown so the user knows why it lingers. */
  detached: boolean;
}

export interface RunningToolGroup {
  kind: RunningToolGroupKind;
  label: string;
  rows: RunningToolRow[];
}

const LABELS: Record<RunningToolGroupKind, string> = {
  shell: 'Shell',
  edit: 'File edits',
  web: 'Web',
  other: 'Tools',
};

const ORDER: RunningToolGroupKind[] = ['shell', 'edit', 'web', 'other'];

export function toolKind(name: string | null | undefined): RunningToolGroupKind {
  const n = (name ?? '').toLowerCase();
  if (/(^|[^a-z])(bash|shell|exec|command|terminal|powershell|run_terminal)/.test(n)) return 'shell';
  if (/(edit|write|patch|apply|replace|create_file|notebook)/.test(n)) return 'edit';
  if (/(web|fetch|search|browse|http|url)/.test(n)) return 'web';
  return 'other';
}

function parseInput(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function pickString(input: Record<string, unknown> | null, keys: string[]): string {
  if (!input) return '';
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (Array.isArray(value) && value.every((part) => typeof part === 'string') && value.length) return (value as string[]).join(' ');
  }
  return '';
}

export function runningToolRow(item: TerminalChatItem): RunningToolRow {
  const input = parseInput(item.toolInput);
  const detail = pickString(input, ['command', 'cmd', 'file_path', 'path', 'filePath', 'url', 'query', 'pattern', 'description']);
  return {
    id: item.id,
    name: item.toolName ?? 'tool',
    detail: detail.length > 160 ? `${detail.slice(0, 157)}…` : detail,
    detached: input?.run_in_background === true,
  };
}

export function groupRunningTools(items: readonly TerminalChatItem[]): RunningToolGroup[] {
  const buckets = new Map<RunningToolGroupKind, RunningToolRow[]>();
  for (const item of items) {
    if (item.kind !== 'tool' || item.toolStatus !== 'running') continue;
    const kind = toolKind(item.toolName);
    const rows = buckets.get(kind) ?? [];
    rows.push(runningToolRow(item));
    buckets.set(kind, rows);
  }
  return ORDER.filter((kind) => buckets.has(kind)).map((kind) => ({ kind, label: LABELS[kind], rows: buckets.get(kind)! }));
}
