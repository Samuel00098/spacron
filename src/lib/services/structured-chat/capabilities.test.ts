import { describe, expect, it } from 'vitest';
import {
  forkStructuredChat,
  providerCapabilities,
  rewindStructuredChat,
  steerStructuredChat,
  compactStructuredChat,
  structuredChatProvider,
} from './registry';

describe('structured provider capabilities and operations', () => {
  it('exposes explicit capability matrices per provider', () => {
    const codex = providerCapabilities('codex');
    expect(codex).toMatchObject({
      rewind: true,
      fork: true,
      rewindMode: 'native-provider',
      forkMode: 'native-provider',
      compact: 'native',
      steering: 'inject',
      contextUsage: true,
      mcp: true,
      subagents: { supported: true, inspectTranscript: true },
      nativeCommands: true,
      supportedAccessModes: ['ask', 'auto', 'full-access'],
    });

    const claude = providerCapabilities('claude');
    // Claude's stream-json protocol has no rollback RPC, so rewind is
    // Spacron-side; fork is the CLI's own --fork-session.
    expect(claude).toMatchObject({
      rewind: true,
      fork: true,
      rewindMode: 'conversation-reset',
      forkMode: 'native-provider',
      compact: 'native',
      steering: 'inject',
      contextUsage: true,
      mcp: true,
      subagents: { supported: true, inspectTranscript: true },
      nativeCommands: true,
      supportedAccessModes: ['ask', 'auto', 'full-access'],
    });

    const pi = providerCapabilities('pi');
    expect(pi).toMatchObject({
      rewind: false,
      fork: false,
      rewindMode: 'none',
      forkMode: 'none',
      compact: 'journal-only',
      steering: 'queue',
      contextUsage: false,
      mcp: false,
      subagents: { supported: false },
      nativeCommands: false,
      supportedAccessModes: ['ask'],
    });

    const agy = providerCapabilities('antigravity');
    expect(agy).toMatchObject({
      rewind: false,
      fork: false,
      compact: 'journal-only',
      steering: 'queue',
      contextUsage: true,
      mcp: true,
      subagents: { supported: false, spawn: false, inspectTranscript: false },
      supportedAccessModes: ['ask', 'auto', 'full-access'],
    });

    const opencode = providerCapabilities('opencode');
    expect(opencode).toMatchObject({
      rewind: false,
      fork: false,
      compact: 'journal-only',
      steering: 'queue',
      contextUsage: true,
      nativeCommands: true,
      supportedAccessModes: ['ask', 'auto'],
    });

    const grok = providerCapabilities('grok');
    expect(grok).toMatchObject({
      rewind: false,
      fork: false,
      compact: 'journal-only',
      steering: 'queue',
      supportedAccessModes: ['ask'],
    });
  });

  it('safely handles null/undefined agents', () => {
    expect(providerCapabilities(null)).toBeNull();
    expect(providerCapabilities(undefined)).toBeNull();
    expect(providerCapabilities('nonexistent')).toBeNull();
  });

  it('delegates rewind, fork, steer, and compact through registry', async () => {
    // Rewind on an unstarted session returns false gracefully
    expect(await rewindStructuredChat('codex', 999)).toBe(false);
    expect(await rewindStructuredChat('pi', 999)).toBe(false);

    // Fork on an unstarted session returns false/empty gracefully
    expect(await forkStructuredChat('codex', 999)).toBe(false);
    expect(await forkStructuredChat('pi', 999)).toBe(false);

    // Steer and compact don't crash on unstarted sessions
    await expect(steerStructuredChat('codex', 999, 'hint')).resolves.toBeUndefined();
    await expect(compactStructuredChat('codex', 999)).resolves.toBeUndefined();
  });

  it('declares subagents method on all providers', () => {
    for (const agent of ['codex', 'claude', 'pi', 'opencode', 'antigravity']) {
      const provider = structuredChatProvider(agent);
      expect(provider).toBeDefined();
      expect(typeof provider?.subagents).toBe('function');
      expect(provider?.subagents?.(123)).toEqual([]);
    }
  });
});
