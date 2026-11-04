import type { ChatAccessMode } from '$lib/types/chat';
import { accessTier, type ChatAccessTier } from './orchestrator/access-policy';

/**
 * ACP permission modes.
 *
 * An ACP agent decides its own mode vocabulary: `session/new` (and
 * `session/load`/`session/resume`) return `modes: { currentModeId,
 * availableModes }`, and `session/set_mode` switches one. The composer's tier is
 * mapped onto *the agent's own* modes — never invented — and when nothing
 * matches we leave the agent on its default rather than claim a mode it does
 * not have.
 */
export interface AcpAvailableMode {
  id: string;
  name?: string;
  description?: string;
}

export interface AcpModeState {
  availableModes: AcpAvailableMode[];
  currentModeId: string | null;
}

function asMode(entry: unknown): AcpAvailableMode | null {
  if (!entry || typeof entry !== 'object') return null;
  const record = entry as Record<string, unknown>;
  if (typeof record.id !== 'string' || !record.id.trim()) return null;
  return {
    id: record.id.trim(),
    ...(typeof record.name === 'string' ? { name: record.name } : {}),
    ...(typeof record.description === 'string' ? { description: record.description } : {}),
  };
}

/**
 * Read the mode state out of a `session/new` / `session/load` / `session/resume`
 * result, or out of the `modes` object alone.
 */
export function parseAcpModeState(value: unknown): AcpModeState | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const container = record.modes && typeof record.modes === 'object'
    ? record.modes as Record<string, unknown>
    : record;
  if (!Array.isArray(container.availableModes)) return null;
  const availableModes = container.availableModes.flatMap((entry) => {
    const mode = asMode(entry);
    return mode ? [mode] : [];
  });
  if (availableModes.length === 0) return null;
  return {
    availableModes,
    currentModeId: typeof container.currentModeId === 'string' ? container.currentModeId : null,
  };
}

/**
 * Patterns per tier, most restrictive first. `auto-edits` is tested before
 * `auto`, otherwise "auto accept edits" would be read as plain auto.
 */
const AUTO_EDITS_PATTERN = /(accept[-_ ]?edit|auto[-_ ]?accept[-_ ]?edit|edit[-_ ]?auto)/i;

const TIER_HINTS: readonly { tier: ChatAccessTier; pattern: RegExp }[] = [
  { tier: 'full-access', pattern: /(full|bypass|yolo|danger|unrestricted|trusted)/i },
  { tier: 'auto-edits', pattern: AUTO_EDITS_PATTERN },
  { tier: 'auto', pattern: /(^|[^a-z])auto([^a-z]|$)|accept[-_ ]?all|always[-_ ]?allow|approve[-_ ]?all/i },
  { tier: 'supervised', pattern: /(read[-_ ]?only|readonly|plan|ask|manual|supervis|confirm|interactive|default)/i },
];

function modeText(mode: AcpAvailableMode): string {
  return `${mode.id} ${mode.name ?? ''}`.trim();
}

/**
 * The agent mode that expresses this tier, or null when the agent advertises
 * nothing suitable (Chat then leaves its default alone).
 */
export function chooseAcpMode(state: AcpModeState | null | undefined, mode: ChatAccessMode | null | undefined): string | null {
  if (!state) return null;
  const tier = accessTier(mode);
  const hint = TIER_HINTS.find((entry) => entry.tier === tier);
  if (!hint) return null;
  const match = state.availableModes.find((entry) => {
    const text = modeText(entry);
    if (!hint.pattern.test(text)) return false;
    // An "auto accept edits" mode belongs to the edits tier; plain auto must
    // not claim it just because the word "auto" appears.
    return !(tier === 'auto' && AUTO_EDITS_PATTERN.test(text));
  });
  return match ? match.id : null;
}

/** Whether the mode already matches, so a no-op switch is never sent. */
export function acpModeNeedsSwitch(state: AcpModeState | null | undefined, mode: ChatAccessMode | null | undefined): boolean {
  if (!state) return false;
  const desired = chooseAcpMode(state, mode);
  return Boolean(desired) && desired !== state.currentModeId;
}
