export type AcpSessionHandoffMode = 'native-session' | 'prompt-fallback';

export interface AcpCapabilities {
  protocol: 'acp';
  /** The executable is a known ACP candidate; runtime negotiation remains authoritative. */
  nativeProtocol: boolean;
  sessionHandoff: AcpSessionHandoffMode;
  supportsSessionLoad: boolean;
  supportsSessionResume: boolean;
  supportsPromptContext: boolean;
  adapterId?: string;
  reason?: string;
}

export interface AcpProviderAdapter {
  id: string;
  aliases: readonly string[];
  launchArgs?: readonly string[];
  supportsModelSelection: boolean;
}

const NATIVE_ACP_EXECUTABLES = new Set([
  'claude-agent-acp',
  'copilot',
  'github-copilot-cli',
  'gemini',
  'gemini-cli',
  'kiro-cli',
  'goose',
  'mistral-vibe',
  'factory-droid',
  'devin',
  'glm-acp-agent',
]);

const ACP_PROVIDER_ADAPTERS: readonly AcpProviderAdapter[] = [
  { id: 'claude-acp', aliases: ['claude-agent-acp'], supportsModelSelection: true },
  { id: 'copilot-acp', aliases: ['copilot', 'github-copilot-cli'], supportsModelSelection: true },
  { id: 'gemini-acp', aliases: ['gemini', 'gemini-cli'], supportsModelSelection: true },
  { id: 'kiro-acp', aliases: ['kiro-cli'], supportsModelSelection: true },
  { id: 'goose-acp', aliases: ['goose'], supportsModelSelection: true },
  { id: 'mistral-vibe-acp', aliases: ['mistral-vibe'], supportsModelSelection: true },
  { id: 'factory-droid-acp', aliases: ['factory-droid'], supportsModelSelection: true },
  { id: 'devin-acp', aliases: ['devin'], supportsModelSelection: true },
  { id: 'glm-acp', aliases: ['glm-acp-agent'], supportsModelSelection: true },
];

function executableName(command: string): string {
  const token = command.trim().match(/^(?:"([^"]+)"|'([^']+)'|([^\s]+))/)?.slice(1).find(Boolean) ?? '';
  return token.replace(/\\/g, '/').split('/').pop()?.replace(/\.(?:cmd|exe|bat|ps1)$/i, '').toLowerCase() ?? '';
}

function packageName(command: string): string {
  const parts = command.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? [];
  const runner = (parts[0] ?? '').replace(/^['"]|['"]$/g, '').toLowerCase();
  if (!['npx', 'npx.cmd', 'uvx'].includes(runner.split('/').pop() ?? runner)) return '';
  return (parts[2] ?? parts[1] ?? '').replace(/^['"]|['"]$/g, '').toLowerCase();
}

export function getAcpProviderAdapter(command: string): AcpProviderAdapter | null {
  const executable = executableName(command);
  const packageId = packageName(command);
  return ACP_PROVIDER_ADAPTERS.find((adapter) =>
    adapter.aliases.includes(executable) ||
    adapter.aliases.some((alias) => packageId === alias || packageId.endsWith(`/${alias}`) || packageId.includes(`${alias}-`)),
  ) ?? (packageId.endsWith('-acp') || packageId.includes('-acp-') || packageId.includes('/acp-')
    ? { id: packageId, aliases: [packageId], supportsModelSelection: true }
    : null);
}

/**
 * ACP selection and native ACP transport are separate capabilities.
 * A command marked ACP-capable by the registry may still be launched through
 * the prompt fallback until its executable is wired to the native bridge.
 */
export function getAcpCapabilities(command: string, explicitlyNative = false): AcpCapabilities {
  const adapter = getAcpProviderAdapter(command);
  const native = explicitlyNative
    || NATIVE_ACP_EXECUTABLES.has(executableName(command))
    || adapter !== null;
  return {
    protocol: 'acp',
    nativeProtocol: native,
    sessionHandoff: 'prompt-fallback',
    supportsSessionLoad: false,
    supportsSessionResume: false,
    supportsPromptContext: true,
    ...(adapter ? { adapterId: adapter.id } : {}),
    ...(native
      ? { reason: 'ACP candidate detected; session capabilities are negotiated at runtime.' }
      : { reason: 'No native ACP protocol is registered for this executable.' }),
  };
}

export function isNativeAcpCommand(command: string, explicitlyNative = false): boolean {
  return getAcpCapabilities(command, explicitlyNative).nativeProtocol;
}

/**
 * Whether a Chat with this agent should use the native ACP transport.
 *
 * An agent added from the ACP registry is ACP by definition, even when nothing
 * in its command says `acp` (`npx -y @google/gemini-cli`, `uvx some-agent`).
 * The registry entry is the evidence, so those commands are passed in instead
 * of being guessed from the command string.
 */
export function isAcpChatCommand(
  command: string | null | undefined,
  registryAcpCommands: readonly string[] = [],
  explicitlyNative = false,
): boolean {
  const trimmed = command?.trim();
  if (!trimmed) return false;
  if (isNativeAcpCommand(trimmed, explicitlyNative)) return true;
  const normalized = trimmed.toLowerCase();
  return registryAcpCommands.some((entry) => entry.trim().toLowerCase() === normalized);
}
