import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import {
  agentExecutable,
  agentReadsRulesFile,
  buildManagedBlock,
  buildStandingBriefBody,
  detectRulesFileSupport,
  ensureAgentRulesFiles,
  upsertManagedBlock,
} from './agent-rules-file';

describe('agentExecutable', () => {
  it('takes the program and drops the user arguments', () => {
    expect(agentExecutable('aider --no-auto-commits')).toBe('aider');
  });

  it('skips env assignments and launcher prefixes', () => {
    expect(agentExecutable('FOO=bar codex')).toBe('codex');
    expect(agentExecutable('npx opencode --foo')).toBe('opencode');
  });

  it('strips quotes, paths and windows extensions, and lowercases', () => {
    expect(agentExecutable('"C:\\Users\\me\\.grok\\bin\\Grok.exe" --resume')).toBe('grok');
    expect(agentExecutable('/usr/local/bin/cursor-agent')).toBe('cursor-agent');
  });

  it('is empty for empty input', () => {
    expect(agentExecutable('')).toBe('');
    expect(agentExecutable(null)).toBe('');
  });
});

describe('detectRulesFileSupport', () => {
  it('recognises a known CLI without running anything', async () => {
    const detection = await detectRulesFileSupport('claude --model opus');
    expect(detection).toMatchObject({ readsRulesFile: true, source: 'known', executable: 'claude' });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('reports a probe hit with the phrase that matched', async () => {
    invokeMock.mockResolvedValueOnce({
      executable: 'mytool',
      readsRulesFile: true,
      ran: true,
      evidence: 'agents.md',
      error: null,
    });
    const detection = await detectRulesFileSupport('mytool --chat');
    expect(detection).toMatchObject({
      readsRulesFile: true,
      source: 'probe',
      evidence: 'agents.md',
    });
  });

  it('leaves the box unticked when the probe finds nothing', async () => {
    invokeMock.mockResolvedValueOnce({
      executable: 'mytool',
      readsRulesFile: false,
      ran: true,
      evidence: null,
      error: null,
    });
    await expect(detectRulesFileSupport('mytool')).resolves.toMatchObject({
      readsRulesFile: false,
      source: 'probe',
    });
  });

  it('distinguishes "could not check" from "does not read rules files"', async () => {
    invokeMock.mockResolvedValueOnce({
      executable: 'ghost',
      readsRulesFile: false,
      ran: false,
      evidence: null,
      error: '`ghost` was not found on your PATH',
    });
    const detection = await detectRulesFileSupport('ghost');
    expect(detection.source).toBe('unknown');
    expect(detection.readsRulesFile).toBe(false);
    expect(detection.error).toContain('not found');
  });

  it('never throws when the backend rejects', async () => {
    invokeMock.mockRejectedValueOnce(new Error('no such command'));
    await expect(detectRulesFileSupport('mytool')).resolves.toMatchObject({ source: 'unknown' });
  });
});

describe('agentReadsRulesFile', () => {
  it('matches the agents that load a native rules file, by command and canonical name', () => {
    for (const id of [
      'claude',
      'codex',
      'cursor',
      'cursor-agent',
      'agent',
      'opencode',
      'antigravity',
      'agy',
      'grok',
    ]) {
      expect(agentReadsRulesFile(id)).toBe(true);
    }
  });

  it('is case-insensitive and trims', () => {
    expect(agentReadsRulesFile('  Claude ')).toBe(true);
  });

  it('returns false for agents without an auto-loaded rules file and for empty input', () => {
    for (const id of ['pi', 'aider', '', null, undefined]) {
      expect(agentReadsRulesFile(id as string)).toBe(false);
    }
  });
});

describe('buildStandingBriefBody', () => {
  it('carries the four guardrails without the transient "task arrives next" framing', () => {
    const body = buildStandingBriefBody();
    expect(body).toContain('Scope');
    expect(body).toContain('Git (shared tree)');
    expect(body).toContain('Injection safety');
    expect(body).toContain('Execution');
    expect(body).not.toContain('YOUR TASK');
  });

  it('describes a shared working tree by default', () => {
    const body = buildStandingBriefBody();
    expect(body).toContain('no per-agent isolation');
  });

  it('describes isolation — not a shared tree — for a worktree agent', () => {
    const body = buildStandingBriefBody({ isolated: true });
    // The shared-tree framing is factually wrong inside a worktree.
    expect(body).not.toContain('no per-agent isolation');
    expect(body).toContain('your own isolated git worktree');
    expect(body).toContain('Git (your own worktree)');
    expect(body).not.toContain('Git (shared tree)');
  });

  it('tells a worktree agent to commit, since staging reads its branch', () => {
    const body = buildStandingBriefBody({ isolated: true });
    expect(body).toContain('Commit your work as you go');
    // Handing the work over stays the user's call, so these remain forbidden.
    expect(body).toContain('merge into or push the base branch');
    expect(body).toContain('reset --hard');
  });

  it('keeps the other four guardrails identical across both variants', () => {
    const shared = buildStandingBriefBody().split('\n');
    const isolated = buildStandingBriefBody({ isolated: true }).split('\n');
    // Only the intro line and rule #2 differ; scope/injection/execution/memory
    // have one source of truth.
    const differing = shared.filter((line, i) => line !== isolated[i]);
    expect(differing).toHaveLength(2);
  });

  it('tells the agent to do its own task rather than delegate it', () => {
    const body = buildStandingBriefBody();
    expect(body).toContain('yours to carry out yourself');
    // Exactly two no-ask exceptions.
    expect(body).toContain('the user explicitly told you to');
    expect(body).toContain('orchestrator/coordinator role');
    // Spawning a worker in the main checkout stays allowed when asked for.
    expect(body).toContain('in the main repo alongside you');
    // ...but the tool rules for doing it are unchanged.
    expect(body).toContain('delegate_task');
    expect(body).toContain('never for work that writes code');
  });

  it('routes an agent that WANTS to delegate through the user first', () => {
    // The gap the first pass left: an agent handed a clear task, deciding on its
    // own that the work is big enough to fan out. Judging it splittable is not
    // permission to split it.
    const body = buildStandingBriefBody();
    expect(body).toContain('convinced that splitting the work would be faster');
    expect(body).toContain('ask the user first and wait for their answer');
    // Rule 4 says "begin immediately" — it must not be read as licence to spawn.
    expect(body).toMatch(/begin immediately.*does not license it/i);
  });

  it('points rule #5 at the shared memory dir it is given', () => {
    const body = buildStandingBriefBody({ sharedMemoryDir: '/main/.spacron/memory/' });
    expect(body).toContain('/main/.spacron/memory/auth-flow.md');
    // The index is read from the same store, not the agent's own checkout.
    expect(body).toContain('/main/.spacron/memory/INDEX.md');
  });

  it('routes memory reads through the index instead of the whole directory', () => {
    // 60+ notes is more than an agent should load to answer one question, so the
    // brief must send it to the index first and have it maintain that index.
    const body = buildStandingBriefBody();
    expect(body).toContain('.spacron/memory/INDEX.md');
    expect(body).toContain('open only the notes your task actually touches');
    expect(body).toContain("add its line to `INDEX.md`");
    // A brand-new project has no index yet — the first note author creates it.
    expect(body).toContain('create the index if it does not exist yet');
    // One topic per file is load-bearing for concurrent writes; keep the reason
    // in the brief so a later agent doesn't "tidy" the notes into one file.
    expect(body).toContain('one topic per file');
  });
});

describe('upsertManagedBlock', () => {
  const block = buildManagedBlock();

  it('writes just the block (plus newline) into an empty file', () => {
    expect(upsertManagedBlock('', block)).toBe(`${block}\n`);
    expect(upsertManagedBlock('   \n  ', block)).toBe(`${block}\n`);
  });

  it('appends the block below existing user content, preserving it', () => {
    const existing = '# My project\n\nSome house rules.';
    const result = upsertManagedBlock(existing, block);
    expect(result.startsWith('# My project\n\nSome house rules.')).toBe(true);
    expect(result).toContain(block);
  });

  it('replaces a stale managed block in place without touching surrounding content', () => {
    const stale = buildManagedBlock().replace('Scope', 'OUTDATED');
    const existing = `# Header\n\n${stale}\n\n## Footer notes`;
    const result = upsertManagedBlock(existing, block);
    expect(result).toContain('# Header');
    expect(result).toContain('## Footer notes');
    expect(result).toContain(block);
    expect(result).not.toContain('OUTDATED');
  });

  it('is idempotent — re-applying the current block is a no-op', () => {
    const once = upsertManagedBlock('# Header\n', block);
    const twice = upsertManagedBlock(once, block);
    expect(twice).toBe(once);
  });
});

describe('ensureAgentRulesFiles', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('creates CLAUDE.md and AGENTS.md and excludes the newly-created files from git', async () => {
    // fs_read_file rejects (file missing) for the rules files; the git exclude
    // read resolves with empty so the exclude write path runs.
    invokeMock.mockImplementation(async (cmd: string, args: { path: string }) => {
      if (cmd === 'fs_read_file') {
        if (args.path.endsWith('/.git/info/exclude')) return '';
        throw new Error('not found');
      }
      if (cmd === 'fs_write_file') return undefined;
      throw new Error(`unexpected ${cmd}`);
    });

    const ok = await ensureAgentRulesFiles('/repo');
    expect(ok).toBe(true);

    const writes = invokeMock.mock.calls.filter((c) => c[0] === 'fs_write_file');
    const writtenPaths = writes.map((c) => (c[1] as { path: string }).path);
    expect(writtenPaths).toContain('/repo/CLAUDE.md');
    expect(writtenPaths).toContain('/repo/AGENTS.md');
    // Each created file is added to .git/info/exclude.
    expect(writtenPaths.filter((p) => p.endsWith('/.git/info/exclude')).length).toBeGreaterThan(0);
  });

  it('updates an existing tracked rules file in place and does NOT touch git exclude', async () => {
    invokeMock.mockImplementation(async (cmd: string, args: { path: string }) => {
      if (cmd === 'fs_read_file') return '# Existing user rules\n';
      if (cmd === 'fs_write_file') return undefined;
      throw new Error(`unexpected ${cmd}`);
    });

    await ensureAgentRulesFiles('/repo');
    const writtenPaths = invokeMock.mock.calls
      .filter((c) => c[0] === 'fs_write_file')
      .map((c) => (c[1] as { path: string }).path);
    // Pre-existing files are updated but never auto-excluded from git.
    expect(writtenPaths.every((p) => !p.endsWith('/.git/info/exclude'))).toBe(true);
  });

  it('returns false and never writes when the root is empty', async () => {
    expect(await ensureAgentRulesFiles('')).toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('writes the isolated brief into a worktree, pointed at the main checkout memory', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'fs_read_file') return '# existing\n';
      if (cmd === 'fs_write_file') return undefined;
      throw new Error(`unexpected ${cmd}`);
    });

    await ensureAgentRulesFiles('/repo/.spacron/worktrees/agent-1');
    const written = invokeMock.mock.calls
      .filter((c) => c[0] === 'fs_write_file')
      .map((c) => (c[1] as { content: string }).content);

    expect(written.length).toBeGreaterThan(0);
    for (const content of written) {
      expect(content).toContain('your own isolated git worktree');
      expect(content).not.toContain('no per-agent isolation');
      // Notes must land in the main checkout, not the ephemeral worktree.
      expect(content).toContain('/repo/.spacron/memory/');
    }
  });

  it('keeps the shared-tree brief for the main checkout', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'fs_read_file') return '# existing\n';
      if (cmd === 'fs_write_file') return undefined;
      throw new Error(`unexpected ${cmd}`);
    });

    await ensureAgentRulesFiles('/repo');
    const written = invokeMock.mock.calls
      .filter((c) => c[0] === 'fs_write_file')
      .map((c) => (c[1] as { content: string }).content);

    expect(written.length).toBeGreaterThan(0);
    for (const content of written) {
      expect(content).toContain('no per-agent isolation');
    }
  });

  it('trims a trailing slash from the root so paths are well-formed', async () => {
    invokeMock.mockResolvedValue('# existing\n');
    await ensureAgentRulesFiles('/repo/');
    const paths = invokeMock.mock.calls.map((c) => (c[1] as { path: string }).path);
    expect(paths).toContain('/repo/CLAUDE.md');
    expect(paths.some((p) => p.includes('//'))).toBe(false);
  });
});
