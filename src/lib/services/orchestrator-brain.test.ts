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
  ORCHESTRATOR_USER_TEXT_CHAR_LIMIT,
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
    invoke.mockResolvedValueOnce('{"reply":"Backend reports its checks are green.","actions":[]}');

    const result = await routeOrchestratorRequest('Ship it now', [{ command: 'claude', name: 'Claude' }], {
      projectName: 'Atlas',
      projectRoot: 'C:/work/Atlas',
      recentUserMessages: ['Need docs', 'Make it fast'],
      taskMemory: ['Backend [claude, complete] — dispatch: launched; finished: green'],
      taskPanel: ['In progress (1): Finish agent memory', 'To do (2): Add Docker switch; Improve canvas colors'],
      reviewingAgents: [{ name: 'Backend', agent: 'claude', title: 'Refactor the launcher (awaiting review)' }],
    });

    expect(result).toEqual({ reply: 'Backend reports its checks are green.', actions: [], viaLLM: true });
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

  it('preserves the model input-required signal without treating every question as blocking', async () => {
    invoke.mockResolvedValueOnce('{"reply":"Which module should I change?","needsInput":true,"actions":[]}');

    const result = await routeOrchestratorRequest('Refactor it', [{ command: 'claude', name: 'Claude' }], {
      conversational: true,
    });

    expect(result).toMatchObject({
      reply: 'Which module should I change?',
      actions: [],
      needsInput: true,
      viaLLM: true,
    });
    expect(String((invoke.mock.calls[0]?.[1] as { systemPrompt?: string })?.systemPrompt)).toContain('Set needsInput to true only');
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

  it('renders the project tree and fetched project files into the prompt context', async () => {
    invoke.mockResolvedValueOnce('{"reply":"Found it.","actions":[]}');

    await routeOrchestratorRequest('what does the rate limiter do?', [{ command: 'claude', name: 'Claude' }], {
      projectTree: '[dir] src\n[file] src/lib/rate-limit.ts',
      projectReads: [
        { path: 'src/lib/rate-limit.ts', content: 'export const MAX_RPS = 42;', truncated: false },
        { path: 'src/lib/too-big.ts', content: '…', truncated: true },
      ],
    });

    const call = invoke.mock.calls[0][1] as { userText: string };
    expect(call.userText).toContain('Project structure (file tree, relative to the project root):');
    expect(call.userText).toContain('src/lib/rate-limit.ts');
    expect(call.userText).toContain('Files fetched from the project for you to answer from:');
    expect(call.userText).toContain('export const MAX_RPS = 42;');
  });

  it('keeps oversized assembled context below the backend input limit', async () => {
    invoke.mockResolvedValueOnce('{"reply":"I can continue from the available context.","actions":[]}');

    await routeOrchestratorRequest('Please continue the review.', ALL_AGENTS, {
      projectName: 'Large project',
      projectRoot: 'C:/work/large-project',
      projectTree: '[file] src/App.tsx\n'.repeat(2_000),
      projectReads: Array.from({ length: 8 }, (_, index) => ({
        path: `src/file-${index}.ts`,
        content: 'project source '.repeat(600),
        truncated: true,
      })),
      toolResults: [{
        id: 'review',
        name: 'read_project',
        ok: true,
        output: 'broad project source '.repeat(4_000),
      }],
      conversation: Array.from({ length: 12 }, (_, index) => ({
        role: index % 2 ? 'assistant' : 'user',
        text: 'conversation context '.repeat(100),
      })),
    });

    const call = invoke.mock.calls[0][1] as { userText: string };
    expect(call.userText.length).toBeLessThanOrEqual(ORCHESTRATOR_USER_TEXT_CHAR_LIMIT);
    expect(call.userText).toContain('[Earlier context was trimmed to fit the orchestrator input limit.]');
    expect(call.userText).toContain('New user message: Please continue the review.');
  });

  it('instructs the brain to review and recommend directly before delegating', async () => {
    invoke.mockResolvedValueOnce('{"reply":"I found three areas to improve.","actions":[]}');

    const result = await routeOrchestratorRequest('go through the application and suggest three improvements', ALL_AGENTS);

    expect(result.actions).toEqual([]);
    const call = invoke.mock.calls[0][1] as { systemPrompt: string };
    expect(call.systemPrompt).toContain('DIRECT-FIRST POLICY');
    expect(call.systemPrompt).toContain('call read_project first');
    expect(call.systemPrompt).toContain('Broad inspection is not by itself a reason to delegate.');
    expect(call.systemPrompt).toContain('Never claim an operation is complete from intention alone');
  });

  it('keeps broad review requests direct in the no-provider fallback', async () => {
    isProviderApiKeyConfiguredLocal.mockReturnValue(false);

    const result = await routeOrchestratorRequest('go through the application and suggest improvements', ALL_AGENTS);

    expect(invoke).not.toHaveBeenCalled();
    expect(result.actions).toEqual([]);
    expect(result.viaLLM).toBe(false);
    expect(result.reply).toContain('review it here without launching an agent');
  });

  it('uses read tools for a review and returns recommendations without an agent action', async () => {
    invoke
      .mockResolvedValueOnce('{"reply":"The main improvement is to split the largest panel.","actions":[]}')
      .mockResolvedValueOnce('{"tool_calls":[{"id":"plan","name":"update_todos","args":{"todos":["[~] Inspect project structure","[ ] Inspect core modules","[ ] Inspect UI structure","[ ] Verify findings"]}}]}')
      .mockResolvedValueOnce('{"tool_calls":[{"id":"read","name":"read_file","args":{"path":"src/App.tsx"}}]}')
      .mockResolvedValueOnce('{"reply":"The main improvement is to split the largest panel.","actions":[]}');
    const toolExecutor = vi.fn(async (call: { name: string }) => ({
      output: call.name === 'read_project'
        ? 'Files matching "src/**/*.tsx" (1):\\n- src/App.tsx'
        : `${call.name} ok`,
    }));

    const result = await routeOrchestratorRequest('review the application structure and suggest an improvement', ALL_AGENTS, { toolExecutor, projectRoot: '/repo' });

    expect(toolExecutor).toHaveBeenCalledTimes(3);
    expect(toolExecutor.mock.calls[0]?.[0]).toMatchObject({ name: 'read_project' });
    expect(result.actions).toEqual([]);
    expect(result.reply).toContain('split the largest panel');
  });

  it('demands read evidence before accepting an advice-review FINAL even without broad-review phrasing', async () => {
    invoke
      .mockResolvedValueOnce('{"tool_calls":[{"id":"1","name":"read_project","args":{}}]}')
      .mockResolvedValueOnce('{"reply":"I have inspected the project and it looks fine.","actions":[]}')
      .mockResolvedValueOnce('{"reply":"I have inspected the project and it looks fine.","actions":[]}');
    const toolExecutor = vi.fn(async () => ({ output: 'error: unable to read the project' }));

    const result = await routeOrchestratorRequest('inspect the project and suggest improvements', ALL_AGENTS, {
      toolExecutor,
      projectRoot: '/repo',
    });

    expect(invoke).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ failed: true, actions: [] });
    expect(result.reply).toContain('could not complete the project review');
  });

  it('auto-continues a deferral and accepts the evidenced final answer', async () => {
    invoke
      .mockResolvedValueOnce('{"tool_calls":[{"id":"1","name":"read_project","args":{}}]}')
      .mockResolvedValueOnce('{"reply":"I have inspected the project at a high level. The most valuable next step is the schema review, then I can give you concrete recommendations.","actions":[]}')
      .mockResolvedValueOnce('{"tool_calls":[{"id":"plan","name":"update_todos","args":{"todos":["[~] Inspect schema","[ ] Inspect auth checks","[ ] Inspect UI","[ ] Verify findings"]}}]}')
      .mockResolvedValueOnce('{"tool_calls":[{"id":"read","name":"read_file","args":{"path":"src/schema.ts"}}]}')
      .mockResolvedValueOnce('{"reply":"- The users table lacks an index on email\\n- The auth check scans the whole table","actions":[]}');
    const toolExecutor = vi.fn(async () => ({ output: 'Read 12 files from the project' }));

    const result = await routeOrchestratorRequest('inspect the project and suggest improvements', ALL_AGENTS, {
      toolExecutor,
      projectRoot: '/repo',
    });

    expect(invoke).toHaveBeenCalledTimes(5);
    expect(result.reply).toContain('lacks an index');
    expect(result.failed).toBeFalsy();
    expect(invoke.mock.calls.some((call) => String((call[1] as { userText: string }).userText).includes('complete 3-6 item plan'))).toBe(true);
  });

  it('continues an incomplete project snapshot before accepting review findings', async () => {
    invoke
      .mockResolvedValueOnce('{"tool_calls":[{"id":"1","name":"read_project","args":{"max_files":80}}]}')
      .mockResolvedValueOnce('{"reply":"I reviewed the project at a high level and found several improvements.","actions":[]}')
      .mockResolvedValueOnce('{"tool_calls":[{"id":"2","name":"read_project","args":{"max_files":80,"offset":39}}]}')
      .mockResolvedValueOnce('{"reply":"- The schema needs an index\\n- The UI should split the largest panel","actions":[]}');
    const toolExecutor = vi.fn(async (call: { args?: { offset?: number } }) => ({
      output: call.args?.offset
        ? 'Broad project snapshot: read 41 of 41 relevant text file(s), 90000 characters.'
        : 'Broad project snapshot: read 39 of 80 relevant text file(s), 120000 characters. Some files were omitted or truncated for safety.',
    }));

    const result = await routeOrchestratorRequest('inspect the project and suggest improvements', ALL_AGENTS, {
      toolExecutor,
      projectRoot: '/repo',
    });

    expect(invoke).toHaveBeenCalledTimes(4);
    // The snapshot is now pre-gathered for "the project" phrasing too (call 1),
    // then the model's own round (call 2) and the continuation offset round.
    expect(toolExecutor).toHaveBeenCalledTimes(3);
    expect(toolExecutor.mock.calls[0]?.[0]).toMatchObject({ name: 'read_project', args: { max_files: 80 } });
    expect(toolExecutor.mock.calls[2]?.[0]).toMatchObject({ name: 'read_project', args: { offset: 39 } });
    expect(result.reply).toContain('schema needs an index');
    expect(result.failed).toBeFalsy();
  });

  it('accepts an evidenced completion without extra recovery calls', async () => {
    invoke
      .mockResolvedValueOnce('{"tool_calls":[{"id":"1","name":"read_project","args":{}}]}')
      .mockResolvedValueOnce('{"reply":"- Split the largest panel\\n- Extract the brain loop","actions":[]}')
      .mockResolvedValueOnce('{"tool_calls":[{"id":"plan","name":"update_todos","args":{"todos":["[~] Inspect structure","[ ] Inspect modules","[ ] Inspect UI","[ ] Verify findings"]}}]}')
      .mockResolvedValueOnce('{"tool_calls":[{"id":"read","name":"read_file","args":{"path":"src/App.tsx"}}]}')
      .mockResolvedValueOnce('{"reply":"- Split the largest panel\\n- Extract the brain loop","actions":[]}');
    const toolExecutor = vi.fn(async () => ({ output: 'Read 12 files from the project' }));

    const result = await routeOrchestratorRequest('inspect the project and suggest improvements', ALL_AGENTS, {
      toolExecutor,
      projectRoot: '/repo',
    });

    expect(invoke).toHaveBeenCalledTimes(5);
    expect(result.reply).toContain('Split the largest panel');
    expect(result.failed).toBeFalsy();
  });

  it('does not claim a broad review when the inspection tool fails', async () => {
    invoke
      .mockResolvedValueOnce('{"reply":"I reviewed the application and found several improvements.","actions":[]}')
      .mockResolvedValueOnce('{"reply":"I reviewed the application and found several improvements.","actions":[]}');
    const toolExecutor = vi.fn(async () => ({ output: 'error: unable to read the project' }));

    const result = await routeOrchestratorRequest('review the application and suggest improvements', ALL_AGENTS, {
      toolExecutor,
      projectRoot: '/repo',
    });

    expect(result).toMatchObject({ failed: true, actions: [] });
    expect(result.reply).toContain('could not complete the project review');
    expect(result.reply).not.toContain('found several improvements');
  });

  it('corrects a model that tries to delegate a direct review', async () => {
    invoke
      .mockResolvedValueOnce('{"reply":"I will ask Claude to review it.","actions":[{"kind":"spawn","agent":"claude","prompt":"review the app"}]}')
      .mockResolvedValueOnce('{"reply":"I reviewed the application directly.","actions":[]}');

    const result = await routeOrchestratorRequest('review the application and suggest improvements', ALL_AGENTS, {
      toolExecutor: vi.fn(async () => ({ output: 'not used' })),
    });

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(result.actions).toEqual([]);
    expect(result.reply).toContain('reviewed the application directly');
    expect((invoke.mock.calls[1][1] as { userText: string }).userText).toContain('This is a direct review and recommendation request');
  });

  it('carries model-requested readFiles into the result so the app can fetch them', async () => {
    invoke.mockResolvedValueOnce(
      '{"reply":"Let me check that.","actions":[],"readFiles":["src/lib/auth.ts","../escape/this.ts"]}'
    );

    const result = await routeOrchestratorRequest('how is auth wired?', [{ command: 'claude', name: 'Claude' }]);

    expect(result.viaLLM).toBe(true);
    expect(result.actions).toEqual([]);
    // Sanitisation of unsafe paths happens in the app layer, not the parser.
    expect(result.readFiles).toEqual(['src/lib/auth.ts', '../escape/this.ts']);
  });

  it('asks which running agent to delegate to rather than auto-spawning for coding work', async () => {
    isProviderApiKeyConfiguredLocal.mockReturnValue(false);

    const result = await routeOrchestratorRequest(
      'fix the login bug',
      ALL_AGENTS,
      { runningAgents: [{ name: 'Neo', agent: 'claude', title: 'working' }] }
    );

    expect(invoke).not.toHaveBeenCalled();
    expect(result.viaLLM).toBe(false);
    expect(result.actions).toEqual([]);
    expect(result.needsInput).toBe(true);
    expect(result.reply).toContain('Neo');
    expect(result.reply).toContain('delegate');
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
    invoke.mockResolvedValueOnce('{"reply":"There is no active agent to contact.","actions":[]}');

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

  it('surfaces a keychain/auth failure from the actual orchestrator request', async () => {
    invoke.mockRejectedValueOnce(new Error('openai API key is not set.'));

    const result = await routeOrchestratorRequest('review the application', ALL_AGENTS, {
      llmConfig: {
        provider: 'openai',
        model: 'gpt-5.4-mini',
        hasApiKey: true,
      },
    });

    expect(result).toMatchObject({ viaLLM: false, failed: true, actions: [] });
    expect(result.reply).toContain('desktop keychain could not provide');
    expect(result.reply).toContain('saved openai API key');
    expect(result.reply).not.toContain('Add the OpenAI API key');
  });

  it('does not retry another model after the local input limit rejects the request', async () => {
    invoke.mockRejectedValue(new Error('Input text exceeds maximum length'));

    const result = await routeOrchestratorRequest('review the application', ALL_AGENTS, {
      llmConfig: {
        provider: 'openrouter',
        model: 'gpt-4.1',
        hasApiKey: true,
      },
    });

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ viaLLM: false, failed: true, actions: [] });
    expect(result.reply).toContain('input context is too large');
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

  it('does not treat a task that merely mentions "stop" as a close — it asks before delegating', async () => {
    isProviderApiKeyConfiguredLocal.mockReturnValue(false);

    const result = await routeOrchestratorRequest(
      'fix the bug that stops the build from finishing',
      [{ command: 'claude', name: 'Claude' }],
      { runningAgents: [{ name: 'Iris', agent: 'claude', title: 'x' }] }
    );

    expect(result.actions).not.toEqual([expect.objectContaining({ kind: 'close' })]);
    expect(result.actions).toEqual([]);
    expect(result.needsInput).toBe(true);
    expect(result.reply).toContain('delegate');
    expect(result.reply).toContain('Iris');
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

  it('asks before delegating direct task requests in voice mode without an LLM', async () => {
    isProviderApiKeyConfiguredLocal.mockReturnValue(false);

    const result = await routeOrchestratorRequest('fix the voice mode loop', ALL_AGENTS, {
      conversational: true,
    });

    expect(invoke).not.toHaveBeenCalled();
    expect(result.actions).toEqual([]);
    expect(result.needsInput).toBe(true);
    expect(result.reply).toContain('delegate');
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

  it('asks which agent to use rather than defaulting to claude for unnamed tasks', async () => {
    isProviderApiKeyConfiguredLocal.mockReturnValue(false);

    const result = await routeOrchestratorRequest('refactor the router for clarity', ALL_AGENTS);
    expect(result.actions).toEqual([]);
    expect(result.needsInput).toBe(true);
    expect(result.reply).toContain('delegate');
    expect(result.reply).toContain('Claude');
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

  it('executes read_file tool calls and re-prompts with the result', async () => {
    invoke
      .mockResolvedValueOnce('{"tool_calls":[{"id":"1","name":"read_file","args":{"path":"package.json"}}]}')
      .mockResolvedValueOnce('{"reply":"Found it.","actions":[]}');
    const toolExecutor = vi.fn(async (_call: unknown) => ({ output: '- package.json:\n{"name":"atlas"}' }));

    const result = await routeOrchestratorRequest('what is this project?', ALL_AGENTS, { toolExecutor });

    expect(toolExecutor).toHaveBeenCalledTimes(1);
    expect(toolExecutor.mock.calls[0]?.[0]).toMatchObject({ name: 'read_file' });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ reply: 'Found it.', viaLLM: true });
    // Second prompt carries the tool output so the model answers from source.
    const secondCall = invoke.mock.calls[1][1] as { userText: string };
    expect(secondCall.userText).toContain('tool_result 1 (read_file, ok)');
    expect(secondCall.userText).toContain('atlas');
  });

  it('falls back to legacy readFiles when no executor is wired', async () => {
    invoke.mockResolvedValueOnce('{"tool_calls":[{"id":"1","name":"read_file","args":{"path":"src/lib/auth.ts"}}]}');

    const result = await routeOrchestratorRequest('how is auth wired?', ALL_AGENTS);

    expect(result.readFiles).toEqual(['src/lib/auth.ts']);
    expect(result.viaLLM).toBe(true);
  });

  it('ends the turn as a blocking question when the model calls ask_user', async () => {
    invoke.mockResolvedValueOnce('{"tool_calls":[{"id":"1","name":"ask_user","args":{"question":"Which module?"}}]}');
    const toolExecutor = vi.fn(async (_call: unknown) => ({ output: 'noted' }));

    const result = await routeOrchestratorRequest('refactor it', ALL_AGENTS, { toolExecutor });

    expect(result).toMatchObject({ reply: 'Which module?', needsInput: true, viaLLM: true });
    expect(toolExecutor).not.toHaveBeenCalled();
  });

  it('stops looping after maxToolRounds and forces a final answer', async () => {
    invoke
      .mockResolvedValueOnce('{"tool_calls":[{"id":"1","name":"list_agents","args":{}}]}')
      .mockResolvedValueOnce('{"reply":"Done.","actions":[]}');
    const toolExecutor = vi.fn(async (_call: unknown) => ({ output: 'Running: none' }));

    const result = await routeOrchestratorRequest('look up the agents and draft the standup note', ALL_AGENTS, {
      toolExecutor,
      maxToolRounds: 1,
    });

    expect(toolExecutor).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ reply: 'Done.' });
  });

  it('ends the turn with options when the model calls ask_question', async () => {
    invoke.mockResolvedValueOnce(
      '{"tool_calls":[{"id":"1","name":"ask_question","args":{"question":"Iris asks: Postgres or SQLite?","options":["Postgres","SQLite"],"target":"Iris"}}]}',
    );
    const toolExecutor = vi.fn(async (_call: unknown) => ({ output: 'noted' }));

    const result = await routeOrchestratorRequest('have iris set up the database', ALL_AGENTS, { toolExecutor });

    expect(toolExecutor).not.toHaveBeenCalled();
    expect(result).toMatchObject({ needsInput: true, viaLLM: true });
    expect(result.reply).toContain('Iris is waiting on you');
    expect(result.reply).toContain('1. Postgres');
    expect(result.reply).toContain('2. SQLite');
  });

  it('runs reads concurrently and writes sequentially in one round', async () => {
    invoke
      .mockResolvedValueOnce(
        '{"tool_calls":[' +
          '{"id":"1","name":"read_file","args":{"path":"package.json"}}' +
          ',{"id":"2","name":"glob_files","args":{"pattern":"src/**"}}' +
          ',{"id":"3","name":"write_file","args":{"path":"notes.md","content":"hi"}}' +
          ',{"id":"4","name":"edit_file","args":{"path":"a","old_string":"x","new_string":"y"}}]}',
      )
      .mockResolvedValueOnce('{"reply":"Done.","actions":[]}')
      // The round wrote files, so Phase D sends it back once to verify before
      // the same FINAL is accepted (see the verification-gate tests below).
      .mockResolvedValueOnce('{"tool_calls":[{"id":"5","name":"run_command","args":{"command":"npm test"}}]}')
      .mockResolvedValueOnce('{"reply":"Done.","actions":[]}');
    const order: string[] = [];
    const toolExecutor = vi.fn(async (call: { name: string }) => {
      order.push(call.name);
      return { output: call.name === 'run_command' ? 'exit 0 in 1.0s: `npm test`\nok' : `${call.name} ok` };
    });

    const result = await routeOrchestratorRequest('survey the project and jot a note', ALL_AGENTS, { toolExecutor });

    expect(toolExecutor).toHaveBeenCalledTimes(5);
    expect(order.slice(0, 2).sort()).toEqual(['glob_files', 'read_file']);
    expect(order.slice(2, 4)).toEqual(['write_file', 'edit_file']);
    expect(order[4]).toBe('run_command');
    expect(result).toMatchObject({ reply: 'Done.' });
  });

  it('stops a doom loop when the same call repeats identically', async () => {
    const doom = '{"tool_calls":[{"id":"1","name":"list_agents","args":{}}]}';
    invoke
      .mockResolvedValueOnce(doom)
      .mockResolvedValueOnce(doom)
      .mockResolvedValueOnce(doom)
      .mockResolvedValueOnce('{"reply":"Stopping, will delegate instead.","actions":[]}');
    const toolExecutor = vi.fn(async (_call: unknown) => ({ output: 'Running: none' }));

    const result = await routeOrchestratorRequest('keep checking the agents over and over', ALL_AGENTS, { toolExecutor });

    // Two executions, then the guard fires on the third identical round.
    expect(toolExecutor).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ reply: 'Stopping, will delegate instead.' });
  });

  it('continues a bare promise into tool execution and a real answer', async () => {
    invoke.mockResolvedValueOnce('{"reply":"I will inspect the files.","actions":[]}')
      .mockResolvedValueOnce('{"tool_calls":[{"id":"r","name":"read_file","args":{"path":"package.json"}}]}')
      .mockResolvedValueOnce('{"reply":"This is a React application with a Vite build.","actions":[]}');
    const toolExecutor = vi.fn(async () => ({ output: 'React and Vite dependencies found.' }));
    const result = await routeOrchestratorRequest('do that please', ALL_AGENTS, { toolExecutor, conversation: [{ role: 'assistant', text: 'I can inspect the app structure.' }] });
    expect(toolExecutor).toHaveBeenCalledTimes(1);
    expect(result.reply).toContain('React application');
    expect(invoke.mock.calls[0][1].userText).toContain('assistant: I can inspect the app structure.');
  });

  it('routes the screenshot\'s inspection request through the LLM instead of the task-panel fast path', async () => {
    invoke.mockResolvedValueOnce('{"reply":"Here is what I found after reading the project.","actions":[]}');

    const result = await routeOrchestratorRequest(
      'Can you help me inspect the project and then suggest some improvements?',
      ALL_AGENTS,
      {
        // A task panel with in-progress work — this exact context used to make
        // TASK_ADVICE_RE swallow the message before the LLM ever saw it.
        taskPanel: ['In progress (3): Review Convex backend; Review app structure; Review docs'],
      },
    );

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(result.viaLLM).toBe(true);
    expect(result.reply).toContain('Here is what I found');
  });

  it('pre-gathers the project snapshot for "the project" phrasing so evidence exists', async () => {
    const toolExecutor = vi.fn(async (_call: unknown) => ({ output: 'Broad project snapshot: read 30 of 30 relevant text file(s), 60000 characters.' }));
    invoke
      .mockResolvedValueOnce('{"reply":"- Split the largest panel\\n- Add the missing index","actions":[]}')
      .mockResolvedValueOnce('{"tool_calls":[{"id":"plan","name":"update_todos","args":{"todos":["[~] Inspect structure","[ ] Inspect modules","[ ] Inspect UI","[ ] Verify findings"]}}]}')
      .mockResolvedValueOnce('{"tool_calls":[{"id":"read","name":"read_file","args":{"path":"src/App.tsx"}}]}')
      .mockResolvedValueOnce('{"reply":"- Split the largest panel\\n- Add the missing index","actions":[]}');

    const result = await routeOrchestratorRequest('inspect the project and suggest improvements', ALL_AGENTS, {
      toolExecutor,
      projectRoot: '/repo',
    });

    expect(toolExecutor).toHaveBeenCalledTimes(3);
    expect(toolExecutor.mock.calls[0]?.[0]).toMatchObject({ name: 'read_project', args: { max_files: 80 } });
    expect(result.failed).toBeFalsy();
  });

  it('applies the read-evidence gate to a short go-ahead continuing the review', async () => {
    // Turn 1 established the direct-review request; turn 2 is "okay".
    const conversation = [
      { role: 'user' as const, text: 'inspect the project and suggest improvements' },
      { role: 'assistant' as const, text: 'I can inspect the project and report back.' },
    ];
    invoke
      .mockResolvedValueOnce('{"tool_calls":[{"id":"p","name":"read_project","args":{"max_files":80}}]}')
      .mockResolvedValueOnce('{"reply":"Looks good overall.","actions":[]}')
      .mockResolvedValueOnce('{"reply":"Looks good overall.","actions":[]}');
    const toolExecutor = vi.fn(async () => ({ output: 'error: unable to read the project' }));

    const result = await routeOrchestratorRequest('okay', ALL_AGENTS, {
      toolExecutor,
      projectRoot: '/repo',
      conversation,
    });

    // The go-ahead inherits the review: the pre-seed fires, and when every read
    // fails the turn must fail honestly instead of accepting a chat reply.
    expect(toolExecutor).toHaveBeenCalled();
    expect(result).toMatchObject({ failed: true, actions: [] });
    expect(result.reply).toContain('could not complete the project review');
  });

  it('runs the tools on a go-ahead turn and returns the evidenced findings', async () => {
    const conversation = [
      { role: 'user' as const, text: 'inspect the project and suggest improvements' },
      { role: 'assistant' as const, text: 'I can inspect the project and report back.' },
    ];
    invoke
      .mockResolvedValueOnce('{"reply":"- Split the largest panel\\n- Extract the brain loop","actions":[]}')
      .mockResolvedValueOnce('{"tool_calls":[{"id":"plan","name":"update_todos","args":{"todos":["[~] Inspect structure","[ ] Inspect modules","[ ] Inspect UI","[ ] Verify findings"]}}]}')
      .mockResolvedValueOnce('{"tool_calls":[{"id":"read","name":"read_file","args":{"path":"src/App.tsx"}}]}')
      .mockResolvedValueOnce('{"reply":"- Split the largest panel\\n- Extract the brain loop","actions":[]}');
    const toolExecutor = vi.fn(async (_call: unknown) => ({ output: 'Broad project snapshot: read 30 of 30 relevant text file(s), 60000 characters.' }));

    const result = await routeOrchestratorRequest('okay continue with the program', ALL_AGENTS, {
      toolExecutor,
      projectRoot: '/repo',
      conversation,
    });

    // Pre-seed does reconnaissance; the model must then plan and inspect a
    // targeted file before the final findings are accepted.
    expect(toolExecutor).toHaveBeenCalledTimes(3);
    expect(invoke).toHaveBeenCalledTimes(4);
    expect(result.reply).toContain('Split the largest panel');
    expect(result.failed).toBeFalsy();
  });

  it('strips todos from a FINAL reply that did no tool work', async () => {
    invoke.mockResolvedValueOnce(
      '{"reply":"All done.","todos":["Review project","Inspect schema","Inspect frontend","Inspect docs","Summarize findings"],"actions":[]}',
    );

    const result = await routeOrchestratorRequest('inspect the project and suggest improvements', ALL_AGENTS);

    expect(result.todos).toBeUndefined();
    expect(result.reply).toContain('All done.');
  });

  it('reaches the brain context as a previously-written-documents block when provided', async () => {
    invoke.mockResolvedValueOnce('{"reply":"Summarised from the stored plan.","actions":[]}');
    await routeOrchestratorRequest('what did we plan for auth?', ALL_AGENTS, {
      documentsIndex: 'Previously written documents in this project (read one with read_file):\n- docs/plans/2026-09-01-auth-plan.md: Auth overhaul plan — Goal: unify token refresh.',
    });
    const userText = invoke.mock.calls[0][1].userText as string;
    expect(userText).toContain('Previously written documents');
    expect(userText).toContain('docs/plans/2026-09-01-auth-plan.md');
  });

  it('gives one corrective pass when a FINAL reply claims a file creation it never executed', async () => {
    invoke
      .mockResolvedValueOnce('{"reply":"File created: `docs/2026-09-17-app-review-suggestions.md`. It covers the findings.","actions":[]}')
      .mockResolvedValueOnce('{"reply":"Here are the suggestions. Want me to save them as docs/review.md?","actions":[]}');
    const toolExecutor = vi.fn(async () => ({ output: 'ok' }));

    const result = await routeOrchestratorRequest('save the suggestions as a project document', ALL_AGENTS, { toolExecutor });

    // Second call carries the fabrication-correction instruction.
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[1][1].userText).toContain('claimed a file or document was created');
    expect(result.reply).not.toContain('File created');
  });

  it('annotates the reply honestly when the model repeats an unexecuted creation claim', async () => {
    invoke
      .mockResolvedValueOnce('{"reply":"File created: `docs/review.md`. It covers the findings.","actions":[]}')
      .mockResolvedValueOnce('{"reply":"File created: `docs/review.md`. It covers the findings.","actions":[]}');
    const toolExecutor = vi.fn(async () => ({ output: 'ok' }));

    const result = await routeOrchestratorRequest('save the suggestions as a project document', ALL_AGENTS, { toolExecutor });

    expect(result.reply).toContain('no file was actually written this turn');
  });

  it('keeps todos on a tool round that will execute them', async () => {
    invoke
      .mockResolvedValueOnce(
        '{"tool_calls":[{"id":"1","name":"read_project","args":{}}],"todos":["Review project","Inspect schema"]}',
      )
      .mockResolvedValueOnce('{"reply":"- Split the largest panel\\n- Extract the brain loop","actions":[]}');
    const toolExecutor = vi.fn(async () => ({ output: 'Read 12 files from the project' }));

    const result = await routeOrchestratorRequest('inspect the project and suggest improvements', ALL_AGENTS, {
      toolExecutor,
      projectRoot: '/repo',
    });

    // One pre-seeded snapshot + the model's own tool round.
    expect(toolExecutor).toHaveBeenCalledTimes(2);
    // The turn's plan is declared only through the update_todos tool; a
    // checklist attached to a reply that ran no plan tool is not merged, so
    // the final accepted result carries no unevidenced checklist.
    expect(result.todos).toBeUndefined();
  });

  it('accepts a plain-text final reply when the provider does not use JSON', async () => {
    invoke.mockResolvedValueOnce('Sure, I will take a look at the project.');

    const result = await routeOrchestratorRequest('review the project', ALL_AGENTS);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ reply: 'Sure, I will take a look at the project.', viaLLM: true });
  });

  it('raises the output budget when the recovery pass retries a truncated reply', async () => {
    invoke
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('{"reply":"The project is ready for review.","needsInput":false,"actions":[]}');

    await routeOrchestratorRequest('review the project', ALL_AGENTS);

    // The retry asks the provider for a larger visible-output budget than the
    // default, and tells the model why: the first reply was starved, not
    // disobedient, so the fix is headroom rather than a reworded instruction.
    // Normal requests keep the exact budget shape they had before (no
    // maxTokens field at all); only the raised retry carries one.
    expect(invoke.mock.calls[0][1].maxTokens).toBeUndefined();
    expect(invoke.mock.calls[1][1].maxTokens).toBe(131_072);
    expect(invoke.mock.calls[1][1].userText).toContain('larger output budget');
  });

  it('fails honestly when the recovery retry with the raised budget is also invalid', async () => {
    invoke
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('');

    const result = await routeOrchestratorRequest('review the project', ALL_AGENTS);

    // One recovery pass only: the retry goes out with the raised budget, and
    // a second invalid reply still closes the turn with the honest failure.
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[1][1].maxTokens).toBe(131_072);
    expect(result).toMatchObject({ failed: true, viaLLM: false });
    expect(result.reply).toContain('did not return a valid final response');
  });

  it('prints a plain-text review response alongside the preserved evidence', async () => {
    invoke
      .mockResolvedValueOnce('I am reviewing the project now.')
      .mockResolvedValueOnce('The project review is complete.');
    const toolExecutor = vi.fn(async () => ({ output: 'Read 12 files from the project' }));

    const result = await routeOrchestratorRequest('review the project and report what is working', ALL_AGENTS, {
      toolExecutor,
      projectRoot: '/repo',
    });

    expect(result.viaLLM).toBe(true);
    expect(result.failed).toBeUndefined();
    expect(result.reply).toBe('The project review is complete.');
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('exhausts its tool budget with a final evidence pass on the same model', async () => {
    invoke.mockResolvedValueOnce('{"tool_calls":[{"id":"w","name":"write_file","args":{"path":"report.md","content":"report"}}]}')
      .mockResolvedValueOnce('{"tool_calls":[{"id":"r","name":"read_file","args":{"path":"report.md"}}]}')
      .mockResolvedValueOnce('{"reply":"The report was written; verification remains unfinished.","actions":[]}');
    const toolExecutor = vi.fn(async () => ({ output: 'Wrote report.md.' }));
    const result = await routeOrchestratorRequest('write and verify a report', ALL_AGENTS, { toolExecutor, maxToolRounds: 1 });
    expect(toolExecutor).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ failed: true, reply: 'The report was written; verification remains unfinished.' });
    expect(invoke.mock.calls[2][1].systemPrompt).toContain('Execution has stopped');
    expect(new Set(invoke.mock.calls.map((call) => call[1].model)).size).toBe(1);
  });

  it('preserves a tool question target and options and skips other calls in its batch', async () => {
    invoke.mockResolvedValueOnce('{"tool_calls":[{"id":"w","name":"write_file","args":{"path":"x","content":"x"}},{"id":"q","name":"ask_question","args":{"question":"Which database?","options":["SQLite","PostgreSQL"],"target":"Backend"}}]}');
    const toolExecutor = vi.fn();
    const result = await routeOrchestratorRequest('configure storage', ALL_AGENTS, { toolExecutor });
    expect(toolExecutor).not.toHaveBeenCalled();
    expect(result).toMatchObject({ needsInput: true, inputRequest: { question: 'Which database?', target: 'Backend', options: ['SQLite', 'PostgreSQL'] } });
  });
});


