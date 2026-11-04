export type NormalizedAcpUpdate = {
  kind: string;
  content?: string;
  raw: Record<string, unknown>;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** A finite number from a number or a numeric string; anything else is absent. */
function count(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeAcpUpdate(value: unknown): NormalizedAcpUpdate | null {
  const envelope = record(value);
  if (!envelope) return null;
  const params = record(envelope.params) ?? envelope;
  const update = record(params.update) ?? record(params.sessionUpdate) ?? params;
  if (!update) return null;
  const rawKind = update.sessionUpdate ?? update.type ?? update.kind;
  if (typeof rawKind !== 'string') return null;
  const kind = rawKind.replace(/[-\s]/g, '_').replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`).replace(/^_/, '');
  const content = update.content;
  if (typeof content === 'string') return { kind, content, raw: update };
  if (Array.isArray(content)) {
    const text = content.flatMap((part) => {
      const item = record(part);
      return item && typeof item.text === 'string' ? [item.text] : [];
    }).join('');
    return { kind, ...(text ? { content: text } : {}), raw: update };
  }
  const contentRecord = record(content);
  return {
    kind,
    ...(contentRecord && typeof contentRecord.text === 'string' ? { content: contentRecord.text } : {}),
    raw: update,
  };
}

export function isAcpReplayIdle(update: NormalizedAcpUpdate | null): boolean {
  return update?.kind === 'session_idle'
    || update?.kind === 'turn_complete'
    || update?.kind === 'prompt_complete'
    || update?.kind === 'session_end';
}

/** A reported cost figure: the agent's own currency, never ours to convert. */
export interface AcpUsageCost {
  amount: number;
  currency: string;
}

/**
 * Context usage from an ACP `usage_update`.
 *
 * `used`/`size` are the tokens in context and the window they sit in — the same
 * pair T3 Code's context meter draws. `cost` is a patch field in v2 (omitted
 * means unchanged, null clears), so a missing cost stays missing here instead
 * of being invented.
 */
export interface AcpUsage {
  used: number;
  size: number;
  cost?: AcpUsageCost | null;
}

export function parseAcpUsage(value: unknown): AcpUsage | null {
  const update = normalizeAcpUpdate(value);
  if (!update || update.kind !== 'usage_update') return null;
  const raw = update.raw;
  const used = count(raw.used ?? raw.tokensUsed ?? raw.contextTokens);
  const size = count(raw.size ?? raw.contextWindow ?? raw.maxTokens);
  if (used === null || size === null || size <= 0 || used < 0) return null;
  const usage: AcpUsage = { used, size: Math.max(used, Math.floor(size)) };
  const cost = record(raw.cost);
  if (cost) {
    const amount = count(cost.amount);
    const currency = typeof cost.currency === 'string' ? cost.currency.trim() : '';
    if (amount !== null && currency) usage.cost = { amount, currency };
  } else if (raw.cost === null) {
    usage.cost = null;
  }
  return usage;
}

export interface AcpPlanEntry {
  content: string;
  status: string;
  priority?: string;
}

export interface AcpPlan {
  planId: string;
  entries: AcpPlanEntry[];
}

/**
 * The turn plan an agent published: v2's `plan_update` (nested under `plan`,
 * keyed by `planId`, each update replacing that plan's entries) or v1's `plan`.
 * Entries without content are dropped — an empty row is not a step.
 */
export function parseAcpPlan(value: unknown): AcpPlan | null {
  const update = normalizeAcpUpdate(value);
  if (!update) return null;
  if (update.kind !== 'plan_update' && update.kind !== 'plan') return null;
  const raw = update.raw;
  const plan = record(raw.plan) ?? raw;
  const entriesRaw = Array.isArray(plan.entries) ? plan.entries : [];
  const entries: AcpPlanEntry[] = [];
  for (const entry of entriesRaw) {
    const item = record(entry);
    if (!item) continue;
    const content = typeof item.content === 'string' ? item.content.trim() : '';
    if (!content) continue;
    entries.push({
      content,
      status: typeof item.status === 'string' ? item.status : 'pending',
      ...(typeof item.priority === 'string' ? { priority: item.priority } : {}),
    });
  }
  if (entries.length === 0) return null;
  const planId = typeof plan.planId === 'string' && plan.planId.trim()
    ? plan.planId
    : typeof raw.planId === 'string' && raw.planId.trim() ? raw.planId : 'plan';
  return { planId, entries };
}
