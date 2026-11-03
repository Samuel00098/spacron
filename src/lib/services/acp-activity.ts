export type AcpActivity = {
  label: string;
  detail?: string;
  kind: 'tool' | 'file' | 'plan' | 'status';
};

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function activityFromAcpUpdate(value: unknown): AcpActivity | null {
  const envelope = object(value);
  if (!envelope) return null;
  const params = object(envelope.params) ?? envelope;
  const update = object(params.update) ?? params;
  const kind = String(update.sessionUpdate ?? update.type ?? '').toLowerCase();
  if (!kind || kind.includes('message_chunk') || kind.includes('thought_chunk')) return null;
  const tool = object(update.toolCall) ?? object(update.tool) ?? update;
  const path = typeof tool.path === 'string' ? tool.path : typeof tool.filePath === 'string' ? tool.filePath : undefined;
  const name = typeof tool.title === 'string'
    ? tool.title
    : typeof tool.name === 'string'
      ? tool.name
      : kind.replace(/[_-]/g, ' ');
  const status = typeof tool.status === 'string' ? tool.status : undefined;
  const activityKind: AcpActivity['kind'] = kind.includes('file') || path
    ? 'file'
    : kind.includes('plan')
      ? 'plan'
      : kind.includes('tool') || tool !== update
        ? 'tool'
        : 'status';
  return {
    kind: activityKind,
    label: `${name}${status ? ` (${status})` : ''}`,
    ...(path ? { detail: path } : {}),
  };
}
