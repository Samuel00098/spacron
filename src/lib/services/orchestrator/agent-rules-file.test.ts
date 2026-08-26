import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import {
  agentAttentionPhrases,
  agentExecutable,
  agentHasNativeExtras,
  agentReadsRulesFile,
  buildManagedBlock,
  buildStandingBriefBody,
  detectRulesFileSupport,
  ensureAgentRulesFiles,
  hasReadKeyOutsideBlock,
  upsertManagedBlock,
  upsertYamlManagedBlock,
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

describe('agentAttentionPhrases', () => {
  it('resolves per-CLI phrases by executable, normalising the command', () => {
    expect(agentAttentionPhrases('codex')).toContain('send?');
    expect(agentAttentionPhrases('npx opencode --foo')).toEqual(agentAttentionPhrases('opencode'));
    expect(agentAttentionPhrases('/usr/local/bin/codex.cmd')).toContain('awaiting approval');
  });

  it('returns an empty list for unknown CLIs (falls back to the universal pattern)', () => {
    expect(agentAttentionPhrases('unknowncli')).toEqual([]);
    expect(agentAttentionPhrases('')).toEqual([]);
    expect(agentAttentionPhrases(null)).toEqual([]);
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
      // The Orca-port agents verified by probing their shipped bundles (see
      // `measure_against_installed_clis` in agent_probe.rs): command-code's
      // cli.mjs carries the AGENTS.md literal.
      'command-code',
      // Codebuff/Freebuff verified against repo source + the real installed
      // binary (knowledge.ts KNOWLEDGE_FILE_NAMES = AGENTS.md, CLAUDE.md).
      'codebuff',
      'freebuff',
      // Pi/OMP/Prime Agent verified 2026-08-12 against the installed bundles
      // (resource-loader.js / compiled cli.js — AGENTS.md + CLAUDE.md context
      // files, --no-context-files flag), and vibe/autohand/ante against their
      // official docs (AGENTS.md support).
      'pi',
      'omp',
      'prime-agent',
      'vibe',
      'autohand',
      'ante',
      // Verified 2026-08-12 against official docs: rovo (AGENTS.md Project
      // Memory), mimo (AGENTS.md at workspace root), openclaude (AGENTS.md
      // primary, CLAUDE.md fallback), openclaw (AGENTS.md + CLAUDE.md),
      // hermes (context-file search order .hermes.md → AGENTS.md → CLAUDE.md).
      'rovo',
      'mimo',
      'openclaude',
      'openclaw',
      'hermes',
      // Native-extra agents: they read a file other than the universal three,
      // but the brief still arrives by file, so they take the file channel.
      'aider',
      'cn',
      'kiro-cli',
    ]) {
      expect(agentReadsRulesFile(id)).toBe(true);
    }
  });

  it('is case-insensitive and trims', () => {
    expect(agentReadsRulesFile('  Claude ')).toBe(true);
  });

  it('returns false for agents without an auto-loaded rules file and for empty input', () => {
    for (const id of ['traecli', 'cody', '', null, undefined]) {
      expect(agentReadsRulesFile(id as string)).toBe(false);
    }
  });
});

