import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn(async (..._args: any[]): Promise<any> => undefined));
const classifyRouting = vi.hoisted(() => vi.fn(async (..._args: any[]): Promise<any> => null));
const suggestReasoningLevel = vi.hoisted(() => vi.fn(async (..._args: any[]): Promise<any> => null));
vi.mock('$lib/services/jev', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/services/jev')>()), classifyRouting,
}));
vi.mock('$lib/services/orchestrator/jev-reasoning', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/services/orchestrator/jev-reasoning')>()), suggestReasoningLevel,
}));
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
vi.mock('./live-agent-models', () => ({
  peekLiveAgentProviderModels: () => null,
  loadLiveAgentProviderModels: () => Promise.resolve([]),
}));
const skillSettings = vi.hoisted(() => {
  const store = <T,>(initial: T) => {
    let value = initial;
    return { subscribe(run: (v: T) => void) { run(value); return () => {}; }, set(next: T) { value = next; } };
  };
  return {
    disabled: store<string[]>([]),
    custom: store<Array<{ id: string; title: string; instructions: string; enabled: boolean }>>([]),
  };
});
vi.mock('$lib/stores/settings', () => ({
  aiProvider,
  currentAiModel,
  getProviderDef,
  isLocalProvider,
  getProviderBaseUrl,
  providerSetupHint: (id: string) => `Add the ${id} API key in Settings → AI Connections.`,
  orchestratorDisabledSkills: skillSettings.disabled,
  orchestratorCustomSkills: skillSettings.custom,
}));

