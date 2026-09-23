import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from '$lib/stores/storeCompat';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }));

import {
  FIRM_RULE_USES,
  clearLearnedProfile,
  findRepeatedInstruction,
  removeProfileEntry,
  reflectAndEvolve,
  getProfileLines,
  globalOrchestratorProfile,
  orchestratorProfile,
} from './evolve';

const PROJECT = 'project-1';

function reflectWith(response: string, userMessage = 'keep replies short') {
  return reflectAndEvolve({
    projectId: PROJECT,
    rootPath: '/tmp/proj',
    userMessage,
    reply: 'ok',
    actions: [],
    complete: async () => response,
  });
}

describe('reflectAndEvolve', () => {
  beforeEach(() => {
    globalOrchestratorProfile.set([]);
    orchestratorProfile.set({});
  });

  it('stores global and project insights and surfaces them in profile lines', async () => {
    await reflectWith(
      JSON.stringify([
        { scope: 'global', text: 'Prefers terse replies' },
        { scope: 'project', text: 'API lives in src/api' },
      ]),
    );

    const lines = getProfileLines(PROJECT);
    expect(lines).toContain('[you] Prefers terse replies');
    expect(lines).toContain('[this project] API lives in src/api');
  });

  it('parses JSON even when wrapped in prose / code fences', async () => {
    await reflectWith('Sure! Here is what I learned:\n```json\n[{"scope":"global","text":"Always run tests after edits"}]\n```');
    expect(getProfileLines(PROJECT)).toContain('[you] Always run tests after edits');
  });

  it('reinforces a repeated insight instead of duplicating it', async () => {
    await reflectWith(JSON.stringify([{ scope: 'global', text: 'Prefers terse replies' }]));
    await reflectWith(JSON.stringify([{ scope: 'global', text: 'prefers   terse replies' }]));

    const globals = get(globalOrchestratorProfile);
    const matching = globals.filter((e) => e.text.toLowerCase().includes('terse'));
    expect(matching).toHaveLength(1);
    expect(matching[0].uses).toBe(2);
  });

  it('ignores empty or malformed model output', async () => {
    await reflectWith('[]');
    await reflectWith('not json at all');
    expect(getProfileLines(PROJECT)).toHaveLength(0);
  });

  it('caps how many insights one turn can add', async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ scope: 'project', text: `fact number ${i}` }));
    await reflectWith(JSON.stringify(many));
    expect(getProfileLines(PROJECT).length).toBeLessThanOrEqual(12);
  });
});

describe('learning from repeated instructions', () => {
  beforeEach(() => {
    globalOrchestratorProfile.set([]);
    orchestratorProfile.set({});
  });

  it('spots an instruction the user already gave, and ignores unrelated or current messages', () => {
    const earlier = ['Always run the tests after you edit a file', 'What does the router do?'];
    expect(findRepeatedInstruction('run the tests after every file edit please', earlier)).toBe('Always run the tests after you edit a file');
    expect(findRepeatedInstruction('add a logout button to the header', earlier)).toBeNull();
    // The current message itself is often the last entry; it is not a repeat of itself.
    expect(findRepeatedInstruction('add a logout button to the header', ['add a logout button to the header'])).toBeNull();
    expect(findRepeatedInstruction('ok thanks', earlier)).toBeNull();
  });

  it('tells the reflection it was repeated and ranks the rule ahead of one-off lessons', async () => {
    let prompt = '';
    await reflectAndEvolve({
      projectId: PROJECT, rootPath: '/tmp/proj', userMessage: 'run the tests after every edit', reply: 'ok', actions: [],
      repeatedFrom: 'Always run the tests after you edit a file',
      complete: async (_system, userText) => { prompt = userText; return JSON.stringify([{ scope: 'global', text: 'Always run the tests after editing a file' }]); },
    });
    await reflectWith(JSON.stringify([{ scope: 'global', text: 'Likes emoji-free replies' }]));

    expect(prompt).toContain('REPEATED: the user said something very similar earlier');
    const rule = get(globalOrchestratorProfile).find((e) => e.text.startsWith('Always run'));
    expect(rule?.uses).toBeGreaterThanOrEqual(FIRM_RULE_USES);
    expect(getProfileLines(PROJECT)[0]).toBe('[you] Always run the tests after editing a file');
  });

  it('forgets one entry or everything on request', async () => {
    await reflectWith(JSON.stringify([{ scope: 'global', text: 'Prefers pnpm' }, { scope: 'project', text: 'API lives in src/api' }]));
    const first = get(globalOrchestratorProfile)[0];
    await removeProfileEntry(PROJECT, first.id);
    expect(get(globalOrchestratorProfile)).toHaveLength(0);
    expect(get(orchestratorProfile)[PROJECT]).toHaveLength(1);
    await clearLearnedProfile(PROJECT);
    expect(getProfileLines(PROJECT)).toHaveLength(0);
  });
});
