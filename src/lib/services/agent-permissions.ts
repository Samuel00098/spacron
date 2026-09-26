/**
 * Global agent permission mode — the Orca-style "Yolo" toggle.
 *
 * Every coding CLI that offers a permission system has its own native flag for
 * "run everything without asking" (Claude's `--dangerously-skip-permissions`,
 * Codex's `--dangerously-bypass-approvals-and-sandbox`, Gemini's `--yolo`…).
 * When the mode is `yolo`, Spacron appends each CLI's own flag at spawn, so an
 * agent run never stalls on a permission prompt the user has already decided
 * they don't want to see.
 *
 * Two layers, mirroring Orca's `tui-agent-permissions.ts`:
 *
 *  1. A **global mode** (`agentPermissionMode` setting) — the default for every
 *     agent that hasn't been customized.
 *  2. **Per-agent overrides** (`agentDefaultArgs` / `agentDefaultEnv` /
 *     `agentCmdOverrides` settings) — an explicit value for one agent wins over
 *     the global mode, including an empty string (forces manual for that
 *     agent). This is what the tooltip means by "doesn't apply to agents where
 *     you've overridden launch arguments".
 *
 * The tables below are keyed by the **executable name** of the launch command
 * (`agentExecutable`), so `npx claude`, `claude --resume` and a custom agent
 * whose command is `claude --some-flag` all resolve to the same row.
 *
 * Not every CLI is in the table on purpose. Orca's own table excludes
 * OpenCode, Kilo, Pi and Droid because they historically had no skip-permission
 * flag on the interactive TUI command. That has since changed for OpenCode: its
 * CLI docs list `--auto` ("auto-approve permissions that are not explicitly
 * denied") on both the TUI and `run`, so it now belongs here. Pi and Droid
 * still have no verified flag on the Spacron launch shape; they simply launch
 * bare in yolo mode.
 */

import { agentExecutable } from './orchestrator/agent-rules-file';

export type AgentPermissionMode = 'yolo' | 'manual';

/**
 * Each CLI's own "bypass every permission prompt" flag. Values are the flag the
 * vendor documents for its interactive command — verified against Orca's table
 * and the CLIs' own docs before being listed.
 */
export const YOLO_AGENT_ARGS: Record<string, string> = {
  claude: '--dangerously-skip-permissions',
  codex: '--dangerously-bypass-approvals-and-sandbox',
  gemini: '--yolo',
  agy: '--dangerously-skip-permissions',
  aider: '--yes-always',
  amp: '--dangerously-allow-all',
  cline: '--auto-approve true',
  'cursor-agent': '--yolo',
  kimi: '--yolo',
  qwen: '--approval-mode yolo',
  grok: '--permission-mode bypassPermissions',
  copilot: '--yolo',
  opencode: '--auto',
  hermes: '--yolo',
  crush: '--yolo',
};

/**
 * Agents whose bypass is an environment variable rather than a flag. Goose's
 * `GOOSE_MODE=auto` is its documented unattended mode.
 */
export const YOLO_AGENT_ENV: Record<string, Record<string, string>> = {
  goose: { GOOSE_MODE: 'auto' },
};

/** Executable names we know a bypass for (flag or env). */
const YOLO_EXECUTABLES = new Set([
  ...Object.keys(YOLO_AGENT_ARGS),
  ...Object.keys(YOLO_AGENT_ENV),
]);

/** True when this launch command's CLI has a known yolo bypass. */
export function isYoloCapable(command: string | null | undefined): boolean {
  if (!command) return false;
  return YOLO_EXECUTABLES.has(agentExecutable(command));
}

/** The yolo flag string for a launch command, or '' when none exists. */
export function yoloArgsFor(command: string | null | undefined): string {
  if (!command) return '';
  return YOLO_AGENT_ARGS[agentExecutable(command)] ?? '';
}

/** The yolo environment for a launch command, or {} when none exists. */
export function yoloEnvFor(command: string | null | undefined): Record<string, string> {
  if (!command) return {};
  return { ...(YOLO_AGENT_ENV[agentExecutable(command)] ?? {}) };
}

/** The persisted per-agent launch customization, keyed by the preset's launch command. */
export interface AgentLaunchOverrides {
  agentDefaultArgs?: Partial<Record<string, string>> | null;
  agentDefaultEnv?: Partial<Record<string, Record<string, string>>> | null;
  agentCmdOverrides?: Partial<Record<string, string>> | null;
}

/**
 * The mode an agent is effectively running in, after the global mode and any
 * per-agent override are applied.
 *
 *  - `'yolo'` — the CLI's bypass is in place (either because it follows the
 *    global yolo mode or because the row toggle pinned it there).
 *  - `'manual'` — launches bare (global manual, or pinned by the row toggle).
 *  - `'custom'` — a bespoke args/env override is set, so neither the flag nor
 *    bare applies (and CLIs without any bypass always report this).
 */
export type AgentEffectiveMode = 'yolo' | 'manual' | 'custom';