describe('agentHasNativeExtras', () => {
  it('is true for agents with any native extra, bonus or required', () => {
    expect(agentHasNativeExtras('aider')).toBe(true);
    expect(agentHasNativeExtras('cn')).toBe(true);
    expect(agentHasNativeExtras('traecli')).toBe(true);
    expect(agentHasNativeExtras('cursor-agent')).toBe(true);
  });

  it('is false for agents without extras and for empty input', () => {
    expect(agentHasNativeExtras('cody')).toBe(false);
    expect(agentHasNativeExtras('claude')).toBe(false);
    expect(agentHasNativeExtras('')).toBe(false);
    expect(agentHasNativeExtras(null)).toBe(false);
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
    expect(body).toContain('open only the ones your task actually touches');
    expect(body).toContain('add a one-line entry to `INDEX.md`');
    // A brand-new project has no index yet — the first note author creates it.
    expect(body).toContain('create the index if it does not exist yet');
    // One topic per file is load-bearing for concurrent writes; keep the reason
    // in the brief so a later agent doesn't "tidy" the notes into one file.
    expect(body).toContain('one topic per file');
  });

  it('tells the agent a note is a lead rather than an answer', () => {
    // The anchoring failure this guards: a note describing how something works
    // reads as a diagnosis already done, so the agent stops investigating and
    // "fixes" what the note said instead of what is actually broken. The brief
    // has to rank the code above the note explicitly — a note that merely says
    // it "may be outdated" still gets believed.
    const body = buildStandingBriefBody();
    expect(body).toContain('Treat a note as a lead, never as truth');
    expect(body).toMatch(/never conclude you understand a bug because a note describes it/i);
    expect(body).toMatch(/the code wins and the note is the thing that needs fixing/i);
  });

  it('keeps the note bar high enough that the index stays cheap to read', () => {
    // The index is read on EVERY task, so it is the only memory cost paid
    // unconditionally, and a criterion of "anything durable" grows it without
    // limit. Notes are restricted to what the code cannot say; everything else
    // belongs in a comment at the site, where it cannot drift out of step.
    const body = buildStandingBriefBody();
    expect(body).toContain('Write a new note only for what the code cannot tell the next agent');
    expect(body).toMatch(/tried and does not work here/i);
    expect(body).toMatch(/only fires in CI or packaging/i);
    expect(body).toMatch(/comment next to the code would carry it, write that comment instead/i);
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

  it('creates CLAUDE.md, AGENTS.md and GEMINI.md and excludes the newly-created files from git', async () => {
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
    expect(writtenPaths).toContain('/repo/GEMINI.md');
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

describe('upsertYamlManagedBlock', () => {
  it('writes just the block into an empty config', () => {
    const block = '# SORYQ:BEGIN agent-brief — managed by Spacron, do not edit by hand\nread: CONVENTIONS.md\n# SORYQ:END agent-brief';
    expect(upsertYamlManagedBlock('', block)).toBe(`${block}\n`);
  });

  it('replaces a stale YAML block in place, preserving other config', () => {
    const block = '# SORYQ:BEGIN agent-brief — managed by Spacron, do not edit by hand\nread: CONVENTIONS.md\n# SORYQ:END agent-brief';
    const stale = block.replace('CONVENTIONS.md', 'OLD.md');
    const existing = `model: gpt-4\n\n${stale}\n\nauto_commits: false`;
    const result = upsertYamlManagedBlock(existing, block);
    expect(result).toContain('model: gpt-4');
    expect(result).toContain('auto_commits: false');
    expect(result).toContain('read: CONVENTIONS.md');
    expect(result).not.toContain('OLD.md');
  });
});

describe('hasReadKeyOutsideBlock', () => {
  it('is false for a config with no read key at all', () => {
    expect(hasReadKeyOutsideBlock('model: gpt-4\nauto_commits: false')).toBe(false);
  });

  it('is false when the only read key lives inside the managed block', () => {
    const block = '# SORYQ:BEGIN agent-brief — managed by Spacron, do not edit by hand\nread: CONVENTIONS.md\n# SORYQ:END agent-brief';
    expect(hasReadKeyOutsideBlock(block)).toBe(false);
  });

  it('is true when the user config already declares a read key', () => {
    expect(hasReadKeyOutsideBlock('read: [CONVENTIONS.md, house.md]')).toBe(true);
    expect(
      hasReadKeyOutsideBlock('read: CONVENTIONS.md\n# SORYQ:BEGIN agent-brief — managed by Spacron, do not edit by hand\nread: CONVENTIONS.md\n# SORYQ:END agent-brief')
    ).toBe(true);
  });
});

describe('ensureAgentRulesFiles — native extras', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('writes the Continue rule file (frontmatter + block) for cn and reports the channel complete', async () => {
    invokeMock.mockImplementation(async (cmd: string, args: { path: string }) => {
      if (cmd === 'fs_read_file') {
        // The git exclude file exists (empty); every other read misses.
        if (args.path.endsWith('/.git/info/exclude')) return '';
        throw new Error('not found');
      }
      if (cmd === 'fs_write_file') return undefined;
      throw new Error(`unexpected ${cmd}`);
    });

    const ok = await ensureAgentRulesFiles('/repo', 'cn');
    expect(ok).toBe(true);

    const writes = invokeMock.mock.calls.filter((c) => c[0] === 'fs_write_file');
    const continueWrite = writes.find((c) => (c[1] as { path: string }).path.endsWith('.continue/rules/spacron-brief.md'));
    expect(continueWrite).toBeDefined();
    const content = (continueWrite![1] as { content: string }).content;
    expect(content).toContain('---');
    expect(content).toContain('alwaysApply: true');
    expect(content).toContain('<!-- SORYQ:BEGIN agent-brief');
    // The created rule file is kept out of the user's commits.
    const excludeWrites = writes.filter((c) => (c[1] as { path: string }).path.endsWith('/.git/info/exclude'));
    expect(excludeWrites.length).toBeGreaterThan(0);
  });

  it('writes the Kiro steering file for kiro-cli', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'fs_read_file') throw new Error('not found');
      if (cmd === 'fs_write_file') return undefined;
      throw new Error(`unexpected ${cmd}`);
    });

    const ok = await ensureAgentRulesFiles('/repo', 'kiro-cli');
    expect(ok).toBe(true);
    const paths = invokeMock.mock.calls
      .filter((c) => c[0] === 'fs_write_file')
      .map((c) => (c[1] as { path: string }).path);
    expect(paths).toContain('/repo/.kiro/steering/spacron-brief.md');
  });

  it('writes CONVENTIONS.md and an aider config directive for aider', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'fs_read_file') throw new Error('not found');
      if (cmd === 'fs_write_file') return undefined;
      throw new Error(`unexpected ${cmd}`);
    });

    const ok = await ensureAgentRulesFiles('/repo', 'aider');
    expect(ok).toBe(true);
    const writes = invokeMock.mock.calls.filter((c) => c[0] === 'fs_write_file');
    const configWrite = writes.find((c) => (c[1] as { path: string }).path.endsWith('.aider.conf.yml'));
    expect(configWrite).toBeDefined();
    expect((configWrite![1] as { content: string }).content).toContain('read: CONVENTIONS.md');
  });

  it('reports the channel incomplete for aider when the config already declares read:', async () => {
    invokeMock.mockImplementation(async (cmd: string, args: { path: string }) => {
      if (cmd === 'fs_read_file') {
        if (args.path.endsWith('.aider.conf.yml')) return 'read: [CONVENTIONS.md, house.md]\n';
        throw new Error('not found');
      }
      if (cmd === 'fs_write_file') return undefined;
      throw new Error(`unexpected ${cmd}`);
    });

    const ok = await ensureAgentRulesFiles('/repo', 'aider');
    // The universal files + CONVENTIONS.md still get written, but the paste
    // caller must NOT skip its fallback — aider would otherwise miss the brief.
    expect(ok).toBe(false);
  });

  it('writes Cursor bonus files (.cursorrules + .mdc) and stays complete via the universal trio', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'fs_read_file') throw new Error('not found');
      if (cmd === 'fs_write_file') return undefined;
      throw new Error(`unexpected ${cmd}`);
    });

    const ok = await ensureAgentRulesFiles('/repo', 'cursor-agent');
    // Cursor is a member briefed through AGENTS.md, so the channel is complete
    // even though the bonus files are only best-effort.
    expect(ok).toBe(true);

    const writes = invokeMock.mock.calls.filter((c) => c[0] === 'fs_write_file');
    const paths = writes.map((c) => (c[1] as { path: string }).path);
    expect(paths).toContain('/repo/.cursorrules');
    expect(paths).toContain('/repo/.cursor/rules/spacron-brief.mdc');

    const mdcWrite = writes.find((c) =>
      (c[1] as { path: string }).path.endsWith('.cursor/rules/spacron-brief.mdc')
    );
    const mdc = (mdcWrite![1] as { content: string }).content;
    expect(mdc).toContain('description: Spacron agent operating brief');
    expect(mdc).toContain('alwaysApply: true');
    expect(mdc).toContain('<!-- SORYQ:BEGIN agent-brief');
  });

  it('counts a bonus file toward completeness when the universal writes fail', async () => {
    invokeMock.mockImplementation(async (cmd: string, args: { path: string }) => {
      if (cmd === 'fs_read_file') throw new Error('not found');
      if (cmd === 'fs_write_file') {
        const p = args.path;
        if (p.endsWith('/CLAUDE.md') || p.endsWith('/AGENTS.md') || p.endsWith('/GEMINI.md')) {
          throw new Error('read-only');
        }
        return undefined;
      }
      throw new Error(`unexpected ${cmd}`);
    });

    const ok = await ensureAgentRulesFiles('/repo', 'cursor-agent');
    // AGENTS.md failed but .cursorrules landed, so the brief still arrived.
    expect(ok).toBe(true);
  });

  it('writes the TRAE IDE rule file for traecli but still reports the channel incomplete', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'fs_read_file') throw new Error('not found');
      if (cmd === 'fs_write_file') return undefined;
      throw new Error(`unexpected ${cmd}`);
    });

    const ok = await ensureAgentRulesFiles('/repo', 'traecli');
    // traecli is NOT a member — the paste must keep delivering.
    expect(ok).toBe(false);

    const paths = invokeMock.mock.calls
      .filter((c) => c[0] === 'fs_write_file')
      .map((c) => (c[1] as { path: string }).path);
    expect(paths).toContain('/repo/.trae/rules/project_rules.md');
    // A bonus-only non-member triggers no universal-trio writes.
    expect(
      paths.some((p) => p.endsWith('/CLAUDE.md') || p.endsWith('/AGENTS.md') || p.endsWith('/GEMINI.md'))
    ).toBe(false);
  });

  it('writes the verified bonus files for copilot, hermes, goose and cline', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'fs_read_file') throw new Error('not found');
      if (cmd === 'fs_write_file') return undefined;
      throw new Error(`unexpected ${cmd}`);
    });

    const cases = [
      ['copilot', '.github/copilot-instructions.md'],
      ['hermes', '.hermes.md'],
      ['goose', '.goosehints'],
      ['cline', '.clinerules'],
    ] as const;
    for (const [key, expected] of cases) {
      invokeMock.mockClear();
      const ok = await ensureAgentRulesFiles('/repo', key);
      expect(ok).toBe(true);
      const paths = invokeMock.mock.calls
        .filter((c) => c[0] === 'fs_write_file')
        .map((c) => (c[1] as { path: string }).path);
      expect(paths).toContain(`/repo/${expected}`);
    }
  });

  it('updates an existing Continue rule file in place, preserving user frontmatter edits', async () => {
    invokeMock.mockImplementation(async (cmd: string, args: { path: string }) => {
      if (cmd === 'fs_read_file') {
        if (args.path.endsWith('.continue/rules/spacron-brief.md')) {
          return [
            '---',
            'name: Renamed by the user',
            'alwaysApply: true',
            '---',
            '',
            buildManagedBlock().replace('Scope', 'OUTDATED'),
            '',
          ].join('\n');
        }
        throw new Error('not found');
      }
      if (cmd === 'fs_write_file') return undefined;
      throw new Error(`unexpected ${cmd}`);
    });

    const ok = await ensureAgentRulesFiles('/repo', 'cn');
    expect(ok).toBe(true);

    const continueWrite = invokeMock.mock.calls
      .filter((c) => c[0] === 'fs_write_file')
      .find((c) => (c[1] as { path: string }).path.endsWith('.continue/rules/spacron-brief.md'));
    expect(continueWrite).toBeDefined();
    const content = (continueWrite![1] as { content: string }).content;
    // The user's frontmatter survives; only the managed block is refreshed.
    expect(content).toContain('name: Renamed by the user');
    expect(content).not.toContain('OUTDATED');
    expect(content).toContain('<!-- SORYQ:BEGIN agent-brief');
  });
});

describe('the standing brief tells agents how to be heard', () => {
  it('names the tool, the token and the env var', () => {
    const body = buildStandingBriefBody();
    // Without all three the agent either never reports, or reports
    // unattributed — which cannot end its turn. See agent-report-status.md.
    expect(body).toContain('report_status');
    expect(body).toContain('agent_token');
    expect(body).toContain('SPACRON_AGENT_TOKEN');
  });

  it('says the report is what raises the notification', () => {
    // The instruction has to carry the *reason*, or it reads as bookkeeping
    // and gets skipped under load.
    expect(buildStandingBriefBody()).toMatch(/only way the user is notified/i);
  });

  it('keeps its rules numbered in order', () => {
    const numbers = [...buildStandingBriefBody().matchAll(/^(\d+)\. \*\*/gm)].map((m) =>
      Number(m[1]),
    );
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});
