export const ACP_REGISTRY_URL = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json';

export type AcpDistribution =
  | { kind: 'npx'; package: string; args?: string[] }
  | { kind: 'uvx'; package: string; args?: string[] }
  | { kind: 'binary'; command: string; args?: string[] };

export interface AcpRegistryAgent {
  id: string;
  name: string;
  version: string;
  description: string;
  website?: string;
  repository?: string;
  icon?: string;
  distribution: AcpDistribution[];
}

type RegistryEnvelope = {
  version?: unknown;
  agents?: unknown;
};

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function safeArgs(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const args = value.filter(isString).map((arg) => arg.trim()).filter(Boolean);
  return args.length ? args : undefined;
}

function parseDistribution(value: unknown): AcpDistribution[] {
  if (!value || typeof value !== 'object') return [];
  const source = value as Record<string, unknown>;
  const distributions: AcpDistribution[] = [];
  const npx = source.npx;
  if (npx && typeof npx === 'object' && isString((npx as Record<string, unknown>).package)) {
    distributions.push({ kind: 'npx', package: (npx as Record<string, string>).package, args: safeArgs((npx as Record<string, unknown>).args) });
  }
  const uvx = source.uvx;
  if (uvx && typeof uvx === 'object' && isString((uvx as Record<string, unknown>).package)) {
    distributions.push({ kind: 'uvx', package: (uvx as Record<string, string>).package, args: safeArgs((uvx as Record<string, unknown>).args) });
  }
  const binary = source.binary;
  if (binary && typeof binary === 'object') {
    for (const [platform, entry] of Object.entries(binary as Record<string, unknown>)) {
      if (!entry || typeof entry !== 'object') continue;
      const command = (entry as Record<string, unknown>).cmd;
      if (isString(command)) {
        distributions.push({ kind: 'binary', command, args: safeArgs((entry as Record<string, unknown>).args) });
      } else if (platform) {
        continue;
      }
    }
  }
  return distributions;
}

export function parseAcpRegistry(value: unknown): AcpRegistryAgent[] {
  const envelope = value as RegistryEnvelope | null;
  if (!envelope || !Array.isArray(envelope.agents)) return [];
  return envelope.agents.flatMap((entry): AcpRegistryAgent[] => {
    if (!entry || typeof entry !== 'object') return [];
    const raw = entry as Record<string, unknown>;
    if (!isString(raw.id) || !isString(raw.name) || !isString(raw.version) || !isString(raw.description)) return [];
    const distribution = parseDistribution(raw.distribution);
    if (!distribution.length) return [];
    return [{
      id: raw.id.trim(),
      name: raw.name.trim(),
      version: raw.version.trim(),
      description: raw.description.trim(),
      ...(isString(raw.website) ? { website: raw.website.trim() } : {}),
      ...(isString(raw.repository) ? { repository: raw.repository.trim() } : {}),
      ...(isString(raw.icon) ? { icon: raw.icon.trim() } : {}),
      distribution,
    }];
  });
}

export async function fetchAcpRegistry(signal?: AbortSignal): Promise<AcpRegistryAgent[]> {
  const response = await fetch(ACP_REGISTRY_URL, { signal });
  if (!response.ok) throw new Error(`ACP Registry returned HTTP ${response.status}`);
  return parseAcpRegistry(await response.json());
}

export function commandForAcpDistribution(distribution: AcpDistribution): string {
  if (distribution.kind === 'npx') return `npx -y ${distribution.package}${distribution.args?.length ? ` ${distribution.args.join(' ')}` : ''}`;
  if (distribution.kind === 'uvx') return `uvx ${distribution.package}${distribution.args?.length ? ` ${distribution.args.join(' ')}` : ''}`;
  return `${distribution.command}${distribution.args?.length ? ` ${distribution.args.join(' ')}` : ''}`;
}