import {
  ORCHESTRATOR_USER_TEXT_CHAR_LIMIT,
  routeOrchestratorRequest,
  resolveAgentCommand,
  ADMIN_KEYWORD_RE,
  detectStatedPlacement,
  describeTurnFocus,
  countAsks,
  repeatsPreviousAnswer,
  isAcknowledgement,
  classifyTurnIntent,
  parseOpenAgentsCommand,
  isProtocolDebris,
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
    classifyRouting.mockReset().mockResolvedValue(null);
    suggestReasoningLevel.mockReset().mockResolvedValue(null);
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

  it('does not describe a reusable session after a finished turn as still in progress', async () => {
    const result = await routeOrchestratorRequest('what are the agents doing', [{ command: 'claude', name: 'Claude' }], {
      taskOutputs: [{
        name: 'Backend',
        agent: 'claude',
        title: 'Run the auth checks',
        status: 'in-progress',
        turnState: 'ready',
      }],
    });

    expect(result.reply).toContain('ready for your next message');
    expect(result.reply).not.toContain('still in progress');
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

  it('sends an "image generation is unavailable" refusal back to call generate_image', async () => {
    // The 2026-09-22 screenshot: the ChatGPT brain refused with 0 operations.
    invoke
      .mockResolvedValueOnce('{"reply":"I couldn’t create the dog image because image generation is unavailable in this session.","actions":[]}')
      .mockResolvedValueOnce('{"tool_calls":[{"id":"1","name":"generate_image","args":{"prompt":"a dog"}}]}')
      .mockResolvedValueOnce('{"reply":"Here is a friendly dog.","actions":[]}');
    const toolExecutor = vi.fn(async () => ({ output: 'Generated image saved.' }));

    const result = await routeOrchestratorRequest('can you create an image of aa dog', ALL_AGENTS, { toolExecutor, projectRoot: '/repo' });

    expect(toolExecutor).toHaveBeenCalledWith(expect.objectContaining({ name: 'generate_image' }));
    expect(invoke.mock.calls.some((call) => String((call[1] as { userText: string }).userText).includes('generate_image IS available'))).toBe(true);
    expect(result.reply).toContain('friendly dog');
  });

  it('generates the image itself when the brain refuses twice', async () => {
    // The San Francisco Bay screenshot: the recovery pass was refused too.
    const refusal = '{"reply":"I couldn’t generate the image because the image-generation tool isn’t available in this session.","actions":[]}';
    invoke.mockResolvedValueOnce(refusal).mockResolvedValueOnce(refusal);
    const toolExecutor = vi.fn(async () => ({ output: 'Generated image with chatgpt, saved at /repo/generations/1.png and shown to the user in chat.' }));

    const result = await routeOrchestratorRequest('can you create an image of the san-francisco bay', ALL_AGENTS, { toolExecutor, projectRoot: '/repo' });

    expect(toolExecutor).toHaveBeenCalledWith(expect.objectContaining({ name: 'generate_image', args: { prompt: 'can you create an image of the san-francisco bay' } }));
    expect(result.reply).toBe('Here is the image.');
    expect(result.failed).toBeFalsy();
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

  it('clearly notifies the user when a provider has exhausted its credits', async () => {
    invoke.mockRejectedValueOnce(new Error('Model request failed (402 Payment Required): insufficient_quota'));

    const result = await routeOrchestratorRequest('review the application', ALL_AGENTS, {
      llmConfig: {
        provider: 'openai',
        model: 'gpt-5.4-mini',
        hasApiKey: true,
      },
    });

    expect(result).toMatchObject({ viaLLM: false, failed: true, actions: [] });
    expect(result.reply).toContain('no remaining usage credit or quota');
    expect(result.reply).toContain('billing or usage page');
  });

  it('explains that OpenCode free models only run inside OpenCode instead of blaming the key', async () => {
    invoke.mockRejectedValueOnce(new Error('auth: opencode / big-pickle (403 Forbidden): {"type":"error","error":{"type":"FreeTierError","message":"Error from provider (Console): OpenCode\'s free tier can only be used from within OpenCode"}}'));

    const result = await routeOrchestratorRequest('review the application', ALL_AGENTS, {
      llmConfig: { provider: 'opencode', model: 'big-pickle', hasApiKey: true },
    });

    expect(result).toMatchObject({ failed: true, actions: [] });
    expect(result.reply).toContain("OpenCode's free models");
    expect(result.reply).toContain('OpenCode Go subscription');
    expect(result.reply).not.toContain('rejected the saved');
  });

  it("quotes the provider's own reason and the Zen/Go difference when OpenCode rejects a key", async () => {
    invoke.mockRejectedValueOnce(new Error('auth: opencode / glm-5.3-flash (401 Unauthorized): {"type":"error","error":{"type":"AuthError","message":"Invalid API key."}}'));

    const result = await routeOrchestratorRequest('review the application', ALL_AGENTS, {
      llmConfig: { provider: 'opencode', model: 'glm-5.3-flash', hasApiKey: true },
    });

    expect(result.reply).toContain('"Invalid API key."');
    expect(result.reply).toContain('switch the provider to OpenCode Go subscription');
  });

  it('surfaces native transport quota failures with the same credit notice', async () => {
    invoke.mockImplementation(async (command) => {
      if (command === 'ai_agent_capabilities') return {};
      throw new Error('quota: openai / gpt-5.4-mini (402): Payment Required');
    });

    const result = await routeOrchestratorRequest('review the application', ALL_AGENTS, {
      nativeTools: true,
      toolExecutor: vi.fn(),
      llmConfig: {
        provider: 'openai',
        model: 'gpt-5.4-mini',
        hasApiKey: true,
      },
    });

    expect(result).toMatchObject({ viaLLM: false, failed: true, actions: [] });
    expect(result.reply).toContain('no remaining usage credit or quota');
  });

  it('prompts typed chat as a chat assistant and keeps the spoken style for voice only', async () => {
    invoke.mockResolvedValue('Answer.');
    const llmConfig = { provider: 'openai' as const, model: 'gpt-4.1', hasApiKey: true };

    await routeOrchestratorRequest('how does the router work?', ALL_AGENTS, { conversational: true, llmConfig });
    const chatPrompt = String(invoke.mock.calls.at(-1)?.[1]?.systemPrompt);
    expect(chatPrompt).toContain('CHAT MODE');
    expect(chatPrompt).not.toContain('VOICE CONVERSATION MODE');

    await routeOrchestratorRequest('how does the router work?', ALL_AGENTS, { conversational: true, voice: true, llmConfig });
    const voicePrompt = String(invoke.mock.calls.at(-1)?.[1]?.systemPrompt);
    expect(voicePrompt).toContain('VOICE CONVERSATION MODE');
    expect(voicePrompt).not.toContain('CHAT MODE');
  });

  it('adds confident Jev advice to Chat without letting it authorize delegation', async () => {
    invoke.mockResolvedValue('Answer.');
    classifyRouting.mockResolvedValue('split');
    suggestReasoningLevel.mockResolvedValue('high');
    await routeOrchestratorRequest('How should I approach this project?', ALL_AGENTS, {
      conversational: true,
      llmConfig: { provider: 'openai', model: 'gpt-5', hasApiKey: true },
    });
    const prompt = String(invoke.mock.calls.at(-1)?.[1]?.systemPrompt);
    expect(prompt).toContain('Jev advisory for this prompt: split; reasoning effort high');
    expect(prompt).toContain('delegation approval rules');
    classifyRouting.mockResolvedValue(null);
    suggestReasoningLevel.mockResolvedValue(null);
    await routeOrchestratorRequest('How should I approach this project?', ALL_AGENTS, {
      conversational: true,
      llmConfig: { provider: 'openai', model: 'gpt-5', hasApiKey: true },
    });
    expect(String(invoke.mock.calls.at(-1)?.[1]?.systemPrompt)).not.toContain('Jev advisory');
  });

  it.each([
    'model_unavailable: openai / gpt-9 (404 Not Found): {"error":{"code":"model_not_found"}}',
    'Model request failed (404): The model `gpt-9` does not exist or you do not have access to it.',
    'Model request failed (404): This model is only supported in v1/responses and not in v1/chat/completions.',
  ])('reports an unusable model instead of silently using the keyword fallback: %s', async (error) => {
    invoke.mockImplementation(async (command) => {
      if (command === 'ai_agent_capabilities') return {};
      throw new Error(error);
    });

    const result = await routeOrchestratorRequest('spawn codex to fix the login bug', ALL_AGENTS, {
      nativeTools: true,
      toolExecutor: vi.fn(),
      llmConfig: { provider: 'openai', model: 'gpt-9', hasApiKey: true },
    });

    expect(result).toMatchObject({ viaLLM: false, failed: true, actions: [] });
    expect(result.reply).toContain('"gpt-9"');
    expect(result.reply).toContain('Composer model menu');
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

  it('carries the worker model and reasoning selection through a spawn action', async () => {
    invoke.mockResolvedValueOnce(
      '{"reply":"On it.","actions":[{"kind":"spawn","agent":"codex","prompt":"do x","model":"gpt-5-codex","reasoningEffort":"high"}]}'
    );

    const result = await routeOrchestratorRequest('have codex do x', ALL_AGENTS);
    expect(result.actions).toEqual([
      {
        kind: 'spawn',
        agent: 'codex',
        prompt: 'do x',
        name: null,
        role: null,
        files: null,
        model: 'gpt-5-codex',
        reasoningEffort: 'high',
        skipWorktree: false,
        placement: null,
      },
    ]);
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
    expect(invoke.mock.calls[0][1].userText).toContain('assistant (your previous answer): I can inspect the app structure.');
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
  it('answers a simple conversational question without running tools', async () => {
    invoke.mockImplementation(async (command) => command === 'ai_agent_capabilities' ? {} : {
      text: JSON.stringify({ reply: 'Paris is the capital of France.', actions: [] }), calls: [], assistant: { role: 'assistant' },
    });
    const executor = vi.fn();
    const result = await routeOrchestratorRequest('What is the capital of France?', ALL_AGENTS, {
      conversational: true, nativeTools: true, toolExecutor: executor,
    });
    expect(result.reply).toBe('Paris is the capital of France.');
    expect(result.failed).not.toBe(true);
    expect(executor).not.toHaveBeenCalled();
    expect(invoke.mock.calls.filter(([command]) => command === 'ai_agent_turn')).toHaveLength(1);
  });

  it('recovers from an empty answer after a tool result without repeating the tool', async () => {
    let requests = 0;
    invoke.mockImplementation(async (command, args) => {
      if (command === 'ai_agent_capabilities') return {};
      if (requests++ === 0) return { text: '', calls: [{ id: 'read', name: 'read_file', args: { path: 'a' } }], assistant: { role: 'assistant' } };
      expect(args.request.exchanges).toHaveLength(1);
      if (requests === 2) throw 'empty_response: model returned neither text nor tools';
      return { text: JSON.stringify({ reply: 'The file contains the expected configuration.', actions: [] }), calls: [], assistant: { role: 'assistant' } };
    });
    const executor = vi.fn(async () => ({ output: 'configuration' }));
    const result = await routeOrchestratorRequest('Read file a and explain it', ALL_AGENTS, { nativeTools: true, toolExecutor: executor });
    expect(executor).toHaveBeenCalledTimes(1);
    expect(requests).toBe(3);
    expect(result.failed).not.toBe(true);
    expect(result.reply).toBe('The file contains the expected configuration.');
  });

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
    vi.useFakeTimers();
    const pending = routeOrchestratorRequest('Update the file and check it', ALL_AGENTS, { nativeTools: true,
      toolExecutor: async call => { order.push(call.name); if (call.name === 'write_file') content = 'new'; else expect(content).toBe('new'); return { output: content }; } });
    await vi.runAllTimersAsync();
    const result = await pending;
    vi.useRealTimers();
    expect(order).toEqual(['write_file', 'read_file']);
    // One successful round, then the failing request plus its two backoff retries.
    expect(requests).toBe(4);
    expect(result.failed).toBe(true);
    expect(result.reply).toContain('after 3 attempts');
    expect(result.reply).toContain('Completed tool work is preserved');
  });

  it('gives every request its own retry budget, so an early blip does not doom a later round', async () => {
    let requests = 0;
    invoke.mockImplementation(async (command) => {
      if (command === 'ai_agent_capabilities') return {};
      requests += 1;
      // Rounds 1 and 2 each fail once before succeeding.
      if (requests === 1 || requests === 3) throw new Error('timeout: error sending request: operation timed out');
      if (requests === 2) return { text: '', calls: [{ id: 'r', name: 'read_file', args: { path: 'a' } }], assistant: { role: 'assistant' } };
      return { text: 'Read it; all good.', calls: [], assistant: { role: 'assistant' } };
    });

    vi.useFakeTimers();
    const pending = routeOrchestratorRequest('check the file', ALL_AGENTS, { nativeTools: true, toolExecutor: vi.fn(async () => ({ output: 'x' })) });
    await vi.runAllTimersAsync();
    const result = await pending;
    vi.useRealTimers();

    expect(requests).toBe(4);
    expect(result.failed).not.toBe(true);
    expect(result.reply).toContain('all good');
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

    vi.useFakeTimers();
    const pending = routeOrchestratorRequest('check the file', ALL_AGENTS, {
      nativeTools: true,
      toolExecutor: executor,
    });
    await vi.runAllTimersAsync();
    const result = await pending;
    vi.useRealTimers();

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

  it('runs the project check after edits and sends a failure back to be fixed', async () => {
    let round = 0;
    const prompts: string[] = [];
    invoke.mockImplementation(async (command, args) => {
      if (command === 'ai_agent_capabilities') return {};
      prompts.push(JSON.stringify(args));
      const current = round++;
      if (current === 0 || current === 2) {
        return { text: '', calls: [{ id: `w${current}`, name: 'edit_file', args: { path: 'src/a.ts', old_string: 'a', new_string: 'b' } }], assistant: { role: 'assistant' } };
      }
      return { text: JSON.stringify({ reply: 'Changed src/a.ts.', actions: [] }), calls: [], assistant: { role: 'assistant' } };
    });
    const executor = vi.fn(async () => ({ output: 'Edited src/a.ts (replaced 1 occurrence).' }));
    const postEditCheck = vi.fn()
      .mockResolvedValueOnce({ command: 'npm run check', ok: false, output: 'exit 2 in 9.0s: `npm run check`\nsrc/a.ts(1,7): error TS2322' })
      .mockResolvedValueOnce({ command: 'npm run check', ok: true, output: 'exit 0 in 9.0s: `npm run check`' });

    const result = await routeOrchestratorRequest('Fix the bug in src/a.ts', ALL_AGENTS, {
      nativeTools: true,
      toolExecutor: executor,
      projectRoot: '/repo',
      postEditCheck,
    });

    expect(postEditCheck).toHaveBeenCalledTimes(2);
    expect(prompts[2]).toContain('error TS2322');
    // The passing check counts as verification: no extra "run your tests" round.
    expect(round).toBe(4);
    expect(prompts.some((p) => /no verification afterwards/i.test(p))).toBe(false);
    expect(result).toMatchObject({ reply: 'Changed src/a.ts.' });
  });

  it('frames each new message: follow-up, several questions, or a go-ahead', async () => {
    const previous = [
      { role: 'user' as const, text: 'Review the project' },
      { role: 'assistant' as const, text: 'Here is the review.' },
    ];
    expect(describeTurnFocus('What about point 4?', { conversation: previous })).toContain('Answer THIS message specifically');
    expect(describeTurnFocus('okay continue', { conversation: previous })).toContain('continue the previous task');
    expect(describeTurnFocus('Why does lint fail? And is Clerk configured?', { conversation: previous })).toContain('2 questions or requests: answer every one');
    expect(describeTurnFocus('1. fix lint\n2. add tests\n3. update docs')).toContain('3 questions or requests');
    expect(describeTurnFocus('Hello')).toBeNull();
    expect(countAsks('Is it done?')).toBe(1);
  });

  it('keeps the previous answer whole and puts the turn focus right before the new message', async () => {
    invoke.mockResolvedValueOnce('{"reply":"Point 4 is about test coverage.","actions":[]}');
    const longAnswer = `${'Finding. '.repeat(300)}4. Test coverage is thin.`;
    await routeOrchestratorRequest('what about point 4?', ALL_AGENTS, {
      conversation: [{ role: 'user', text: 'Review it' }, { role: 'assistant', text: longAnswer }],
    });
    const userText: string = invoke.mock.calls[0][1].userText;
    expect(userText).toContain('4. Test coverage is thin.');
    expect(userText.indexOf('Turn focus:')).toBeLessThan(userText.indexOf('New user message: what about point 4?'));
  });

  it('sends a re-sent previous answer back to answer the new message', async () => {
    const report = Array.from({ length: 40 }, (_, i) => `Finding ${i}: the module number ${i} needs clearer validation and better error handling.`).join('\n');
    invoke
      .mockResolvedValueOnce(JSON.stringify({ reply: report, actions: [] }))
      .mockResolvedValueOnce('{"reply":"Lint fails because ESLint has no config for the app router.","actions":[]}');

    const result = await routeOrchestratorRequest('why does lint fail?', ALL_AGENTS, {
      toolExecutor: vi.fn(),
      conversation: [{ role: 'user', text: 'Review it' }, { role: 'assistant', text: report }],
    });

    expect(invoke.mock.calls[1][1].userText).toContain('repeats your previous answer');
    expect(result.reply).toBe('Lint fails because ESLint has no config for the app router.');
    expect(repeatsPreviousAnswer(report, 'say that again', { conversation: [{ role: 'assistant', text: report }] })).toBe(false);
  });

  it('tells a thank-you apart from a request', () => {
    for (const thanks of ['this is good, thanks for the work on the project', 'Thank you!', 'perfect, well done', 'okay great, thanks', 'That looks good']) {
      expect(isAcknowledgement(thanks), thanks).toBe(true);
    }
    for (const request of ['thanks, now add tests', 'great, go ahead', 'thanks! can you also review the API?', 'okay continue', 'looks good but the lint still fails', 'why is this great?']) {
      expect(isAcknowledgement(request), request).toBe(false);
    }
    const previous = [
      { role: 'user' as const, text: 'Inspect the project and suggest improvements' },
      { role: 'assistant' as const, text: 'Here is the review.' },
    ];
    expect(describeTurnFocus('Yeah this is good, thanks for the work', { conversation: previous })).toContain('thanking you');
  });

  it('feeds a whole project snapshot back to the model instead of an 18k slice', async () => {
    // A real read_project snapshot is far bigger than the old fixed cap, which
    // is why the model reported that the project snapshot was incomplete.
    const snapshot = `START-OF-SNAPSHOT\n${'export const value = 1;\n'.repeat(3000)}END-OF-SNAPSHOT`;
    expect(snapshot.length).toBeGreaterThan(60_000);
    const toolExecutor = vi.fn(async () => ({ output: snapshot }));
    invoke
      .mockResolvedValueOnce('{"tool_calls":[{"id":"1","name":"read_project","args":{}}]}')
      .mockResolvedValueOnce('{"reply":"Reviewed the project.","actions":[]}');

    await routeOrchestratorRequest('go through the application and report what works', ALL_AGENTS, {
      toolExecutor,
      projectRoot: '/repo',
    });

    const secondCall = invoke.mock.calls.filter(([command]) => command !== 'ai_agent_capabilities')[1];
    const userText: string = secondCall[1].userText;
    expect(userText).toContain('START-OF-SNAPSHOT');
    expect(userText).toContain('END-OF-SNAPSHOT');
    expect(userText.length).toBeGreaterThan(50_000);
  });

  it('keeps tool evidence when the surrounding context is huge', async () => {
    const snapshot = `START-OF-SNAPSHOT\n${'x'.repeat(40_000)}\nEND-OF-SNAPSHOT`;
    const toolExecutor = vi.fn(async () => ({ output: snapshot }));
    invoke
      .mockResolvedValueOnce('{"tool_calls":[{"id":"1","name":"read_project","args":{}}]}')
      .mockResolvedValueOnce('{"reply":"Reviewed.","actions":[]}');

    await routeOrchestratorRequest('review the project', ALL_AGENTS, {
      toolExecutor,
      projectRoot: '/repo',
      // A conversation far bigger than the whole budget: the evidence still
      // survives, and the older context is trimmed first.
      conversation: Array.from({ length: 12 }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', text: `old turn ${i} ${'y'.repeat(12_000)}` })),
    });

    const userText: string = invoke.mock.calls.filter(([command]) => command !== 'ai_agent_capabilities')[1][1].userText;
    expect(userText).toContain('START-OF-SNAPSHOT');
    expect(userText).toContain('END-OF-SNAPSHOT');
    expect(userText.length).toBeLessThanOrEqual(ORCHESTRATOR_USER_TEXT_CHAR_LIMIT);
  });

  it('sends an index instead of a second full copy when the transport already carries the results', async () => {
    const snapshot = `START-OF-SNAPSHOT\n${'z'.repeat(40_000)}\nEND-OF-SNAPSHOT`;
    const toolExecutor = vi.fn(async () => ({ output: snapshot }));
    // A transport turn goes through ai_agent_turn, which replays the full
    // outputs in its own history.
    invoke.mockImplementation(async (command: string) => {
      if (command === 'ai_agent_capabilities') return {};
      const round = invoke.mock.calls.filter(([name]) => name === 'ai_agent_turn').length;
      return round === 1
        ? { text: '{"tool_calls":[{"id":"1","name":"read_project","args":{}}]}', calls: [{ id: '1', name: 'read_project', args: {} }], assistant: { role: 'assistant' }, finishReason: 'tool_calls', usage: null }
        : { text: '{"reply":"Reviewed.","actions":[]}', calls: [], assistant: { role: 'assistant' }, finishReason: 'stop', usage: null };
    });

    await routeOrchestratorRequest('review the project', ALL_AGENTS, { toolExecutor, projectRoot: '/repo', nativeTools: true });

    const userText: string = invoke.mock.calls.filter(([command]) => command === 'ai_agent_turn')[1][1].request.userText;
    expect(userText).toMatch(/tool_result \S+ \(read_project, ok, 400\d\d chars\)/);
    expect(userText).toContain('read_tool_result(id)');
    // The 40k snapshot is not repeated: the prompt stays a fraction of its size.
    expect(userText.length).toBeLessThan(20_000);
    expect(userText).not.toContain('END-OF-SNAPSHOT');
  });

  it('tells the model the exact offset to continue a truncated project scan', async () => {
    const partial = 'Next review offset=39. Broad project snapshot: read 39 of 80 relevant text file(s), 120000 characters. Some files were omitted or truncated for safety.';
    const toolExecutor = vi.fn(async () => ({ output: partial }));
    invoke
      .mockResolvedValueOnce('{"tool_calls":[{"id":"1","name":"read_project","args":{}}]}')
      .mockResolvedValueOnce('{"reply":"I can only give a partial review; the remaining files were not available.","actions":[]}')
      .mockResolvedValueOnce('{"reply":"Full review done.","actions":[]}');

    await routeOrchestratorRequest('go through the application and report what works', ALL_AGENTS, { toolExecutor, projectRoot: '/repo' });

    const prompts = invoke.mock.calls.filter(([command]) => command !== 'ai_agent_capabilities').map(([, args]) => `${args.systemPrompt}${args.userText}`);
    const nudge = prompts.find((prompt) => prompt.includes('The project snapshot is incomplete'));
    expect(nudge).toContain('{"offset": 39}');
    expect(nudge).toContain('do not ask the user for permission to keep reading');
  });

  it('opens the requested number of agents itself, without asking the model', async () => {
    const result = await routeOrchestratorRequest('can you open 2 claude code agent', ALL_AGENTS, { conversational: true });
    expect(invoke.mock.calls.filter(([command]) => command !== 'ai_agent_capabilities')).toHaveLength(0);
    expect(result.actions).toEqual([
      { kind: 'spawn', agent: 'claude', prompt: null },
      { kind: 'spawn', agent: 'claude', prompt: null },
    ]);
    expect(result.reply).toBe('Opening 2 Claude Code agents. Their terminals will be ready for you.');
  });

  it('only treats a pure open request as one', () => {
    const open = (text: string) => {
      const parsed = parseOpenAgentsCommand(text, ALL_AGENTS);
      return parsed ? `${parsed.count}x${parsed.agent.command}` : null;
    };
    expect(open('open codex')).toBe('1xcodex');
    expect(open('Please spawn three Claude agents.')).toBe('3xclaude');
    expect(open('open a couple of codex agents in a worktree')).toBe('2xcodex');
    expect(open('launch 2 agents')).toBe('2xclaude');
    expect(open('open 50 claude agents')).toBe('8xclaude');
    // Carries a task, or is not about agents: the model decides.
    expect(open('open claude and fix the login bug')).toBeNull();
    expect(open('open claude to refactor the router')).toBeNull();
    expect(open('open 2 terminals')).toBeNull();
    expect(open('open settings')).toBeNull();
    expect(open('open the router file')).toBeNull();
  });

  it('retries instead of showing a bare {"tool_calls":[]} as the reply', async () => {
    invoke
      .mockResolvedValueOnce('{"tool_calls":[]}')
      .mockResolvedValueOnce('{"reply":"Here is the answer.","actions":[]}');

    const result = await routeOrchestratorRequest('what does the router do?', ALL_AGENTS, { toolExecutor: vi.fn() });

    const calls = invoke.mock.calls.filter(([command]) => command !== 'ai_agent_capabilities');
    expect(calls).toHaveLength(2);
    expect(calls[1][1].userText + calls[1][1].systemPrompt).toContain('tool_calls list with no usable tool');
    expect(result.reply).toBe('Here is the answer.');
    expect(isProtocolDebris('{"tool_calls":[]}')).toBe(true);
    expect(isProtocolDebris('Plain prose with {braces} inside.')).toBe(false);
  });

  it('reads each message and names what kind it is before any work', () => {
    const previous = [
      { role: 'user' as const, text: 'Add a login route' },
      { role: 'assistant' as const, text: 'Added the login route in src/routes/login.ts.' },
    ];
    const cases: Array<[string, ReturnType<typeof classifyTurnIntent>]> = [
      ['thanks, that is perfect', 'acknowledgement'],
      ["that's not right, the route is still missing", 'correction'],
      ['okay continue', 'continuation'],
      ['how does the router pick a handler?', 'question'],
      ['what is a JWT', 'question'],
      ['how do I add a route?', 'question'],
      ['can you add a logout route?', 'task'],
      ['fix the failing lint check', 'task'],
      ['please review the auth module', 'task'],
      ['I was out for lunch', 'conversation'],
    ];
    for (const [message, intent] of cases) {
      expect(classifyTurnIntent(message, { conversation: previous }), message).toBe(intent);
    }
    // Without a previous answer there is nothing to continue or dispute.
    expect(classifyTurnIntent('okay continue')).not.toBe('continuation');
    expect(describeTurnFocus('how does the router work?')).toContain('a question');
    expect(describeTurnFocus('fix the failing lint check')).toContain('a request to do work');
  });

  it('gives every model the assistant, engineering and security skills', async () => {
    invoke.mockResolvedValueOnce('{"reply":"Hi there.","actions":[]}');
    await routeOrchestratorRequest('hello', ALL_AGENTS, {});
    const systemPrompt: string = invoke.mock.calls.find(([command]) => command !== 'ai_agent_capabilities')?.[1].systemPrompt ?? '';
    expect(systemPrompt).toContain('ASSISTANT SKILL:');
    expect(systemPrompt).toContain('SOFTWARE ENGINEERING SKILL:');
    expect(systemPrompt).toContain('SECURITY SKILL:');
  });

  it('follows the skills chosen in Settings: built-ins switched off, the user\'s own added', async () => {
    skillSettings.disabled.set(['git']);
    skillSettings.custom.set([{ id: 's1', title: 'Our React style', instructions: 'Use function components only.', enabled: true }]);
    try {
      invoke.mockResolvedValueOnce('{"reply":"Hi there.","actions":[]}');
      await routeOrchestratorRequest('hello', ALL_AGENTS, {});
      const systemPrompt: string = invoke.mock.calls.find(([command]) => command !== 'ai_agent_capabilities')?.[1].systemPrompt ?? '';
      expect(systemPrompt).not.toContain('GIT SKILL:');
      expect(systemPrompt).toContain('OUR REACT STYLE SKILL (written by the user');
      expect(systemPrompt).toContain('Use function components only.');
    } finally {
      skillSettings.disabled.set([]);
      skillSettings.custom.set([]);
    }
  });

  it('answers a thank-you after a review without redoing the review', async () => {
    const report = Array.from({ length: 40 }, (_, i) => `Finding ${i}: the module number ${i} needs clearer validation and better error handling.`).join('\n');
    const toolExecutor = vi.fn();
    invoke.mockResolvedValueOnce('{"reply":"Glad it helped! Let me know if you would like me to start on any of those fixes.","actions":[]}');

    const result = await routeOrchestratorRequest('Yeah, this is good, thanks for the work on the project', ALL_AGENTS, {
      toolExecutor,
      projectRoot: '/repo',
      conversation: [{ role: 'user', text: 'Inspect the project and suggest improvements' }, { role: 'assistant', text: report }],
    });

    // One model call, no project reads, and the polite offer is not treated as a deferral.
    expect(invoke.mock.calls.filter(([command]) => command !== 'ai_agent_capabilities')).toHaveLength(1);
    expect(toolExecutor).not.toHaveBeenCalled();
    expect(result.reply).toBe('Glad it helped! Let me know if you would like me to start on any of those fixes.');
  });

  it('never answers a thank-you by re-sending the previous report', async () => {
    const report = Array.from({ length: 40 }, (_, i) => `Finding ${i}: the module number ${i} needs clearer validation and better error handling.`).join('\n');
    invoke.mockResolvedValue(JSON.stringify({ reply: report, actions: [] }));

    const result = await routeOrchestratorRequest('thank you, this is great', ALL_AGENTS, {
      toolExecutor: vi.fn(),
      conversation: [{ role: 'user', text: 'Review it' }, { role: 'assistant', text: report }],
    });

    expect(result.reply).not.toContain('Finding 0');
    expect(result.reply).toMatch(/welcome/i);
  });

  it('makes the model check a disputed claim with a tool instead of repeating itself', async () => {
    let round = 0;
    const prompts: string[] = [];
    invoke.mockImplementation(async (command, args) => {
      if (command === 'ai_agent_capabilities') return {};
      prompts.push(JSON.stringify(args));
      const current = round++;
      if (current === 0) return { text: JSON.stringify({ reply: 'Environment Variables: No .env.local file was found.', actions: [] }), calls: [], assistant: { role: 'assistant' } };
      if (current === 1) return { text: '', calls: [{ id: 'g', name: 'glob_files', args: { pattern: '.env*' } }], assistant: { role: 'assistant' } };
      return { text: JSON.stringify({ reply: 'You are right: .env.local exists (it is git-ignored). CLERK_SECRET_KEY is set.', actions: [] }), calls: [], assistant: { role: 'assistant' } };
    });
    const executor = vi.fn(async () => ({ output: 'Files matching ".env*" (1):\n- .env.example\nAlso present but git-ignored (1):\n- .env.local (secret: read_file shows variable names only, never values)' }));

    const result = await routeOrchestratorRequest('but there is a env.local file', ALL_AGENTS, {
      nativeTools: true,
      toolExecutor: executor,
      projectRoot: '/repo',
      conversation: [
        { role: 'user', text: 'Check what is working in this project' },
        { role: 'assistant', text: 'Environment Variables: No .env.local file was found.' },
      ],
    });

    expect(prompts[1]).toContain('The user is correcting your previous answer');
    expect(executor).toHaveBeenCalledWith(expect.objectContaining({ name: 'glob_files' }));
    expect(result.reply).toContain('.env.local exists');
  });

  it('does not end a turn while a steered message is waiting', async () => {
    let round = 0;
    const prompts: string[] = [];
    invoke.mockImplementation(async (command, args) => {
      if (command === 'ai_agent_capabilities') return {};
      prompts.push(JSON.stringify(args));
      round += 1;
      return { text: JSON.stringify({ reply: round === 1 ? 'Built it in red.' : 'Built it in blue.', actions: [] }), calls: [], assistant: { role: 'assistant' } };
    });
    const inbox = ['use blue instead'];
    let firstRequest = true;
    const steering = {
      // The message lands after the first request went out.
      pending: () => inbox.length > 0,
      drain: () => (firstRequest ? ((firstRequest = false), []) : inbox.splice(0)),
    };

    const result = await routeOrchestratorRequest('Build the banner', ALL_AGENTS, {
      nativeTools: true,
      toolExecutor: vi.fn(),
      projectRoot: '/repo',
      steering,
    });

    expect(round).toBe(2);
    expect(prompts[0]).not.toContain('use blue instead');
    expect(prompts[1]).toContain('Messages the user sent while you were working');
    expect(prompts[1]).toContain('use blue instead');
    expect(result.reply).toBe('Built it in blue.');
  });
});
