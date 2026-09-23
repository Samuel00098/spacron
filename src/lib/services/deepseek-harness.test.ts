import { describe, expect, it } from 'vitest';
import { get } from '$lib/stores/storeCompat';
import {
  deepSeekPanelRoot,
  deepSeekPlacements,
  deepSeekTrackedWorktrees,
  dropDeepSeekWorktree,
  patchDeepSeekWorktree,
  setDeepSeekPlacement,
  deepSeekLaunchLine,
  deepSeekWorkerEnv,
  isDeepSeekHarness,
  isDeepSeekWorkerSession,
  markDeepSeekWorkerSession,
} from './deepseek-harness';

const files = {
  workerScript: 'C:\\Users\\me\\AppData\\Roaming\\spacron\\deepseek-harness\\spacron-dsh-worker.mjs',
  binJs: 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js',
  mcpPatch: 'C:\\Users\\me\\AppData\\Roaming\\spacron\\deepseek-harness\\spacron-mcp.patch.yml',
  taskPatch: 'C:\\Users\\me\\AppData\\Roaming\\spacron\\deepseek-harness\\headless-task.patch.yml',
  accessPatch: 'C:\\Users\\me\\AppData\\Roaming\\spacron\\deepseek-harness\\spacron-full-access.patch.yml',
  providersPatch: null as string | null,
};

describe('deepseek harness worker launch', () => {
  it('runs the worker script on the task file with both patches and a placeholder task', () => {
    const line = deepSeekLaunchLine(files, 'C:\\tasks\\t 1.md');
    expect(line).toBe(
      `node "${files.workerScript}" "C:\\tasks\\t 1.md" "${files.binJs}" --profile headless ` +
        `--patch "${files.mcpPatch}" --patch "${files.taskPatch}" --patch "${files.accessPatch}" spacron-task`,
    );
  });

  it('adds the providers patch when other provider keys are saved', () => {
    const providersPatch = 'C:\\x\\spacron-providers.patch.yml';
    const line = deepSeekLaunchLine({ ...files, providersPatch }, '/t.md');
    expect(line).toContain(`--patch "${files.accessPatch}" --patch "${providersPatch}" spacron-task`);
  });

  it('starts with a bare command, never a quoted path PowerShell would echo', () => {
    expect(deepSeekLaunchLine(files, '/t.md').startsWith('node ')).toBe(true);
  });

  it('refuses a path it cannot quote safely', () => {
    expect(() => deepSeekLaunchLine(files, 'C:\\a"b.md')).toThrow();
  });

  it('asks for the key by marker and never carries it', () => {
    const env = deepSeekWorkerEnv('http://127.0.0.1:51379/?token=x');
    expect(env).toEqual({
      SPACRON_MCP_URL: 'http://127.0.0.1:51379/?token=x',
      SPACRON_WITH_DSH_KEYS: '1',
    });
    expect(Object.keys(env)).not.toContain('DEEPSEEK_API_KEY');
  });

  it('recognises the preset and tracks worker sessions', () => {
    expect(isDeepSeekHarness('dsh')).toBe(true);
    expect(isDeepSeekHarness('claude')).toBe(false);
    expect(isDeepSeekWorkerSession(4242)).toBe(false);
    markDeepSeekWorkerSession(4242);
    expect(isDeepSeekWorkerSession(4242)).toBe(true);
  });
});

describe('deepseek harness placement', () => {
  const worktree = (path: string) => ({
    path,
    branch: `spacron/deepseek-${path.slice(-1)}`,
    baseBranch: 'main',
    baseCommit: 'abc',
    createdAt: 1,
  });

  it('opens on the main checkout until a worktree is chosen', () => {
    expect(deepSeekPanelRoot(get(deepSeekPlacements), 'p-main', '/repo')).toBe('/repo');
    setDeepSeekPlacement('p-main', worktree('/repo/.spacron/worktrees/a'));
    expect(deepSeekPanelRoot(get(deepSeekPlacements), 'p-main', '/repo')).toBe('/repo/.spacron/worktrees/a');
  });

  it('keeps a left worktree tracked as not live so its work can still come in', () => {
    setDeepSeekPlacement('p-retire', worktree('/r/.spacron/worktrees/a'));
    setDeepSeekPlacement('p-retire', null);
    const tracked = deepSeekTrackedWorktrees().filter((e) => e.projectId === 'p-retire');
    expect(tracked).toHaveLength(1);
    expect(tracked[0]).toMatchObject({ live: false, worktree: { path: '/r/.spacron/worktrees/a' } });
    expect(deepSeekPanelRoot(get(deepSeekPlacements), 'p-retire', '/r')).toBe('/r');
  });

  it('records reconciler baselines and forgets reclaimed checkouts', () => {
    setDeepSeekPlacement('p-life', worktree('/l/.spacron/worktrees/a'));
    patchDeepSeekWorktree('p-life', '/l/.spacron/worktrees/a', { lastStagedCommit: 'def' });
    expect(get(deepSeekPlacements)['p-life'].worktree?.lastStagedCommit).toBe('def');
    const live = deepSeekTrackedWorktrees().find((e) => e.projectId === 'p-life');
    expect(live?.live).toBe(true);
    dropDeepSeekWorktree('p-life', '/l/.spacron/worktrees/a');
    expect(deepSeekTrackedWorktrees().some((e) => e.projectId === 'p-life')).toBe(false);
  });
});
