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