export function effectiveAgentMode(
  command: string,
  mode: AgentPermissionMode,
  overrides: AgentLaunchOverrides = {}
): AgentEffectiveMode {
  if (!isYoloCapable(command)) return 'custom';

  const args = resolveAgentLaunchArgs(command, mode, overrides);
  const env = resolveAgentLaunchEnv(command, mode, overrides);
  const yoloFlag = yoloArgsFor(command);
  const yoloEnv = yoloEnvFor(command);

  const flagMatches = yoloFlag ? args === yoloFlag : args === '';
  const envMatches =
    Object.keys(yoloEnv).length > 0
      ? JSON.stringify(env) === JSON.stringify(yoloEnv)
      : Object.keys(env).length === 0;

  if (flagMatches && envMatches) return 'yolo';
  if (args === '' && Object.keys(env).length === 0) return 'manual';
  return 'custom';
}

/**
 * Pin one agent to a specific mode, bypassing the global default. Writes the
 * per-agent override maps so `resolveAgentLaunch*` sees the explicit choice.
 *
 * Yolo writes the CLI's native flag (or env for env-only CLIs like Goose) and
 * clears the other override. Manual pins with an empty-string args override and
 * an empty env override — exactly what `resolveAgentLaunchArgs` treats as
 * "force manual for this agent".
 */
export function setAgentPermissionMode(
  command: string,
  target: AgentPermissionMode,
  stores: {
    agentDefaultArgs: { update: (fn: (map: Record<string, string>) => Record<string, string>) => void };
    agentDefaultEnv: {
      update: (fn: (map: Record<string, Record<string, string>>) => Record<string, Record<string, string>>) => void;
    };
  }
): void {
  const executable = agentExecutable(command);
  const flag = YOLO_AGENT_ARGS[executable];
  const env = YOLO_AGENT_ENV[executable];
  // Only touch the mechanism this CLI actually uses, so the override maps stay
  // free of meaningless keys (e.g. an env entry for a flag-only CLI). Yolo
  // writes the bypass; manual pins with the empty form the resolve layer reads.
  const argsValue = target === 'yolo' ? flag : '';
  stores.agentDefaultArgs.update((map) => {
    const next = { ...map };
    if (flag) next[command] = argsValue;
    else delete next[command];
    return next;
  });
  stores.agentDefaultEnv.update((map) => {
    const next = { ...map };
    if (env) next[command] = target === 'yolo' ? { ...env } : {};
    else delete next[command];
    return next;
  });
}

/**
 * The args to append to a launch command.
 *
 * An explicit per-agent override wins — including an empty string, which pins
 * that agent to manual. Otherwise the global mode decides.
 */
export function resolveAgentLaunchArgs(
  command: string,
  mode: AgentPermissionMode,
  overrides: AgentLaunchOverrides = {}
): string {
  const configured = overrides.agentDefaultArgs?.[command];
  if (configured !== undefined && typeof configured === 'string') return configured;
  return mode === 'yolo' ? yoloArgsFor(command) : '';
}

/** The environment for a launch command, same precedence as args. */
export function resolveAgentLaunchEnv(
  command: string,
  mode: AgentPermissionMode,
  overrides: AgentLaunchOverrides = {}
): Record<string, string> {
  const configured = overrides.agentDefaultEnv?.[command];
  if (configured) return { ...configured };
  return mode === 'yolo' ? yoloEnvFor(command) : {};
}

/**
 * Flags a CLI needs on this platform regardless of permission mode, as a
 * suffix with a leading space (like `mcpLaunchFlags`), or '' when none.
 *
 * Codex on Windows: `--no-daemon`. Its shared app-server daemon runs detached
 * without a console, so commands it starts can open visible console windows.
 * `--disable daemon_auto_start` only prevents starting a new daemon; Codex can
 * still attach to one already running. `--no-daemon` keeps this TUI's server
 * inside the Spacron PTY even when the shared daemon exists.
 */
export function platformLaunchFlags(
  command: string | null | undefined,
  platform: string = typeof navigator !== 'undefined' ? navigator.platform : '',
): string {
  if (!command) return '';
  if (agentExecutable(command) === 'codex' && /^win/i.test(platform)) {
    return ' --no-daemon';
  }
  return '';
}

/** A user-edited binary path/name replaces the preset's launch command. */
export function resolveAgentLaunchCommand(
  command: string,
  overrides: AgentLaunchOverrides = {}
): string {
  const override = overrides.agentCmdOverrides?.[command];
  return override && override.trim() ? override.trim() : command;
}

/**
 * Whether the per-agent overrides diverge from the global mode for any yolo-capable
 * agent. When true the UI shows a "some agents customized" note next to the toggle,
 * because flipping it won't affect every row.
 */
export function hasCustomizedYoloAgents(
  mode: AgentPermissionMode,
  overrides: AgentLaunchOverrides = {}
): boolean {
  const commands = new Set([
    ...Object.keys(overrides.agentDefaultArgs ?? {}),
    ...Object.keys(overrides.agentDefaultEnv ?? {}),
  ]);
  for (const command of commands) {
    if (!isYoloCapable(command)) continue;
    const expectedArgs = mode === 'yolo' ? yoloArgsFor(command) : '';
    const args = overrides.agentDefaultArgs?.[command];
    if (args !== undefined && args !== expectedArgs) return true;
    const expectedEnv = mode === 'yolo' ? yoloEnvFor(command) : {};
    const env = overrides.agentDefaultEnv?.[command];
    if (env !== undefined && JSON.stringify(env) !== JSON.stringify(expectedEnv)) return true;
  }
  return false;
}
