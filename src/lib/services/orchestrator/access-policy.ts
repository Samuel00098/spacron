import type { ChatAccessMode } from '$lib/types/chat';

/**
 * T3's four chat permission tiers.
 *
 * `inherit` is not a tier: it means "this thread never chose one". It resolves
 * to `supervised`, which is the safe reading — a thread must not silently run
 * with broader rights because a setting was absent.
 */
export type ChatAccessTier = Exclude<ChatAccessMode, 'inherit'>;

export const CHAT_ACCESS_TIERS: readonly ChatAccessTier[] = [
  'supervised',
  'auto-edits',
  'auto',
  'full-access',
];

export const CHAT_ACCESS_TIER_LABELS: Record<ChatAccessTier, string> = {
  supervised: 'Supervised',
  'auto-edits': 'Auto-accept edits',
  auto: 'Auto',
  'full-access': 'Full access',
};

export const CHAT_ACCESS_TIER_HINTS: Record<ChatAccessTier, string> = {
  supervised: 'Reads freely, asks before every file change or command.',
  'auto-edits': 'File edits go through; commands and anything destructive still ask.',
  auto: 'Runs its tools without asking, but stays inside the project.',
  'full-access': 'No approvals and no workspace limits.',
};

export function isChatAccessTier(value: unknown): value is ChatAccessTier {
  return typeof value === 'string' && (CHAT_ACCESS_TIERS as readonly string[]).includes(value);
}

/** The tier this thread actually runs at. */
export function accessTier(mode: ChatAccessMode | null | undefined): ChatAccessTier {
  return isChatAccessTier(mode) ? mode : 'supervised';
}

/** Tools that change files, as opposed to running something. */
const EDIT_TOOLS: ReadonlySet<string> = new Set([
  'write_file',
  'edit_file',
  'save_document',
  'generate_image',
]);

/**
 * Whether this tier must stop and ask before the tool runs.
 *
 * `auto` and `full-access` differ in reach (the workspace limit is lifted only
 * for full access), not in prompting, so both answer false here.
 */
export function tierNeedsApproval(tier: ChatAccessTier, toolName: string): boolean {
  if (tier === 'full-access' || tier === 'auto') return false;
  if (tier === 'auto-edits') return !EDIT_TOOLS.has(toolName);
  return true;
}
