import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn(async (..._args: any[]): Promise<any> => undefined));
const isProviderApiKeyConfiguredLocal = vi.hoisted(() => vi.fn(() => true));
const getProviderDef = vi.hoisted(() => vi.fn(() => ({ models: [{ id: 'gpt-4.1' }, { id: 'gpt-4o-mini' }] })));
const isLocalProvider = vi.hoisted(() => vi.fn(() => false));
const getProviderBaseUrl = vi.hoisted(() => vi.fn(() => ''));
const aiProvider = vi.hoisted(() => {
  let value = 'openrouter';
  return {
    subscribe(run: (value: string) => void) {
      run(value);
      return () => {};
    },
    set(next: string) {
      value = next;
    },
  };
});
const currentAiModel = vi.hoisted(() => {
  let value = 'gpt-4.1';
  return {
    subscribe(run: (value: string) => void) {
      run(value);
      return () => {};
    },
    set(next: string) {
      value = next;
    },
  };
});
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('$lib/services/ai-keychain', () => ({ isProviderApiKeyConfiguredLocal }));
vi.mock('$lib/stores/settings', () => ({
  aiProvider,
  currentAiModel,
  getProviderDef,
  isLocalProvider,
  getProviderBaseUrl,
}));

import {
  routeOrchestratorRequest,
  resolveAgentCommand,
  ADMIN_KEYWORD_RE,
  detectStatedPlacement,
} from './orchestrator-brain';

const ALL_AGENTS = [
  { command: 'codex', name: 'Codex CLI' },
  { command: 'claude', name: 'Claude Code' },
  { command: 'agy', name: 'Antigravity' },
  { command: 'opencode', name: 'OpenCode' },
  { command: 'pi', name: 'Pi AI Agent' },
  { command: 'agent', name: 'Cursor' },
];

