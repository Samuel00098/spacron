import { describe, expect, it } from 'vitest';
import { get } from '$lib/stores/storeCompat';
import {
  clearDeepSeekPlacement,
  deepSeekPanelRoot,
  deepSeekPlacements,
  sameFolder,
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
  userMcpPatch: null as string | null,
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

  it("adds the user's MCP servers patch last, when there is one", () => {
    const userMcpPatch = 'C:\\x\\spacron-user-mcp.patch.yml';
    const line = deepSeekLaunchLine({ ...files, userMcpPatch }, '/t.md');
    expect(line).toContain(`--patch "${userMcpPatch}" spacron-task`);
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
  it('opens on the main checkout until one of the project worktrees is chosen', () => {
    expect(deepSeekPanelRoot(get(deepSeekPlacements), 'p-main', '/repo')).toBe('/repo');
    setDeepSeekPlacement('p-main', '/repo/.spacron/trees/login');
    expect(deepSeekPanelRoot(get(deepSeekPlacements), 'p-main', '/repo')).toBe('/repo/.spacron/trees/login');
  });

  it('returns to the main checkout when the panel is opened there', () => {
    setDeepSeekPlacement('p-back', '/r/.spacron/trees/a');
    setDeepSeekPlacement('p-back', null);
    expect(deepSeekPanelRoot(get(deepSeekPlacements), 'p-back', '/r')).toBe('/r');
  });

  it('forgets a placement whose worktree has been deleted', () => {
    setDeepSeekPlacement('p-gone', 'C:\\repo\\.spacron\\trees\\a');
    clearDeepSeekPlacement('p-gone', 'c:/repo/.spacron/trees/a');
    expect(deepSeekPanelRoot(get(deepSeekPlacements), 'p-gone', 'C:\\repo')).toBe('C:\\repo');
  });

  it('compares folders the way the worktree lists do', () => {
    expect(sameFolder('C:\\Repo\\', 'c:/repo')).toBe(true);
    expect(sameFolder('C:\\Repo\\a', 'C:\\Repo')).toBe(false);
    expect(sameFolder(null, 'C:\\Repo')).toBe(false);
  });
});
