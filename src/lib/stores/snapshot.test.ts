import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from './storeCompat';
import { activeProjectId } from './workspace';
import { createTerminalSession, killSession, sessions, setGridLayout } from './terminal';
import { restoreSnapshot, saveSnapshot, snapshots, type WorkspaceSnapshot } from './snapshot';

vi.mock('./workspace', async () => {
  const { writable } = await import('./storeCompat');
  return { activeProjectId: writable<string | null>('a') };
});
vi.mock('./terminal', async () => {
  const { writable } = await import('./storeCompat');
  return {
    sessions: writable([]), paneAssignments: writable([null]), gridLayout: writable('single'),
    createTerminalSession: vi.fn(), killSession: vi.fn(), setSessionRole: vi.fn(), setGridLayout: vi.fn(),
  };
});
vi.mock('./layout', async () => {
  const { writable } = await import('./storeCompat');
  return { layout: writable({ activeView: 'terminal', sidebarWidth: 310 }), sanitiseActiveView: (value: string) => value };
});
vi.mock('./preview', async () => {
  const { writable } = await import('./storeCompat');
  return {
    currentUrl: writable('/'), targetPort: writable(5173), previewTabs: writable([]),
    activePreviewTabId: writable(null), restorePreviewTabsState: vi.fn(), setTargetPort: vi.fn(),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  activeProjectId.set('a');
  snapshots.set([]);
  sessions.set([]);
});

describe('project snapshots', () => {
  it('tags saved snapshots and caps each project independently', () => {
    const first = saveSnapshot('A');
    expect(first.projectId).toBe('a');
    activeProjectId.set('b');
    for (let i = 0; i < 22; i++) saveSnapshot(`B ${i}`);
    expect(get(snapshots).filter((item) => item.projectId === 'b')).toHaveLength(20);
    expect(get(snapshots).find((item) => item.id === first.id)).toEqual(first);
  });

  it('rejects foreign and legacy snapshots before stopping any terminals', async () => {
    const snapshot = saveSnapshot('A');
    activeProjectId.set('b');
    await expect(restoreSnapshot(snapshot)).rejects.toThrow('another project');
    await expect(restoreSnapshot({ ...snapshot, projectId: undefined })).rejects.toThrow('another project');
    expect(killSession).not.toHaveBeenCalled();
    expect(createTerminalSession).not.toHaveBeenCalled();
  });

  it('stops restoration after a project switch while terminals are stopping', async () => {
    const snapshot = saveSnapshot('A');
    sessions.set([{ id: 1 }] as never);
    vi.mocked(killSession).mockImplementationOnce(async () => {
      activeProjectId.set('b');
      activeProjectId.set('a');
    });
    await expect(restoreSnapshot(snapshot)).rejects.toThrow('project changed');
    expect(setGridLayout).not.toHaveBeenCalled();
  });

  it('binds recreated terminals to the original project and stops after switching', async () => {
    const snapshot: WorkspaceSnapshot = { ...saveSnapshot('A'), panes: [{ cwd: '/a' }, { cwd: '/a' }] };
    vi.mocked(createTerminalSession).mockImplementationOnce(async () => {
      activeProjectId.set('b');
      return 12;
    });
    await expect(restoreSnapshot(snapshot)).rejects.toThrow('project changed');
    expect(createTerminalSession).toHaveBeenCalledExactlyOnceWith('/a', 0, 'a');
  });
});