describe('routeOrchestratorRequest', () => {
  beforeEach(() => {
    invoke.mockReset();
    isProviderApiKeyConfiguredLocal.mockReset().mockReturnValue(true);
    getProviderDef.mockClear();
    isLocalProvider.mockClear();
    getProviderBaseUrl.mockClear();
    aiProvider.set('openrouter');
    currentAiModel.set('gpt-4.1');
  });

  describe('read-aloud requests', () => {
    const transcript = { name: 'Iris', text: 'Added the login form and ran the tests.', truncated: false };

    it('reads a named agent transcript back verbatim without calling the LLM', async () => {
      const readAgentTranscript = vi.fn().mockReturnValue(transcript);

      const result = await routeOrchestratorRequest('read out what Iris outputted', ALL_AGENTS, {
        conversational: true,
        readAgentTranscript,
      });

      // The whole point of the fast path: no paraphrase, no LLM round trip.
      expect(invoke).not.toHaveBeenCalled();
      expect(result.viaLLM).toBe(false);
      expect(result.actions).toEqual([]);
      expect(result.reply).toContain('Added the login form and ran the tests.');
      // The resolver gets the raw message so it can match names the brain cannot see.
      expect(readAgentTranscript).toHaveBeenCalledWith('read out what Iris outputted');
    });

    it('handles the question-then-ask phrasing', async () => {
      const readAgentTranscript = vi.fn().mockReturnValue(transcript);

      const result = await routeOrchestratorRequest(
        'What was the Iris output? Can you read it out for me?',
        ALL_AGENTS,
        { conversational: true, readAgentTranscript },
      );

      expect(readAgentTranscript).toHaveBeenCalled();
      expect(result.reply).toContain('Added the login form and ran the tests.');
    });

    it('flags a truncated read so the user knows there is more', async () => {
      const readAgentTranscript = vi.fn().mockReturnValue({ ...transcript, truncated: true });

      const result = await routeOrchestratorRequest('read me Iris output', ALL_AGENTS, {
        conversational: true,
        readAgentTranscript,
      });

      expect(result.reply).toContain('most recent part');
    });

    it('falls through to the summary path when the named agent cannot be resolved', async () => {
      const readAgentTranscript = vi.fn().mockReturnValue(null);

      const result = await routeOrchestratorRequest('read out what Ghost produced', ALL_AGENTS, {
        conversational: true,
        readAgentTranscript,
        taskOutputs: [
          {
            name: 'Iris',
            agent: 'claude',
            title: 'Login form',
            status: 'complete',
            recentOutput: 'Added the login form.',
          },
        ],
      });

      expect(readAgentTranscript).toHaveBeenCalled();
      // Answers from what it does know rather than reading out the wrong agent.
      expect(result.reply).toContain('Iris');
      expect(result.viaLLM).toBe(false);
    });

    it('leaves ordinary output questions on the summary path', async () => {
      const readAgentTranscript = vi.fn().mockReturnValue(transcript);

      await routeOrchestratorRequest('what did Iris say?', ALL_AGENTS, {
        conversational: true,
        readAgentTranscript,
        taskOutputs: [
          {
            name: 'Iris',
            agent: 'claude',
            title: 'Login form',
            status: 'complete',
            recentOutput: 'Added the login form.',
          },
        ],
      });

      expect(readAgentTranscript).not.toHaveBeenCalled();
    });
  });

  it('includes durable task memory and only recent user messages in the prompt context', async () => {
    invoke.mockResolvedValueOnce('{"reply":"Sure.","actions":[]}');

    const result = await routeOrchestratorRequest('Ship it now', [{ command: 'claude', name: 'Claude' }], {
      projectName: 'Atlas',
      projectRoot: 'C:/work/Atlas',
      recentUserMessages: ['Need docs', 'Make it fast'],
      taskMemory: ['Backend [claude, complete] — dispatch: launched; finished: green'],
      taskPanel: ['In progress (1): Finish agent memory', 'To do (2): Add Docker switch; Improve canvas colors'],
      reviewingAgents: [{ name: 'Backend', agent: 'claude', title: 'Refactor the launcher (awaiting review)' }],
    });

    expect(result).toEqual({ reply: 'Sure.', actions: [], viaLLM: true });
    expect(invoke).toHaveBeenCalledTimes(1);
    const call = invoke.mock.calls[0][1] as { systemPrompt: string; userText: string };
    expect(call.userText).toContain('Current active project: Atlas at C:/work/Atlas.');
    expect(call.userText).toContain('Tasks awaiting review that can be resumed automatically:');
    expect(call.userText).toContain('- "Backend" [claude] — Refactor the launcher (awaiting review)');
    expect(call.userText).toContain('Project memory and recent task activity:');
    expect(call.userText).toContain('- Backend [claude, complete] — dispatch: launched; finished: green');
    expect(call.userText).toContain('Task panel board:');
    expect(call.userText).toContain('- In progress (1): Finish agent memory');
    expect(call.userText).toContain('- To do (2): Add Docker switch; Improve canvas colors');
    expect(call.userText).toContain('Recent user messages:');
    expect(call.userText).toContain('- Need docs');
    expect(call.userText).toContain('- Make it fast');
    expect(call.userText).toContain('New user message: Ship it now');
    expect(call.userText).not.toContain('Orchestrator:');
  });

  it('parses a close action from the model', async () => {
    invoke.mockResolvedValueOnce('{"reply":"Closing Iris.","actions":[{"kind":"close","target":"Iris"}]}');

    const result = await routeOrchestratorRequest('close iris', [{ command: 'claude', name: 'Claude' }]);

    expect(result.viaLLM).toBe(true);
    expect(result.actions).toEqual([{ kind: 'close', target: 'Iris' }]);
  });

  it('renders the application state into the prompt context', async () => {
    invoke.mockResolvedValueOnce('{"reply":"You are on the editor.","actions":[]}');

    await routeOrchestratorRequest('what file am I on?', [{ command: 'claude', name: 'Claude' }], {
      appState: {
        activeView: 'editor',
        visiblePanels: ['editor'],
        editor: {
          activeFile: 'src/app.ts',
          openFiles: ['src/app.ts', 'src/lib/x.ts'],
          dirtyFiles: ['src/lib/x.ts'],
          cursor: { line: 12, col: 4 },
          language: 'typescript',
          content: 'export const x = 1;\nconsole.log(x);',
          selection: 'const x = 1;',
        },
        terminals: [
          { label: 'Iris', agent: 'Claude Code', running: true, busy: true },
          { label: 'Terminal 2', running: true, busy: false, recentOutput: '$ npm run build\nBuild failed: TS2322' },
        ],
        preview: { url: 'http://localhost:5173/', running: true },
        branch: 'main',
        availableRuns: [{ name: 'dev', command: 'npm run dev' }],
      },
    });

    const call = invoke.mock.calls[0][1] as { userText: string };
    expect(call.userText).toContain('Application state (what the user is looking at right now):');
    expect(call.userText).toContain('- Active view: editor');
    expect(call.userText).toContain('- Active editor file: src/app.ts (cursor 12:4), typescript');
    expect(call.userText).toContain('- Unsaved changes in: src/lib/x.ts');
    expect(call.userText).toContain('- Highlighted selection in the editor:');
    expect(call.userText).toContain('const x = 1;');
    expect(call.userText).toContain('- Contents of the active file:');
    expect(call.userText).toContain('console.log(x);');
    expect(call.userText).toContain('Build failed: TS2322');
    expect(call.userText).toContain('- Preview URL: http://localhost:5173/ (dev server connected)');
    expect(call.userText).toContain('- Git branch: main');
    expect(call.userText).toContain('npm run dev');
  });

  it('parses app-control actions (navigate / open-file / preview / run / task) from the model', async () => {
    invoke.mockResolvedValueOnce(
      '{"reply":"Done.","actions":[' +
        '{"kind":"open-file","path":"src/lib/router.ts","line":42},' +
        '{"kind":"navigate","view":"Editor"},' +
        '{"kind":"preview","url":"/login"},' +
        '{"kind":"run","command":"npm test"},' +
        '{"kind":"task","op":"create","title":"Wire up auth"}]}'
    );

    const result = await routeOrchestratorRequest('open the router and run the tests', [{ command: 'claude', name: 'Claude' }]);

    expect(result.viaLLM).toBe(true);
    expect(result.actions).toEqual([
      { kind: 'open-file', path: 'src/lib/router.ts', line: 42 },
      { kind: 'navigate', view: 'editor' },
      { kind: 'preview', url: '/login' },
      { kind: 'run', command: 'npm test' },
      { kind: 'task', op: 'create', title: 'Wire up auth' },
    ]);
  });

  it('parses setting / theme actions from the model', async () => {
    invoke.mockResolvedValueOnce(
      '{"reply":"Done.","actions":[' +
        '{"kind":"setting","setting":"theme","value":"Dusk"},' +
        '{"kind":"theme","theme":"Golden Hour"},' +
        '{"kind":"setting","setting":"fontSize","value":16},' +
        '{"kind":"setting","setting":"wordWrap","value":true}]}'
    );

    const result = await routeOrchestratorRequest('use the dusk theme and bump the font', [{ command: 'claude', name: 'Claude' }]);

    expect(result.viaLLM).toBe(true);
    expect(result.actions).toEqual([
      { kind: 'setting', setting: 'theme', value: 'Dusk' },
      { kind: 'setting', setting: 'theme', value: 'Golden Hour' },
      { kind: 'setting', setting: 'fontsize', value: 16 },
      { kind: 'setting', setting: 'wordwrap', value: true },
    ]);
  });

  it('heuristically navigates to a view without an LLM, but treats "open codex" as a spawn', async () => {
    isProviderApiKeyConfiguredLocal.mockReturnValue(false);

    const nav = await routeOrchestratorRequest('show me the editor', ALL_AGENTS);
    expect(nav.viaLLM).toBe(false);
    expect(nav.actions).toEqual([{ kind: 'navigate', view: 'editor' }]);

    const hide = await routeOrchestratorRequest('hide the preview', ALL_AGENTS);
    expect(hide.actions).toEqual([{ kind: 'navigate', view: 'terminal' }]);

    // "open codex" names an agent → spawn, not navigation.
    const spawn = await routeOrchestratorRequest('open codex', ALL_AGENTS);
    expect(spawn.actions[0].kind).toBe('spawn');
  });

  it('can use an explicit llm config for voice conversations', async () => {
    invoke.mockResolvedValueOnce('{"reply":"Sure.","actions":[]}');

    await routeOrchestratorRequest('talk to the agent', [{ command: 'claude', name: 'Claude' }], {
      llmConfig: {
        provider: 'google',
        model: 'gemini-2.5-flash',
        hasApiKey: true,
        baseUrl: '',
      },
    });

    expect(invoke).toHaveBeenCalledTimes(1);
    const call = invoke.mock.calls[0][1] as { provider: string; model: string; apiKey: string };
    expect(call.provider).toBe('google');
    expect(call.model).toBe('gemini-2.5-flash');
    expect(call.apiKey).toBe('');
  });

  it('heuristically closes the running agent when no provider is configured', async () => {
    isProviderApiKeyConfiguredLocal.mockReturnValue(false);

    const result = await routeOrchestratorRequest('close it', [{ command: 'claude', name: 'Claude' }], {
      runningAgents: [{ name: 'Iris', agent: 'claude', title: 'doing stuff' }],
    });

    expect(invoke).not.toHaveBeenCalled();
    expect(result.viaLLM).toBe(false);
    expect(result.actions).toEqual([{ kind: 'close', target: 'last' }]);
  });

  it('heuristically targets a named agent and supports "close all"', async () => {
    isProviderApiKeyConfiguredLocal.mockReturnValue(false);
    const running = [
      { name: 'Iris', agent: 'claude', title: 'a' },
      { name: 'Atlas', agent: 'claude', title: 'b' },
    ];

    const named = await routeOrchestratorRequest('shut down atlas', [{ command: 'claude', name: 'Claude' }], {
      runningAgents: running,
    });
    expect(named.actions).toEqual([{ kind: 'close', target: 'Atlas' }]);

    const all = await routeOrchestratorRequest('close everything', [{ command: 'claude', name: 'Claude' }], {
      runningAgents: running,
    });
    expect(all.actions).toEqual([{ kind: 'close', target: 'all' }]);
  });

  it('does not treat a task that merely mentions "stop" as a close', async () => {
    isProviderApiKeyConfiguredLocal.mockReturnValue(false);

    const result = await routeOrchestratorRequest(
      'fix the bug that stops the build from finishing',
      [{ command: 'claude', name: 'Claude' }],
      { runningAgents: [{ name: 'Iris', agent: 'claude', title: 'x' }] }
    );

    expect(result.actions).toEqual([{ kind: 'spawn', agent: 'claude', prompt: 'fix the bug that stops the build from finishing' }]);
  });

  it('heuristically surfaces running agent output in conversational mode', async () => {
    isProviderApiKeyConfiguredLocal.mockReturnValue(false);

    const result = await routeOrchestratorRequest(
      "how's the agent doing",
      [{ command: 'claude', name: 'Claude' }],
      {
        conversational: true,
        runningAgents: [
          { name: 'Iris', agent: 'claude', title: 'Refactoring the router', recentOutput: 'npx tsc --noEmit\nFound 3 errors\n  > src/router.ts:42' },
        ],
      }
    );

    expect(result.actions).toEqual([]);
    expect(result.viaLLM).toBe(false);
    expect(result.reply).toContain('still in progress');
    expect(result.reply).toContain('Iris');
    expect(result.reply).toContain('Refactoring the router');
    expect(result.reply).toContain('router.ts');
  });

  it('answers status questions from recent task output without invoking the LLM', async () => {
    const result = await routeOrchestratorRequest(
      'is it done?',
      [{ command: 'claude', name: 'Claude' }],
      {
        taskOutputs: [
          {
            name: 'Iris',
            agent: 'claude',
            title: 'Fix the login bug',
            status: 'complete',
            recentOutput: 'npm test\nTest Files 4 passed\nDone in 12s',
          },
        ],
      }
    );

    expect(invoke).not.toHaveBeenCalled();
    expect(result.actions).toEqual([]);
    expect(result.reply).toContain('Iris is done');
    expect(result.reply).toContain('Fix the login bug');
    expect(result.reply).toContain('Done in 12s');
  });

  it('summarizes terminal output conversationally in voice mode', async () => {
    const result = await routeOrchestratorRequest(
      'summarize what the terminal said',
      [{ command: 'claude', name: 'Claude' }],
      {
        conversational: true,
        taskOutputs: [
          {
            name: 'Backend',
            agent: 'claude',
            title: 'Add OpenRouter STT',
            status: 'blocked',
            reason: 'OpenRouter requires balance for audio.',
            recentOutput: 'OpenRouter audio chat transcription failed (402 Payment Required)\nNeed to switch to Web Speech or local STT.',
          },
        ],
      }
    );

    expect(invoke).not.toHaveBeenCalled();
    expect(result.actions).toEqual([]);
    expect(result.reply).toContain('Backend is waiting for input');
    expect(result.reply).toContain('latest terminal output');
    expect(result.reply).toContain('402 Payment Required');
    expect(result.reply).not.toContain('```');
  });

  it('dispatches direct task requests in voice mode without an LLM', async () => {
    isProviderApiKeyConfiguredLocal.mockReturnValue(false);

    const result = await routeOrchestratorRequest('fix the voice mode loop', ALL_AGENTS, {
      conversational: true,
    });

    expect(invoke).not.toHaveBeenCalled();
    expect(result.actions).toEqual([
      { kind: 'spawn', agent: 'claude', prompt: 'fix the voice mode loop' },
    ]);
    expect(result.reply).toContain('keep you posted');
  });

  it('keeps vague voice-mode discussion conversational without an LLM', async () => {
    isProviderApiKeyConfiguredLocal.mockReturnValue(false);

    const result = await routeOrchestratorRequest('I think the voice mode is broken somehow', ALL_AGENTS, {
      conversational: true,
    });

    expect(invoke).not.toHaveBeenCalled();
    expect(result.actions).toEqual([]);
    expect(result.reply).toContain('Say the word');
  });

  it('answers prioritization questions from the task panel without invoking the LLM', async () => {
    const result = await routeOrchestratorRequest(
      'what should we do next?',
      [{ command: 'claude', name: 'Claude' }],
      {
        taskPanel: [
          'In progress (1): Wire task panel into orchestrator prompts',
          'To do (2): Add Docker switch; Improve canvas colors',
        ],
      }
    );

    expect(invoke).not.toHaveBeenCalled();
    expect(result.actions).toEqual([]);
    expect(result.reply).toContain('In progress');
    expect(result.reply).toContain('To do');
  });

  describe('resolveAgentCommand', () => {
    it('maps command ids, display names, and aliases to the command', () => {
      expect(resolveAgentCommand('open codex', ALL_AGENTS)).toBe('codex');
      expect(resolveAgentCommand('use Codex CLI to fix it', ALL_AGENTS)).toBe('codex');
      expect(resolveAgentCommand('spawn antigravity', ALL_AGENTS)).toBe('agy');
      expect(resolveAgentCommand('use cursor', ALL_AGENTS)).toBe('agent');
      expect(resolveAgentCommand('fire up opencode', ALL_AGENTS)).toBe('opencode');
    });

    it('returns null when no agent is named, and ignores the generic word "agent"', () => {
      expect(resolveAgentCommand('fix the login bug', ALL_AGENTS)).toBeNull();
      // "agent" alone must not resolve to Cursor (whose command happens to be "agent").
      expect(resolveAgentCommand('open an agent for me', ALL_AGENTS)).toBeNull();
    });
  });

  it('heuristically brings out the NAMED agent, not the default', async () => {
    isProviderApiKeyConfiguredLocal.mockReturnValue(false);

    const open = await routeOrchestratorRequest('open codex', ALL_AGENTS);
    expect(open.viaLLM).toBe(false);
    expect(open.actions).toEqual([{ kind: 'spawn', agent: 'codex', prompt: null }]);
    expect(open.reply).toContain('Codex CLI');

    const work = await routeOrchestratorRequest('use Codex CLI to fix the login bug', ALL_AGENTS);
    expect(work.actions).toEqual([
      { kind: 'spawn', agent: 'codex', prompt: 'use Codex CLI to fix the login bug' },
    ]);

    const idle = await routeOrchestratorRequest('spawn antigravity', ALL_AGENTS);
    expect(idle.actions).toEqual([{ kind: 'spawn', agent: 'agy', prompt: null }]);
  });

  it('still defaults to claude when no specific agent is named', async () => {
    isProviderApiKeyConfiguredLocal.mockReturnValue(false);

    const result = await routeOrchestratorRequest('refactor the router for clarity', ALL_AGENTS);
    expect(result.actions).toEqual([
      { kind: 'spawn', agent: 'claude', prompt: 'refactor the router for clarity' },
    ]);
  });

  it('resolves a display name the model returned to its command id (LLM path)', async () => {
    invoke.mockResolvedValueOnce(
      '{"reply":"On it.","actions":[{"kind":"spawn","agent":"Codex CLI","prompt":"do x","name":null}]}'
    );

    const result = await routeOrchestratorRequest('have codex do x', ALL_AGENTS);
    expect(result.viaLLM).toBe(true);
    expect(result.actions).toEqual([{ kind: 'spawn', agent: 'codex', prompt: 'do x', name: null, role: null, files: null, skipWorktree: false, placement: null }]);
  });

  it('carries a valid team role through a spawn action', async () => {
    invoke.mockResolvedValueOnce(
      '{"reply":"Splitting this up.","actions":[{"kind":"spawn","agent":"claude","prompt":"plan it","name":null,"role":"coordinator"}]}'
    );

    const result = await routeOrchestratorRequest('build a login system, plan first', ALL_AGENTS);
    expect(result.actions).toEqual([
      { kind: 'spawn', agent: 'claude', prompt: 'plan it', name: null, role: 'coordinator', files: null, skipWorktree: false, placement: null },
    ]);
  });

  it('drops an unknown role to null', async () => {
    invoke.mockResolvedValueOnce(
      '{"reply":"On it.","actions":[{"kind":"spawn","agent":"claude","prompt":"do x","name":null,"role":"wizard"}]}'
    );

    const result = await routeOrchestratorRequest('have claude do x', ALL_AGENTS);
    expect(result.actions).toEqual([{ kind: 'spawn', agent: 'claude', prompt: 'do x', name: null, role: null, files: null, skipWorktree: false, placement: null }]);
  });

  it('carries a builder file claim through a spawn action', async () => {
    invoke.mockResolvedValueOnce(
      '{"reply":"On it.","actions":[{"kind":"spawn","agent":"claude","prompt":"build the form","name":null,"role":"builder","files":["src/Login.tsx"," "," src/api.ts"]}]}'
    );

    const result = await routeOrchestratorRequest('build the login form', ALL_AGENTS);
    expect(result.actions).toEqual([
      { kind: 'spawn', agent: 'claude', prompt: 'build the form', name: null, role: 'builder', files: ['src/Login.tsx', 'src/api.ts'], skipWorktree: false, placement: null },
    ]);
  });

  it('reverts to canned reply in conversational mode when no agents are running', async () => {
    isProviderApiKeyConfiguredLocal.mockReturnValue(false);

    const result = await routeOrchestratorRequest(
      'hello there',
      [{ command: 'claude', name: 'Claude' }],
      { conversational: true }
    );

    expect(result.actions).toEqual([]);
    expect(result.viaLLM).toBe(false);
    expect(result.reply).toContain('Say the word');
  });
});

