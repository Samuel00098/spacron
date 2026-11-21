import { writable, derived, get } from '$lib/stores/storeCompat';
import { loadJson } from '$lib/utils/storage';
import { getCustomAgents, getRemovedPresetAgents } from '$lib/stores/customAgents';
import { usageState, installedAgentCommands, haveAgentDetection } from '$lib/stores/usage';

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
  { name: 'Codex', command: 'codex', isPreset: true, isAgent: true },
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
  { name: 'Grok', command: 'grok', isPreset: true, isAgent: true },
  { name: 'Cody', command: 'cody', isPreset: true, isAgent: true },
  // The wider registry. Adding a row here is only part of the job: the
  // rules-file answer must be mirrored into `RULES_FILE_AGENTS`
  // (`services/orchestrator/agent-rules-file.ts`), and the detection table
  // `PROVIDERS` in `src-tauri/src/commands/usage.rs` must gain a matching
  // entry — otherwise the row shows "Not detected" for an installed CLI, or
  // the agent silently gets the wrong brief channel — see
  // [[standing-brief-sources]] and [[agent-usage-meters]].
  { name: 'Gemini', command: 'gemini', isPreset: true, isAgent: true },
  { name: 'Factory Droid', command: 'droid', isPreset: true, isAgent: true },
  { name: 'GitHub Copilot', command: 'copilot', isPreset: true, isAgent: true },
  { name: 'Qwen Code', command: 'qwen', isPreset: true, isAgent: true },
  { name: 'Cline', command: 'cline', isPreset: true, isAgent: true },
  // No terminal UI: the picker opens it as a web panel and delegation runs it
  // headless — see `services/deepseek-harness.ts`. The preset still lives here
  // so detection, the delegate roster and brand marks treat it like any agent.
  { name: 'DeepSeek Harness', command: 'dsh', isPreset: true, isAgent: true },
  { name: 'Amp', command: 'amp', isPreset: true, isAgent: true },
  { name: 'Goose', command: 'goose', isPreset: true, isAgent: true },
  { name: 'Kimi', command: 'kimi', isPreset: true, isAgent: true },
  { name: 'Crush', command: 'crush', isPreset: true, isAgent: true },
  { name: 'Aider', command: 'aider', isPreset: true, isAgent: true },
  // The wider registry, continued — agent CLIs ported from Orca's agent
  // catalog. Commands are the binaries those tools actually install (traecli,
  // auggie, cn, kiro-cli, vibe…), not the package names, so a detected install
  // and a spawned session agree on what to launch. Same mirroring rules as
  // above apply: a rules-file entry belongs in `RULES_FILE_AGENTS`, and a
  // PROVIDERS row in usage.rs carries the detection command + aliases.
  { name: 'OpenClaude', command: 'openclaude', isPreset: true, isAgent: true },
  { name: 'Autohand', command: 'autohand', isPreset: true, isAgent: true },
  { name: 'Ante', command: 'ante', isPreset: true, isAgent: true },
  { name: 'TRAE', command: 'traecli', isPreset: true, isAgent: true },
  // Qoder (Alibaba) ships `qodercli` from the npm package `@qoder-ai/qodercli`
  // — the binary is not `qoder`, which is the IDE. Verified against a real
  // 1.1.7 install.
  { name: 'Qoder', command: 'qodercli', isPreset: true, isAgent: true },
  { name: 'Mimo', command: 'mimo', isPreset: true, isAgent: true },
  { name: 'OMP', command: 'omp', isPreset: true, isAgent: true },
  { name: 'Prime Agent', command: 'prime-agent', isPreset: true, isAgent: true },
  { name: 'Kilo', command: 'kilo', isPreset: true, isAgent: true },
  { name: 'Kiro', command: 'kiro-cli', isPreset: true, isAgent: true },
  { name: 'Augment', command: 'auggie', isPreset: true, isAgent: true },
  { name: 'Codebuff', command: 'codebuff', isPreset: true, isAgent: true },
  { name: 'Freebuff', command: 'freebuff', isPreset: true, isAgent: true },
  { name: 'Command Code', command: 'command-code', isPreset: true, isAgent: true },
  { name: 'Continue', command: 'cn', isPreset: true, isAgent: true },
  { name: 'Mistral Vibe', command: 'vibe', isPreset: true, isAgent: true },
  { name: 'Rovo', command: 'rovo', isPreset: true, isAgent: true },
  { name: 'OpenClaw', command: 'openclaw', isPreset: true, isAgent: true },
  { name: 'Devin', command: 'devin', isPreset: true, isAgent: true },
  { name: 'Dev Server', command: 'npm run dev', isPreset: true },
];

