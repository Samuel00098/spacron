/**
 * Agent session history (Orca's "Agent Session History"): a list of past
 * sessions read from each CLI's own transcripts. The Rust side
 * (`agent_history.rs`) only indexes; everything about what to show and how to
 * resume lives here. Spacron owns none of this data.
 */
import { invoke } from '@tauri-apps/api/core';
import { resumeArgs, type TranscriptAgent } from '$lib/services/terminal-chat';

export type HistoryAgent = 'claude' | 'codex' | 'opencode';

export interface HistoryRow {
  agent: HistoryAgent;
  /** The id the CLI resumes by. */
  id: string;
  title: string;
  firstPrompt: string;
  cwd: string | null;
  branch: string | null;
  model: string | null;
  /** Real prompts and replies; 0 also means "too large to count". */
  messageCount: number;
  createdMs: number;
  updatedMs: number;
  logPath: string | null;
  /** The managed account that owns the session; null for the CLI's own home. */
  account: string | null;
  /** Human label / email for the account that ran this session, when known. */
  accountLabel?: string | null;
}

export const HISTORY_AGENTS: { id: HistoryAgent; label: string; command: string }[] = [
  { id: 'claude', label: 'Claude', command: 'claude' },
  { id: 'codex', label: 'Codex', command: 'codex' },
  { id: 'opencode', label: 'OpenCode', command: 'opencode' },
];

export type HistoryScope = 'project' | 'all';
export type HistoryGroup = 'project' | 'folder' | 'agent' | 'account';
export type HistorySort = 'updated' | 'created';

export interface HistoryFilter {
  scope: HistoryScope;
  /** The project's checkout plus its worktrees; only used for the project scope. */
  roots: string[];
  agents: readonly HistoryAgent[];
  query: string;
  hideEmpty: boolean;
  sort: HistorySort;
}

export async function loadAgentHistory(limit = 400): Promise<HistoryRow[]> {
  return invoke<HistoryRow[]>('agent_history_list', { query: { limit } });
}

function normalizePath(path: string): string {
  // Windows paths are case-insensitive and may use either slash; the CLIs
  // disagree about both (Claude writes `C:\x`, OpenCode `C:/x`).
  return path.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export function isInside(path: string | null, roots: readonly string[]): boolean {
  if (!path) return false;
  const p = normalizePath(path);
  return roots.some((root) => {
    const r = normalizePath(root);
    return r !== '' && (p === r || p.startsWith(`${r}/`));
  });
}

/**
 * Best human-facing label for the account that ran this session.
 * Returns the account email or label for agents that support accounts (Claude, Codex).
 * Returns null for agents that do not support accounts (e.g. OpenCode) or when unknown.
 */
export function sessionAccountLabel(
  row: HistoryRow,
  knownAccounts?: readonly { provider: string; id: string; label: string }[],
): string | null {
  // Only agents that support accounts
  if (row.agent !== 'claude' && row.agent !== 'codex') return null;

  // 1. Backend-resolved label (e.g. email)
  if (row.accountLabel && row.accountLabel.trim()) {
    const trimmed = row.accountLabel.trim();
    if (trimmed !== 'Default account') return trimmed;
  }

  // 2. Lookup in known frontend accounts
  if (knownAccounts && knownAccounts.length > 0) {
    const targetId = row.account ?? 'default';
    const match = knownAccounts.find((a) => a.provider === row.agent && a.id === targetId);
    if (match?.label && match.label.trim() && match.label.trim() !== 'Default account') {
      return match.label.trim();
    }
  }

  // 3. Fallback to row.account if it's an email or slug
  if (row.account && row.account.trim()) {
    return row.account.trim();
  }

  // 4. If row.accountLabel was "Default account" and we have no email, return "Default account"
  if (row.accountLabel && row.accountLabel.trim()) {
    return row.accountLabel.trim();
  }

  return null;
}

/** One line to name a session by: the CLI's own title, else what was asked. */
export function rowTitle(row: HistoryRow): string {
  const raw = (row.title.trim() || row.firstPrompt.trim()).split(/\r?\n/)[0].trim();
  if (!raw) return 'Untitled session';
  return raw.length > 90 ? `${raw.slice(0, 89)}…` : raw;
}

export function folderName(path: string | null): string {
  if (!path) return 'Unknown folder';
  const parts = path.replace(/\\/g, '/').replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || path;
}

export function filterHistory(rows: readonly HistoryRow[], filter: HistoryFilter): HistoryRow[] {
  const q = filter.query.trim().toLowerCase();
  const out = rows.filter((row) => {
    if (!filter.agents.includes(row.agent)) return false;
    if (filter.hideEmpty && row.messageCount === 0) return false;
    if (filter.scope === 'project' && !isInside(row.cwd, filter.roots)) return false;
    if (!q) return true;
    return [
      row.title,
      row.firstPrompt,
      row.cwd,
      row.branch,
      row.model,
      row.account,
      row.accountLabel,
      row.id,
    ].some((field) => field?.toLowerCase().includes(q));
  });
  const key = filter.sort === 'created' ? 'createdMs' : 'updatedMs';
  return out.sort((a, b) => b[key] - a[key]);
}

export interface HistoryGroupBlock {
  key: string;
  label: string;
  rows: HistoryRow[];
}

/** A Spacron project, for grouping sessions by the project they ran in. */
export interface HistoryProject {
  name: string;
  /** The checkout plus its worktrees. */
  roots: string[];
}

export function groupHistory(
  rows: readonly HistoryRow[],
  group: HistoryGroup,
  projects: readonly HistoryProject[] = [],
  knownAccounts?: readonly { provider: string; id: string; label: string }[],
): HistoryGroupBlock[] {
  const blocks = new Map<string, HistoryGroupBlock>();
  for (const row of rows) {
    let key: string;
    let label: string;
    if (group === 'agent') {
      key = row.agent;
      label = HISTORY_AGENTS.find((a) => a.id === row.agent)?.label ?? row.agent;
    } else if (group === 'account') {
      const acct = sessionAccountLabel(row, knownAccounts);
      key = acct ? `account:${acct}` : 'account:none';
      label = acct ?? 'No account';
    } else if (group === 'project') {
      // A Spacron project when the folder belongs to one; otherwise the folder itself,
      // so "All" reads as one group per project or folder rather than an "Other" heap.
      const project = projects.find((p) => isInside(row.cwd, p.roots));
      key = project ? `project:${project.name}` : `folder:${normalizePath(row.cwd ?? '')}`;
      label = project?.name ?? folderName(row.cwd);
    } else {
      key = normalizePath(row.cwd ?? '');
      label = folderName(row.cwd);
    }
    const block = blocks.get(key) ?? { key, label, rows: [] };
    block.rows.push(row);
    blocks.set(key, block);
  }
  // Groups keep the order of their newest row.
  return [...blocks.values()];
}

/** The shell command that resumes this session in its own folder. */
export function resumeCommand(row: HistoryRow): string {
  const command = HISTORY_AGENTS.find((a) => a.id === row.agent)?.command ?? row.agent;
  return `${command} ${resumeArgs(row.agent as TranscriptAgent, row.id)}`.trim();
}

export function timeAgo(ms: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - ms) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `${days}d ago` : new Date(ms).toLocaleDateString();
}
