import { get, writable } from '$lib/stores/storeCompat';
import { loadJson } from '$lib/utils/storage';

const STORAGE_KEY = 'spacron_acp_registry_settings';

type AcpSettings = {
  disabledCommands: string[];
  enabled?: boolean;
  /** Commands the user declared ACP by hand. */
  explicitCommands?: string[];
  /** Local ACP entry point per agent command (e.g. Antigravity's agy_acp_server). */
  acpCommands?: Record<string, string>;
};

const initial = loadJson<AcpSettings>(STORAGE_KEY, { disabledCommands: [], enabled: true });
export const acpRegistryEnabled = writable(initial.enabled !== false);
export const acpDisabledCommands = writable<string[]>(Array.isArray(initial.disabledCommands) ? initial.disabledCommands : []);

/**
 * Commands the user has declared ACP: presets like Claude Code or Antigravity
 * that only speak ACP through a specific entry point, and hand-added agents
 * whose command says nothing about the protocol. Commands installed from the
 * ACP registry are covered by `supportsAcp` on the custom agent; this is the
 * manual counterpart, and the two are unioned wherever ACP membership matters.
 */
export const acpExplicitCommands = writable<string[]>(
  Array.isArray(initial.explicitCommands)
    ? initial.explicitCommands.filter((command) => typeof command === 'string' && command.trim()).map((command) => command.trim().toLowerCase())
    : [],
);

/**
 * Local ACP entry point per agent, keyed by the agent's command.
 *
 * A preset's own CLI is often not the ACP server: Antigravity ships ACP as the
 * `agy_acp_server` extension binary, and an agent added by hand may have its
 * entry point somewhere custom. Setting it here is what lets Chat launch that
 * agent over ACP without guessing a flag, and the agent then appears in the
 * Chat picker as a chattable agent.
 */
export const acpCommandOverrides = writable<Record<string, string>>(
  initial.acpCommands && typeof initial.acpCommands === 'object' ? { ...initial.acpCommands } : {},
);

function normalizeCommand(command: string): string {
  return command.trim().toLowerCase();
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      enabled: get(acpRegistryEnabled),
      disabledCommands: get(acpDisabledCommands),
      explicitCommands: get(acpExplicitCommands),
      acpCommands: get(acpCommandOverrides),
    }));
  } catch {}
}

acpRegistryEnabled.subscribe(persist);
acpDisabledCommands.subscribe(persist);
acpExplicitCommands.subscribe(persist);
acpCommandOverrides.subscribe(persist);

export function isAcpEnabled(command: string): boolean {
  const normalized = normalizeCommand(command);
  return get(acpRegistryEnabled) && !get(acpDisabledCommands).includes(normalized);
}

export function setAcpCommandEnabled(command: string, enabled: boolean): void {
  const normalized = normalizeCommand(command);
  if (!normalized) return;
  acpDisabledCommands.update((commands) => {
    const next = new Set(commands);
    if (enabled) next.delete(normalized);
    else next.add(normalized);
    return [...next];
  });
}

/** The ACP entry point the user set for this agent, if any. */
export function getAcpCommandOverride(command: string): string | null {
  const entry = get(acpCommandOverrides)[normalizeCommand(command)];
  return typeof entry === 'string' && entry.trim() ? entry.trim() : null;
}

/** Set (or clear, with an empty string) an agent's local ACP entry point. */
export function setAcpCommandOverride(command: string, acpCommand: string): void {
  const key = normalizeCommand(command);
  if (!key) return;
  const value = acpCommand.trim();
  acpCommandOverrides.update((current) => {
    const next = { ...current };
    if (value) next[key] = value;
    else delete next[key];
    return next;
  });
}

/** Commands the user declared ACP, for routing and for the Chat picker. */
export function getExplicitAcpCommands(): string[] {
  return get(acpExplicitCommands);
}

export function isAcpExplicit(command: string): boolean {
  const normalized = normalizeCommand(command);
  return Boolean(normalized) && get(acpExplicitCommands).includes(normalized);
}

/**
 * Declare (or undeclare) a local command as ACP. This is what lets Chat drive a
 * preset such as Claude Code or Antigravity — or an agent added by hand —
 * through the native ACP transport even when nothing in the command says `acp`.
 */
export function setAcpExplicit(command: string, explicit: boolean): void {
  const normalized = normalizeCommand(command);
  if (!normalized) return;
  acpExplicitCommands.update((commands) => explicit
    ? (commands.includes(normalized) ? commands : [...commands, normalized])
    : commands.filter((entry) => entry !== normalized));
}