describe('native orchestrator execution', () => {
  beforeEach(() => { invoke.mockReset(); isProviderApiKeyConfiguredLocal.mockReturnValue(true); aiProvider.set('openai'); currentAiModel.set('model'); });
  it('continues beyond eight tool rounds using structured results', async () => {
    let round = 0;
    invoke.mockImplementation(async (command, args) => {
      if (command === 'ai_agent_capabilities') return {};
      expect(command).toBe('ai_agent_turn');
      const current = round++;
      if (current < 10) return { text: '', calls: [{ id: `r${current}`, name: 'read_file', args: { path: `f${current}` } }], assistant: { role: 'assistant' } };
      expect(args.request.exchanges).toHaveLength(10);
      return { text: JSON.stringify({ reply: 'Inspected all ten files.', actions: [] }), calls: [], assistant: { role: 'assistant' } };
    });
    const executor = vi.fn(async () => ({ output: 'source' }));
    const result = await routeOrchestratorRequest('Inspect the selected files', ALL_AGENTS, { nativeTools: true, toolExecutor: executor });
    expect(executor).toHaveBeenCalledTimes(10);
    expect(result.reply).toBe('Inspected all ten files.');
    expect(result.failed).not.toBe(true);
  });
  it('preserves write then read ordering and does not change models after a network failure', async () => {
    let requests = 0;
    invoke.mockImplementation(async (command, args) => {
      if (command === 'ai_agent_capabilities') return {};
      expect(args.request.model).toBe('model');
      if (requests++ > 0) throw new Error('network: connection lost');
      return { text: '', calls: [{ id: 'write', name: 'write_file', args: { path: 'a', content: 'new' } }, { id: 'read', name: 'read_file', args: { path: 'a' } }], assistant: { role: 'assistant' } };
    });
    let content = 'old';
    const order: string[] = [];
    const result = await routeOrchestratorRequest('Update the file and check it', ALL_AGENTS, { nativeTools: true,
      toolExecutor: async call => { order.push(call.name); if (call.name === 'write_file') content = 'new'; else expect(content).toBe('new'); return { output: content }; } });
    expect(order).toEqual(['write_file', 'read_file']);
    expect(requests).toBe(3);
    expect(result.failed).toBe(true);
    expect(result.reply).toContain('after 2 attempts');
    expect(result.reply).toContain('Completed tool work is preserved');
  });

  it('retries a transient network failure on the same model and continues', async () => {
    let requests = 0;
    invoke.mockImplementation(async (command, args) => {
      if (command === 'ai_agent_capabilities') return {};
      expect(args.request.model).toBe('model');
      if (requests++ === 0) throw new Error('network: connection reset');
      if (requests === 2) {
        return { text: '', calls: [{ id: 'r', name: 'read_file', args: { path: 'a' } }], assistant: { role: 'assistant' } };
      }
      return { text: JSON.stringify({ reply: 'The file contains the expected change.', actions: [] }), calls: [], assistant: { role: 'assistant' } };
    });
    const executor = vi.fn(async () => ({ output: 'new content' }));

    const result = await routeOrchestratorRequest('check the file', ALL_AGENTS, {
      nativeTools: true,
      toolExecutor: executor,
    });

    expect(requests).toBe(3);
    expect(executor).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ reply: 'The file contains the expected change.' });
    expect(result.failed).not.toBe(true);
  });

  it('sends a turn that edited files back to verify before accepting FINAL', async () => {
    let round = 0;
    const prompts: string[] = [];
    invoke.mockImplementation(async (command, args) => {
      if (command === 'ai_agent_capabilities') return {};
      prompts.push(JSON.stringify(args));
      const current = round++;
      if (current === 0) {
        return { text: '', calls: [{ id: 'w', name: 'edit_file', args: { path: 'src/a.ts', old_string: 'a', new_string: 'b' } }], assistant: { role: 'assistant' } };
      }
      if (current === 1) {
        // The model believes it is done, with nothing having checked the edit.
        return { text: JSON.stringify({ reply: 'Changed src/a.ts.', actions: [] }), calls: [], assistant: { role: 'assistant' } };
      }
      if (current === 2) {
        return { text: '', calls: [{ id: 'v', name: 'run_command', args: { command: 'npm test' } }], assistant: { role: 'assistant' } };
      }
      return { text: JSON.stringify({ reply: 'Changed src/a.ts and ran `npm test`: 12 passed.', actions: [] }), calls: [], assistant: { role: 'assistant' } };
    });
    const executor = vi.fn(async (call: { name: string }) =>
      call.name === 'edit_file'
        ? { output: 'Edited src/a.ts (replaced 1 chars).' }
        : { output: 'exit 0 in 2.0s: `npm test`\n12 passed' },
    );

    const result = await routeOrchestratorRequest('Fix the bug in src/a.ts', ALL_AGENTS, {
      nativeTools: true,
      toolExecutor: executor,
      projectRoot: '/repo',
    });

    // One corrective round: asked to verify, then allowed to finish.
    expect(round).toBe(4);
    expect(executor).toHaveBeenCalledTimes(2);
    expect(executor.mock.calls[1]?.[0]).toMatchObject({ name: 'run_command' });
    expect(prompts.some((p) => /no verification afterwards/i.test(p))).toBe(true);
    expect(result.reply).toContain('12 passed');
    expect(result.failed).not.toBe(true);
  });

  it('does not demand an extra round from an edit that was already verified', async () => {
    let round = 0;
    invoke.mockImplementation(async (command) => {
      if (command === 'ai_agent_capabilities') return {};
      const current = round++;
      if (current === 0) {
        return { text: '', calls: [{ id: 'w', name: 'edit_file', args: { path: 'src/a.ts', old_string: 'a', new_string: 'b' } }, { id: 'v', name: 'run_command', args: { command: 'npm test' } }], assistant: { role: 'assistant' } };
      }
      return { text: JSON.stringify({ reply: 'Changed src/a.ts; `npm test` passed.', actions: [] }), calls: [], assistant: { role: 'assistant' } };
    });
    const executor = vi.fn(async (call: { name: string }) =>
      call.name === 'edit_file'
        ? { output: 'Edited src/a.ts (replaced 1 chars).' }
        : { output: 'exit 0 in 2.0s: `npm test`\n12 passed' },
    );

    const result = await routeOrchestratorRequest('Fix the bug in src/a.ts', ALL_AGENTS, {
      nativeTools: true,
      toolExecutor: executor,
      projectRoot: '/repo',
    });

    expect(round).toBe(2);
    expect(result.failed).not.toBe(true);
  });
});