describe('ADMIN_KEYWORD_RE', () => {
  // Matching here makes a spawn skip git-worktree isolation and run directly in
  // the shared main checkout. A false positive silently removes the isolation
  // that stops concurrent agents trampling each other, so ordinary feature work
  // must never match. The first version used bare nouns (tag|ship|deploy|
  // publish|release) and matched all of the prompts below.
  const ORDINARY_WORK = [
    'add an alt tag to the hero image',
    'fix the ship date field on the order form',
    'restyle the deploy button in the toolbar',
    'update the release notes component copy',
    'rename the tag helper in utils',
    'publish is misspelled in the footer, fix it',
  ];
  it.each(ORDINARY_WORK)('does not bypass isolation for: %s', (prompt) => {
    expect(ADMIN_KEYWORD_RE.test(prompt)).toBe(false);
  });

  const RELEASE_ADMIN = [
    'git tag v2.0 and push it',
    'cut a release for 1.4',
    'bump the version to 0.8.0',
    'run npm publish',
    'push to origin once tests pass',
    'update the changelog for this release',
    'deploy to production',
  ];
  it.each(RELEASE_ADMIN)('bypasses isolation for: %s', (prompt) => {
    expect(ADMIN_KEYWORD_RE.test(prompt)).toBe(true);
  });
});

