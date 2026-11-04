import type { ChatAccessMode } from '$lib/types/chat';
import { accessTier, type ChatAccessTier } from '$lib/services/orchestrator/access-policy';

/**
 * How a chat's permission tier answers an ACP `session/request_permission`.
 *
 * ACP agents enforce their own sandbox and ask the client only for the actions
 * they cannot decide. T3 Code's model — which this follows — is that the tier
 * is a *policy for answering those requests*, not a mode pushed at the agent
 * (that is `acp-permission-modes.ts`, and it stays). Without this, "Full
 * access" only ever changes what the agent was told; an agent that ignores
 * `session/set_mode` still stops for every edit.
 */

/** One agent-supplied option. `kind` is ACP's own vocabulary, when present. */
export interface AcpApprovalOption {
  id: string;
  label: string;
  kind?: string;
}

export interface AcpApprovalDecision {
  option: AcpApprovalOption;
  /** Why it was approved without a card; shown in the transcript. */
  reason: 'read-only' | ChatAccessTier;
}

/** Tool categories that only observe the workspace. */
const READ_KINDS: ReadonlySet<string> = new Set(['read', 'search', 'fetch', 'think', 'list']);

/** Tool categories `auto-edits` may approve on its own. */
const EDIT_KINDS: ReadonlySet<string> = new Set(['edit', 'create', 'write', 'delete', 'move', 'rename']);

/** An option that declines rather than grants. */
function declines(option: AcpApprovalOption): boolean {
  const kind = (option.kind ?? '').toLowerCase();
  if (kind) return kind.startsWith('reject') || kind.startsWith('deny') || kind.startsWith('cancel');
  // v1 agents may send no `kind` at all; the label is the only signal left.
  return /^(reject|deny|no\b|cancel|decline|block)/i.test(option.label.trim());
}

/** The option to answer with: `allow_always` when offered, else the first grant. */
function grant(options: readonly AcpApprovalOption[]): AcpApprovalOption | null {
  const allowed = options.filter((option) => !declines(option));
  if (allowed.length === 0) return null;
  return allowed.find((option) => option.kind === 'allow_always')
    ?? allowed.find((option) => option.kind === 'allow_once')
    ?? allowed[0];
}

/**
 * The answer this tier gives to a permission request, or null to ask the user.
 *
 * Reads never need a human at any tier. Otherwise:
 * - `supervised` asks about everything.
 * - `auto-edits` approves file changes only; commands still ask.
 * - `auto` and `full-access` approve, which matches their labels and T3's
 *   behaviour for registry agents (they have no reviewer to consult).
 *
 * A request with no grantable option is never auto-answered: there is nothing
 * to approve, and answering would fabricate a decision.
 */
export function acpApprovalDecision(
  mode: ChatAccessMode | null | undefined,
  toolKind: string | undefined,
  options: readonly AcpApprovalOption[],
): AcpApprovalDecision | null {
  const kind = (toolKind ?? '').toLowerCase();
  if (READ_KINDS.has(kind)) {
    const option = grant(options);
    return option ? { option, reason: 'read-only' } : null;
  }
  const tier = accessTier(mode);
  if (tier === 'supervised') return null;
  const option = grant(options);
  if (!option) return null;
  if (tier === 'auto' || tier === 'full-access') return { option, reason: tier };
  if (EDIT_KINDS.has(kind)) return { option, reason: 'auto-edits' };
  // Unknown category under `auto-edits`: ask rather than guess that it edits.
  return null;
}
