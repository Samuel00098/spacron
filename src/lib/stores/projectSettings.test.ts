import { afterEach, describe, expect, it, vi } from 'vitest';
import { get } from './storeCompat';
import {
  allProjectSettings,
  autoDetectProjectIcon,
  projectConfigFor,
  isProjectHidden,
  projectIconFor,
  setProjectIcon,
  updateProjectConfig,
  updateProjectConfigFor,
} from './projectSettings';
import { backendInvoke } from '$lib/services/backend';

vi.mock('$lib/services/backend', () => ({ backendInvoke: vi.fn() }));

const path = 'C:\\Work\\My Project';
const recentPath = 'c:/work/my project/';

afterEach(() => {
  allProjectSettings.set({});
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

it('shares hide and unhide across native and recent sidebar paths', () => {
  const path = 'D:\\Projects\\Hidden';
  const nativePath = '\\\\?\\D:\\Projects\\Hidden';
  expect(isProjectHidden(get(allProjectSettings), path, null, true)).toBe(true);
  updateProjectConfigFor(nativePath, { hideFromSidebar: true });
  expect(isProjectHidden(get(allProjectSettings), 'd:/projects/hidden/')).toBe(true);
  updateProjectConfigFor(path, { hideFromSidebar: false });
  expect(isProjectHidden(get(allProjectSettings), nativePath, null, true)).toBe(false);
});

describe('project icons', () => {
  it('uses an inactive project’s saved icon when it is reopened under a different ID', () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('window', {});
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    updateProjectConfig('open-project', { icon: 'icon:code' });
    expect(projectIconFor(get(allProjectSettings), path, 'open-project')).toBe('icon:code');

    setProjectIcon(recentPath, recentPath, 'icon:rocket');
    expect(projectIconFor(get(allProjectSettings), path, 'open-project')).toBe('icon:rocket');

    allProjectSettings.set({});
    expect(projectIconFor(get(allProjectSettings), path, 'new-project')).toBe('icon:rocket');
    setProjectIcon('new-project', path, 'icon:folder');
    expect(projectIconFor(get(allProjectSettings), recentPath, 'open-project')).toBe('icon:folder');
  });

  it('keeps the manually chosen icon when background detection finishes', async () => {
    const scanPath = 'C:\\Work\\Icon Scan';
    let finishDetection!: (result: { icon: string }) => void;
    vi.mocked(backendInvoke).mockImplementationOnce(() => new Promise((resolve) => {
      finishDetection = resolve;
    }));
    updateProjectConfig('open-project', { icon: '' });

    const result = autoDetectProjectIcon('open-project', scanPath);
    setProjectIcon(scanPath, scanPath, 'icon:rocket');
    finishDetection({ icon: 'icon:code' });

    await expect(result).resolves.toBe('icon:rocket');
    expect(projectIconFor(get(allProjectSettings), scanPath, 'open-project')).toBe('icon:rocket');
  });
});

it('applies edits from a recent project when it opens without losing settings stored under its ID', () => {
  const root = 'C:\\Work\\Project Settings';
  updateProjectConfig('open-project', {
    customInstructions: 'Preserve these guidelines',
    hooks: { setup: 'npm ci', dev: '', build: '', test: '', lint: '', clean: '' },
  });
  updateProjectConfigFor('c:/work/project settings/', { displayName: 'Updated', hooks: { test: 'npm test' } });
  updateProjectConfigFor(root, { hideFromSidebar: true, worktreeBase: 'origin/release' });

  expect(projectConfigFor(get(allProjectSettings), root, 'open-project')).toMatchObject({
    displayName: 'Updated',
    hideFromSidebar: true,
    worktreeBase: 'origin/release',
    customInstructions: 'Preserve these guidelines',
    hooks: { setup: 'npm ci', test: 'npm test' },
  });
  expect(projectConfigFor(get(allProjectSettings), 'C:\\Work\\Different Project').displayName).toBe('');
});