describe('detectStatedPlacement', () => {
  it.each([
    ['open claude code in a worktree', 'worktree'],
    ['spawn an agent in its own worktree', 'worktree'],
    ['launch two agents in separate worktrees', 'worktree'],
    ['open a claude agent and isolate it', 'worktree'],
    ['open claude code in the main repo', 'main'],
    ['spawn an agent in the main repository', 'main'],
    ['open an agent, no worktree', 'main'],
    ['start claude without a worktree', 'main'],
    ['open an agent directly in the repo', 'main'],
    ['open an agent in the project root', 'main'],
  ] as const)('reads "%s" as %s', (text, expected) => {
    expect(detectStatedPlacement(text)).toBe(expected);
  });

  it.each([
    // Nothing about placement at all.
    'refactor the auth module',
    'open a claude agent',
    // Naming BOTH places is a per-agent decision the model has to split — a
    // single message-level answer would silently place one of them wrong.
    'open one claude code in a worktree and another in the main repo',
    // Ordinary task text that merely contains the words. Matching these would
    // skip the placement dialog for a request that never mentioned placement.
    'remove the worktree cleanup code',
    'delete the stale worktrees',
    'merge this into the main branch',
    'fix the main repo button label',
    // A branch is where a bug lives at least as often as it is where an agent
    // should run, so "on the main branch" is no longer read as a placement — it
    // used to be, and it silently spawned an unisolated agent on task text like
    // the next line. One extra click beats editing the real working tree unasked.
    'fix the failing test on the main branch',
    'open an agent on the main branch',
    // Same trap in the other direction: "in isolation" is usually describing the
    // work, not where to run it. The imperative "isolate it" above still counts.
    'refactor the parser so it can be tested in isolation',
    'make sure these tests pass in isolation',
    'run this one in isolation',
  ])('returns null for "%s"', (text) => {
    expect(detectStatedPlacement(text)).toBeNull();
  });

  it.each([
    ['worktree', 'worktree'],
    ['a worktree', 'worktree'],
    ['isolated worktree', 'worktree'],
    // Whole-message replies still resolve, which is what keeps the voice
    // follow-up working after the mid-sentence forms above were tightened.
    ['isolation', 'worktree'],
    ['isolated', 'worktree'],
    ['main repo', 'main'],
    ['the main repo.', 'main'],
    ['main', 'main'],
    ['main branch', 'main'],
  ] as const)('reads the bare answer "%s" as %s', (text, expected) => {
    // The voice follow-up turn: the user answers "worktree" and nothing else.
    expect(detectStatedPlacement(text)).toBe(expected);
  });
});