// Why a preset launches a non-obvious command, or takes an unusual brief
// channel. Shown under the command in the Agents pane so nobody "corrects" it
// back to a shorter alias another CLI also owns (see the Cursor row).
const PRESET_NOTES: Record<string, string> = {
  'cursor-agent':
    'Not the shorter “agent” alias. The Grok CLI installs an “agent” command too, and whichever comes first on your PATH wins.',
  aider: 'Aider has no auto-loaded rules file, so Spacron writes the brief into CONVENTIONS.md and points at it via `read:` in .aider.conf.yml (skipped, with a terminal paste instead, when your config already declares a read list).',
  traecli:
    'Not the shorter “trae-cli”. The unrelated bytedance/trae-agent installs that binary, and whichever lands first on PATH wins.',
  auggie: 'Augment ships “auggie”, not the shorter “aug”, which is a different tool\'s name.',
  cn: 'Continue\'s CLI binary is “cn”, because “continue” is a shell builtin and would resolve to the shell keyword.',
  'kiro-cli': 'Kiro\'s installer ships “kiro-cli”, not “kiro”.',
  'command-code':
    'Command Code ships the full name; its “cmd” alias collides with Windows\' built-in cmd.exe.',
  vibe: 'Mistral Vibe installs as “vibe” (package mistral-vibe); the alias is kept for wrapped installs.',
};

/**
 * Every known agent CLI, as `{ command, name, note? }`, including presets the
 * user has hidden (the Agents pane needs to offer "Add back"). Non-agent
 * presets like "Dev Server" are excluded, as are custom agents (those live in
 * customAgents.ts).
 */
export function getAgentPresetCatalog(): { command: string; name: string; note?: string }[] {
  return AI_AGENT_PRESETS
    .filter((preset) => preset.isAgent)
    .map((preset) => ({ command: preset.command, name: preset.name, note: PRESET_NOTES[preset.command] }));
}

/**
 * Every coding agent this install can launch, as `{ command, name }`.
 *
 * Project-independent, unlike `getPresetRuns`, and excludes non-agent presets
 * like "Dev Server". This is the roster handed to the MCP server so a delegating
 * agent can discover what is really available — including the user's own custom
 * agents — instead of guessing from a hardcoded list.
 *
 * Built-in entries are narrowed to auto-detected, installed CLIs once the
 * detection scan has run (same rule as the spawn picker, via
 * `filterInstalledAgents`). Before the first scan — or outside Tauri, where no
 * scan exists — the full roster is returned rather than hiding agents on a
 * detection hiccup. The caller should re-read this when detection refreshes;
 * `mcpBridge.ts` subscribes to `usageState` so the server's roster stays live.
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
  const usage = get(usageState);
  return filterInstalledAgents([...builtins, ...custom], {
    installedCommands: installedAgentCommands(usage),
    customCommands: new Set(custom.map((a) => a.command)),
    haveDetection: haveAgentDetection(usage),
  });
}

/**
 * Narrow an agent list to agents that will actually work on this machine.
 *
 * Built-in entries are filtered to those auto-detected on PATH (`installed`);
 * custom agents are always kept — the user added them deliberately, and the
 * detection scan (Rust `usage_detect_agents`, which walks the known PROVIDERS
 * table) has no way to know about them. `haveDetection` stays false until the
 * first scan completes; until then nothing is filtered, so a detection hiccup
 * or a browser (non-Tauri) session can never hide a spawnable agent. Used by
 * every surface that offers agents — the spawn picker, the orchestrator's
 * run-preset roster, and the MCP delegate roster — so they all agree on what
 * "available" means.
 */
export function filterInstalledAgents<T extends { command: string }>(
  agents: T[],
  opts: {
    installedCommands: ReadonlySet<string>;
    customCommands: ReadonlySet<string>;
    haveDetection: boolean;
  },
): T[] {
  if (!opts.haveDetection) return agents;
  return agents.filter(
    (agent) => opts.customCommands.has(agent.command) || opts.installedCommands.has(agent.command),
  );
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
