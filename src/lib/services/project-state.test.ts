import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * These tests are about **which transport** each call takes, not about what the
 * backend does with it.
 *
 * `project_state_*` is app-private bookkeeping in this machine's config dir, and
 * the orchestrator that owns it is entirely frontend TypeScript. Sending it
 * through `backendInvoke` routes it to `spacron-server` whenever a remote
 * workspace is active, and the server has no `project_state_*` arm — so every
 * read came back "unsupported remote command" into a `catch` that returns null
 * and every write failed the same silent way. The orchestrator came up empty
 * against a remote with nothing shown to the user.
 *
 * The legacy migration is the deliberate exception: it touches a file *inside
 * the repository*, which really is workspace state, so it stays routed.
 */

const invoke = vi.hoisted(() => vi.fn(async (_command: string, _args?: any): Promise<any> => null));
const backendInvoke = vi.hoisted(() =>
  vi.fn(async (_command: string, _args?: any): Promise<any> => {
    throw new Error('no legacy file');
  }),
);

vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('$lib/services/backend', () => ({ backendInvoke }));

import {
  readProjectState,
  writeProjectState,
  clearProjectState,
} from './project-state';

/** Commands seen on the app-local (bare Tauri) transport. */
function localCommands(): string[] {
  return invoke.mock.calls.map(([command]) => command);
}

/** Commands seen on the workspace transport, which follows a remote. */
function routedCommands(): string[] {
  return backendInvoke.mock.calls.map(([command]) => command);
}

/** A fresh project id per test — the migration guard is module-level state. */
let nextId = 0;
function freshProjectId(): string {
  nextId += 1;
  return `project-${nextId}`;
}

beforeEach(() => {
  invoke.mockClear();
  backendInvoke.mockClear();
  invoke.mockImplementation(async () => null);
  backendInvoke.mockImplementation(async () => {
    throw new Error('no legacy file');
  });
});

describe('app-private state stays on this machine', () => {
  it('reads through a bare invoke, never the workspace transport', async () => {
    invoke.mockImplementation(async () => '{"tasks":[]}');

    await readProjectState(freshProjectId(), '/repo', 'tasks.json');

    expect(localCommands()).toContain('project_state_read');
    expect(routedCommands()).not.toContain('project_state_read');
  });

  it('writes through a bare invoke, never the workspace transport', async () => {
    await writeProjectState(freshProjectId(), 'inbox.json', '[]');

    expect(localCommands()).toContain('project_state_write');
    expect(routedCommands()).not.toContain('project_state_write');
  });

  it('clears through a bare invoke, never the workspace transport', async () => {
    await clearProjectState(freshProjectId());

    expect(localCommands()).toContain('project_state_clear');
    expect(routedCommands()).not.toContain('project_state_clear');
  });

  it('never routes any project_state command, for any key', async () => {
    const projectId = freshProjectId();
    invoke.mockImplementation(async () => '{}');

    await readProjectState(projectId, '/repo', 'orchestrator.json');
    await writeProjectState(projectId, 'mailbox.json', '[]');
    await clearProjectState(projectId);

    expect(routedCommands().filter((c) => c.startsWith('project_state'))).toEqual([]);
  });
});

describe('the in-repo legacy file follows the workspace', () => {
  it('reads the legacy copy through the routed transport, not a bare invoke', async () => {
    const projectId = freshProjectId();
    // Nothing in the new location, so the legacy fallback runs.
    invoke.mockImplementation(async (command: string) =>
      command === 'project_state_read' ? null : undefined,
    );
    backendInvoke.mockImplementation(async (command: string) =>
      command === 'fs_read_file' ? '{"legacy":true}' : undefined,
    );

    const result = await readProjectState(projectId, '/repo', 'tasks.json');

    expect(result).toBe('{"legacy":true}');
    expect(routedCommands()).toContain('fs_read_file');
    expect(localCommands()).not.toContain('fs_read_file');
  });

  it('adopts the legacy contents locally, then deletes the repo copy remotely', async () => {
    const projectId = freshProjectId();
    invoke.mockImplementation(async (command: string) =>
      command === 'project_state_read' ? null : undefined,
    );
    backendInvoke.mockImplementation(async (command: string) =>
      command === 'fs_read_file' ? 'legacy-content' : undefined,
    );

    await readProjectState(projectId, '/repo', 'mailbox.json');

    // The adopted copy is written to app-private state on this machine...
    const write = invoke.mock.calls.find(([command]) => command === 'project_state_write');
    expect(write?.[1]).toMatchObject({ projectId, key: 'mailbox.json', content: 'legacy-content' });
    // ...and only the repo-side delete follows the workspace.
    expect(routedCommands()).toContain('fs_delete');
    expect(localCommands()).not.toContain('fs_delete');
  });

  it('returns null when there is neither new nor legacy state', async () => {
    const result = await readProjectState(freshProjectId(), '/repo', 'inbox.json');
    expect(result).toBeNull();
  });
});
