import { writable, derived } from '$lib/stores/storeCompat';
import { loadJson } from '$lib/utils/storage';
import { getCustomAgents, getRemovedPresetAgents } from '$lib/stores/customAgents';

export interface QuickRun {
  id: string;
  name: string;
  command: string;
  projectId: string;
  isPreset?: boolean;
  // True for entries that launch a coding CLI agent (built-in or user-defined),
  // as opposed to plain run commands like "npm run dev". The spawn picker shows
  // only these.
  isAgent?: boolean;
}

const STORAGE_KEY = 'spacron_runs';

function load(): QuickRun[] {
  return loadJson(STORAGE_KEY, [] as QuickRun[]);
}

export const quickRuns = writable<QuickRun[]>(load());

const AI_AGENT_PRESETS: Omit<QuickRun, 'id' | 'projectId'>[] = [
  { name: 'Codex CLI', command: 'codex', isPreset: true, isAgent: true },
  { name: 'Claude Code', command: 'claude', isPreset: true, isAgent: true },
  { name: 'Antigravity', command: 'agy', isPreset: true, isAgent: true },
  { name: 'OpenCode', command: 'opencode', isPreset: true, isAgent: true },
  { name: 'Pi AI Agent', command: 'pi', isPreset: true, isAgent: true },
  // `cursor-agent`, not the bare `agent` Cursor also installs: other CLIs ship
  // their own `agent` shim (the Grok CLI drops one in `~/.grok/bin`), and
  // whichever lands earlier on PATH wins — which silently launched Grok from
  // the Cursor tile. `cursor-agent` is unambiguous.
  { name: 'Cursor', command: 'cursor-agent', isPreset: true, isAgent: true },
  { name: 'Hermes Agent', command: 'hermes', isPreset: true, isAgent: true },
  { name: 'Grok CLI', command: 'grok', isPreset: true, isAgent: true },
  { name: 'Dev Server', command: 'npm run dev', isPreset: true },
];

/**
 * Every coding agent this install can launch, as `{ command, name }`.
 *
 * Project-independent, unlike `getPresetRuns`, and excludes non-agent presets
 * like "Dev Server". This is the roster handed to the MCP server so a delegating
 * agent can discover what is really available — including the user's own custom
 * agents — instead of guessing from a hardcoded list.
 */
export function getAgentRoster(): { command: string; name: string }[] {
  const removed = getRemovedPresetAgents();
  const builtins = AI_AGENT_PRESETS.filter(
    (preset) => preset.isAgent && !removed.includes(preset.command)
  ).map((preset) => ({ command: preset.command, name: preset.name }));
  const custom = getCustomAgents().map((agent) => ({
    command: agent.command,
    name: agent.name,
  }));
  return [...builtins, ...custom];
}

export function getPresetRuns(projectId: string): QuickRun[] {
  if (!projectId) return [];
  const removed = getRemovedPresetAgents();
  const builtins: QuickRun[] = AI_AGENT_PRESETS
    .filter((preset) => !preset.isAgent || !removed.includes(preset.command))
    .map((preset) => ({
      id: `preset:${projectId}:${preset.command}`,
      projectId,
      name: preset.name,
      command: preset.command,
      isPreset: true,
      isAgent: preset.isAgent,
    }));
  // User-defined coding CLI agents are first-class presets too.
  const custom: QuickRun[] = getCustomAgents().map((agent) => ({
    id: `custom:${projectId}:${agent.id}`,
    projectId,
    name: agent.name,
    command: agent.command,
    isPreset: true,
    isAgent: true,
  }));
  return [...builtins, ...custom];
}

quickRuns.subscribe((val) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(val));
  } catch {}
});

export function addQuickRun(projectId: string, name: string, command: string) {
  const run: QuickRun = {
    id: `r_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    name: name.trim(),
    command: command.trim(),
    projectId,
  };
  quickRuns.update((all) => [...all, run]);
  return run;
}

export function deleteQuickRun(id: string) {
  quickRuns.update((all) => all.filter((r) => r.id !== id));
}

export function updateQuickRun(id: string, name: string, command: string) {
  quickRuns.update((all) =>
    all.map((r) =>
      r.id === id ? { ...r, name: name.trim(), command: command.trim() } : r
    )
  );
}

export function getProjectRuns(projectId: string) {
  return derived(quickRuns, ($runs) => {
    const projectPresets = getPresetRuns(projectId);
    const userRuns = $runs.filter((r) => r.projectId === projectId);
    return [...projectPresets, ...userRuns];
  });
}
