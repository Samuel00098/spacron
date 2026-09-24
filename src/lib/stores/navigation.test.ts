import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// navigation.ts drives the real workspace/layout/editor stores; stand-ins keep
// this test on the history logic alone.
vi.mock('./workspace', async () => {
  const { writable } = await import('$lib/stores/storeCompat');
  const activeWorkspaceId = writable<string | null>('ws');
  const activeProjectId = writable<string | null>('p1');
  return {
    activeWorkspaceId,
    activeProjectId,
    openWorkspace: vi.fn(async (id: string) => activeWorkspaceId.set(id)),
    switchToProject: vi.fn((id: string) => activeProjectId.set(id)),
  };
});
vi.mock('./layout', async () => {
  const { writable } = await import('$lib/stores/storeCompat');
  const layout = writable({ activeView: 'terminal' });
  return { layout, setActiveView: vi.fn((view: string) => layout.set({ activeView: view })) };
});
vi.mock('./editor', async () => {
  const { writable } = await import('$lib/stores/storeCompat');
  const activeFile = writable<string | null>(null);
  return { activeFile, openFile: vi.fn(async (path: string) => activeFile.set(path)) };
});

import { get } from '$lib/stores/storeCompat';
import { layoutControlCommand, layoutSnapshot, type LayoutCommand } from './layoutControl';
import { activeProjectId } from './workspace';
import { canGoBack, canGoForward, initNavigationHistory, navigateBack, navigateForward } from './navigation';

function expand(room: string | null) {
  layoutSnapshot.update((s) => ({ ...s, expandedRoom: room }));
}

function lastExpandCommand(): string | null | undefined {
  const command = get(layoutControlCommand) as LayoutCommand | null;
  return command?.type === 'expand' ? command.room : undefined;
}

// History is module state, so it is started once and carried across the cases.
let started = false;

describe('navigation history: expanded panels', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    if (!started) {
      started = true;
      // History only starts in a browser window.
      vi.stubGlobal('window', globalThis);
      initNavigationHistory();
      await vi.advanceTimersByTimeAsync(150);
    }
    // Past the settle window that follows the initial project.
    await vi.advanceTimersByTimeAsync(1500);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('steps back and forward between expanded panels', async () => {
    expand('terminal');
    expand('preview');
    expect(get(canGoBack)).toBe(true);

    await navigateBack();
    expect(lastExpandCommand()).toBe('terminal');
    // AppShell catching up must not record a new step and wipe Forward.
    expand('terminal');
    expect(get(canGoForward)).toBe(true);

    await navigateForward();
    expect(lastExpandCommand()).toBe('preview');
    expand('preview');

    // Collapsing to the grid is a step too.
    expand(null);
    await navigateBack();
    expect(lastExpandCommand()).toBe('preview');
  });

  it('folds the stage restored by a project switch into that step', async () => {
    expand('terminal');
    activeProjectId.set('p2');
    // p2's saved stage lands a moment later through the command bus.
    expand('agent:7');

    await navigateBack();
    expect(get(activeProjectId)).toBe('p1');
    expect(get(canGoForward)).toBe(true);
  });
});