describe('stated placement on spawn actions', () => {
  beforeEach(() => {
    invoke.mockReset();
    isProviderApiKeyConfiguredLocal.mockReturnValue(true);
  });

  it('carries an explicit per-spawn placement from the model', async () => {
    invoke.mockResolvedValueOnce(
      '{"reply":"On it.","actions":[' +
        '{"kind":"spawn","agent":"claude","prompt":null,"name":null,"placement":"worktree"},' +
        '{"kind":"spawn","agent":"claude","prompt":null,"name":null,"placement":"main"}]}'
    );

    const result = await routeOrchestratorRequest(
      'open one claude code in a worktree and another in the main repo',
      ALL_AGENTS
    );
    expect(result.actions.map((a) => (a.kind === 'spawn' ? a.placement : null))).toEqual([
      'worktree',
      'main',
    ]);
  });

  it('backfills a placement the user stated once when the model omits it', async () => {
    invoke.mockResolvedValueOnce(
      '{"reply":"On it.","actions":[' +
        '{"kind":"spawn","agent":"claude","prompt":null,"name":null},' +
        '{"kind":"spawn","agent":"claude","prompt":null,"name":null}]}'
    );

    const result = await routeOrchestratorRequest('open two agents in the main repo', ALL_AGENTS);
    expect(result.actions.map((a) => (a.kind === 'spawn' ? a.placement : null))).toEqual([
      'main',
      'main',
    ]);
  });

  it('leaves placement null when the user said nothing about it', async () => {
    invoke.mockResolvedValueOnce(
      '{"reply":"On it.","actions":[{"kind":"spawn","agent":"claude","prompt":"do x","name":null}]}'
    );

    const result = await routeOrchestratorRequest('have claude do x', ALL_AGENTS);
    expect(result.actions[0]).toMatchObject({ kind: 'spawn', placement: null });
  });

  it('honours a stated placement on the heuristic route (no AI provider)', async () => {
    isProviderApiKeyConfiguredLocal.mockReturnValue(false);

    const result = await routeOrchestratorRequest('open a claude agent in the main repo', ALL_AGENTS);
    expect(result.viaLLM).toBe(false);
    expect(result.actions[0]).toMatchObject({ kind: 'spawn', placement: 'main' });
  });
});
