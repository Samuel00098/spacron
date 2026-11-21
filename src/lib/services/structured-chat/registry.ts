import type { StructuredAccess, StructuredChatState } from './codex-session';
import { codexProvider } from './codex-session';
import { claudeProvider } from './claude-session';
import { createAcpProvider } from './acp-session';
import { piProvider } from './pi-session';
import type {
  StructuredChatProvider,
  StructuredProviderCapabilities,
  StructuredSubagentSession,
} from './provider';
import {
  answerMcpSubagent,
  cancelMcpSubagent,
  listMcpSubagents,
  openMcpSubagentPane,
  spawnMcpSubagent,
  subscribeMcpSubagents,
} from './mcp-subagents';

const providers = new Map<string, StructuredChatProvider>([
  [codexProvider.agent, codexProvider],
  [claudeProvider.agent, claudeProvider],
  ...['opencode', 'grok', 'antigravity', 'cursor', 'copilot', 'kimi', 'hermes', 'omp'].map((agent) => [agent, createAcpProvider(agent)] as const),
  [piProvider.agent, piProvider],
]);

export function structuredChatProvider(agent: string | null | undefined): StructuredChatProvider | null {
  return agent ? providers.get(agent) ?? null : null;
}

export function providerCapabilities(agent: string | null | undefined): StructuredProviderCapabilities | null {
  return structuredChatProvider(agent)?.capabilities ?? null;
}

export function registerStructuredChatProvider(provider: StructuredChatProvider): void {
  providers.set(provider.agent, provider);
}

export function getStructuredChat(agent: string | null | undefined, sessionId: number): StructuredChatState | null {
  return structuredChatProvider(agent)?.get(sessionId) ?? null;
}

export function subscribeStructuredChat(agent: string | null | undefined, listener: () => void): () => void {
  return structuredChatProvider(agent)?.subscribe(listener) ?? (() => {});
}

export async function startStructuredChat(agent: string, sessionId: number, cwd: string, options?: { access?: StructuredAccess; resumeId?: string | null }): Promise<void> {
  const provider = structuredChatProvider(agent);
  if (!provider) throw new Error(`No structured chat provider for ${agent}`);
  await provider.start(sessionId, cwd, options);
}

export async function sendStructuredChat(agent: string, sessionId: number, text: string, images: string[] = []): Promise<void> {
  await structuredChatProvider(agent)?.send(sessionId, text, images);
}

export async function interruptStructuredChat(agent: string, sessionId: number): Promise<void> {
  await structuredChatProvider(agent)?.interrupt(sessionId);
}

export function setStructuredChatModel(agent: string, sessionId: number, model: string): void {
  structuredChatProvider(agent)?.setModel(sessionId, model);
}

export function setStructuredChatEffort(agent: string, sessionId: number, effort: string): void {
  structuredChatProvider(agent)?.setEffort(sessionId, effort);
}

export function setStructuredChatAccess(agent: string, sessionId: number, access: StructuredAccess): void {
  structuredChatProvider(agent)?.setAccess(sessionId, access);
}

export async function answerStructuredChatApproval(agent: string, sessionId: number, requestId: string | number, decision: 'accept' | 'acceptForSession' | 'decline', optionId?: string): Promise<void> {
  await structuredChatProvider(agent)?.answerApproval(sessionId, requestId, decision, optionId);
}

export async function closeStructuredChat(agent: string, sessionId: number): Promise<void> {
  await structuredChatProvider(agent)?.close(sessionId);
}

export async function rewindStructuredChat(agent: string, sessionId: number, target?: { turnId?: string; checkpointId?: string } | number): Promise<boolean> {
  const provider = structuredChatProvider(agent);
  if (!provider?.rewind) return false;
  return provider.rewind(sessionId, target);
}

export async function forkStructuredChat(agent: string, sessionId: number, newSessionId?: number): Promise<{ nativeSessionId: string | null } | boolean> {
  const provider = structuredChatProvider(agent);
  if (!provider?.fork) return false;
  return provider.fork(sessionId, newSessionId);
}

export async function steerStructuredChat(agent: string, sessionId: number, text: string, images: string[] = []): Promise<void> {
  const provider = structuredChatProvider(agent);
  if (provider?.steer) await provider.steer(sessionId, text, images);
  else await provider?.send(sessionId, text, images);
}

export async function compactStructuredChat(agent: string, sessionId: number): Promise<void> {
  const provider = structuredChatProvider(agent);
  if (provider?.compact) await provider.compact(sessionId);
  else await provider?.send(sessionId, '/compact');
}

export function getStructuredSubagents(agent: string, sessionId: number): StructuredSubagentSession[] {
  const provider = structuredChatProvider(agent);
  const providerSubs = provider?.subagents?.(sessionId) ?? provider?.get(sessionId)?.subagents ?? [];
  const mcpSubs = listMcpSubagents(sessionId);
  const map = new Map<string, StructuredSubagentSession>();
  // The origin tells the UI whose subagent tree this is: the provider's own
  // (only when its adapter really implements it) or one Spacron spawned.
  for (const s of providerSubs) map.set(s.id, { ...s, origin: 'native' });
  for (const s of mcpSubs) map.set(s.id, { ...s, origin: s.origin ?? 'spacron' });
  return Array.from(map.values());
}

export function subscribeStructuredSubagents(sessionId: number, listener: () => void): () => void {
  return subscribeMcpSubagents(sessionId, listener);
}

/** True when this adapter really implements its own subagent tree. */
export function providerOwnsSubagents(agent: string | null | undefined): boolean {
  const provider = structuredChatProvider(agent);
  return Boolean(provider?.spawnSubagent && provider.capabilities?.subagents.spawn);
}

export async function spawnStructuredSubagent(
  agent: string,
  sessionId: number,
  assignment: string,
  options?: { agent?: string; model?: string },
): Promise<StructuredSubagentSession | null> {
  const provider = structuredChatProvider(agent);
  if (providerOwnsSubagents(agent) && provider?.spawnSubagent) {
    try {
      const child = await provider.spawnSubagent(sessionId, assignment, options);
      return { ...child, origin: 'native' };
    } catch (e) {
      console.warn('[structured-chat] Provider spawnSubagent failed, falling back to Spacron MCP:', e);
    }
  }
  // Native Spacron MCP engine: a separate agent session, isolated in a worktree
  // when the parent's record has a project.
  return spawnMcpSubagent(sessionId, assignment, { preset: options?.agent, model: options?.model });
}

export async function answerStructuredSubagent(agent: string, sessionId: number, subagentId: string, answer: string): Promise<void> {
  const provider = structuredChatProvider(agent);
  if (provider?.answerSubagent) {
    try {
      await provider.answerSubagent(sessionId, subagentId, answer);
      return;
    } catch {}
  }
  await answerMcpSubagent(subagentId, answer);
}

export async function cancelStructuredSubagent(agent: string, sessionId: number, subagentId: string): Promise<void> {
  const provider = structuredChatProvider(agent);
  if (provider?.cancelSubagent) {
    try {
      await provider.cancelSubagent(sessionId, subagentId);
      return;
    } catch {}
  }
  await cancelMcpSubagent(subagentId);
}

export function openStructuredSubagent(subagentId: string): void {
  openMcpSubagentPane(subagentId);
}
