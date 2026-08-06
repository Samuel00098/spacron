/**
 * App-private per-project state, stored **outside** the user's repository.
 *
 * Spacron's own bookkeeping — the orchestrator task list, its memory and evolved
 * profile, the agent mailbox, the task board, the generated MCP config — used to
 * be written into `<project>/.spacron/`. Six app-owned files in every repo the
 * user opened, visible in file trees and searches, with the MCP config carrying
 * the local server's auth token in the working tree. None of it is read by an
 * agent CLI or by the user, so none of it belongs in the project.
 *
 * It now lives under the app config dir, keyed by project id (see
 * `src-tauri/src/commands/project_state.rs` for the path derivation and why this
 * needs no relaxation of the `require_in_roots` confinement check).
 *
 * What stays in the repo, deliberately: `.spacron/worktrees/` (must be under the
 * project root for `terminal_create`), `.spacron/memory/` (shared agent
 * knowledge, the user's content), `.spacron/reports/` (worker completion
 * signals), and the root-level CLI discovery files.
 *
 * ## Migration
 *
 * `readProjectState` falls back to the legacy in-repo path on a miss and adopts
 * whatever it finds, so an existing project keeps its orchestrator history,
 * mailbox and task board across the move. The legacy file is deleted once its
 * contents are safely rewritten to the new location — never before, so an
 * interrupted migration re-runs harmlessly on the next launch.
 */

import { backendInvoke } from '$lib/services/backend';

/** State keys. These are filenames under the project's state directory. */
export type ProjectStateKey =
  | 'orchestrator.json'
  | 'orchestrator-memory.json'
  | 'orchestrator-profile.json'
  | 'mailbox.json'
  | 'tasks.json';

/**
 * Where each key used to live inside the project, relative to its root. Used
 * only to migrate an existing project on first read.
 */
const LEGACY_RELATIVE_PATH: Record<ProjectStateKey, string> = {
  'orchestrator.json': '.spacron/orchestrator.json',
  'orchestrator-memory.json': '.spacron/orchestrator-memory.json',
  'orchestrator-profile.json': '.spacron/orchestrator-profile.json',
  'mailbox.json': '.spacron/mailbox.json',
  'tasks.json': '.spacron/tasks.json',
};

/** Projects whose legacy files we've already looked for, so the fallback read
 *  costs one miss per key per session rather than one on every save. */
const migrated = new Set<string>();

function migrationKey(projectId: string, key: ProjectStateKey) {
  return `${projectId}:${key}`;
}

/**
 * Read one app-private state file, migrating it out of the repo if this project
 * still has the legacy copy. Returns null when nothing has ever been saved.
 */
export async function readProjectState(
  projectId: string,
  rootPath: string | null | undefined,
  key: ProjectStateKey,
): Promise<string | null> {
  let current: string | null = null;
  try {
    current = await backendInvoke<string | null>('project_state_read', { projectId, key });
  } catch (err) {
    console.error(`Failed to read ${key}:`, err);
  }
  if (current !== null && current !== undefined) {
    migrated.add(migrationKey(projectId, key));
    return current;
  }

  // Nothing in the new location. Adopt the legacy in-repo file if it exists.
  if (!rootPath || migrated.has(migrationKey(projectId, key))) return null;
  migrated.add(migrationKey(projectId, key));

  const legacyPath = `${rootPath}/${LEGACY_RELATIVE_PATH[key]}`;
  let legacy: string;
  try {
    legacy = await backendInvoke<string>('fs_read_file', { path: legacyPath });
  } catch {
    return null; // no legacy file — a project that never used this feature
  }

  try {
    await backendInvoke('project_state_write', { projectId, key, content: legacy });
    // Only now is it safe to drop the in-repo copy. An interrupted migration
    // leaves the legacy file in place and simply re-runs next launch.
    await backendInvoke('fs_delete', { path: legacyPath });
  } catch (err) {
    console.error(`Failed to migrate ${key} out of the project:`, err);
  }
  return legacy;
}

/** Write one app-private state file. */
export async function writeProjectState(
  projectId: string,
  key: ProjectStateKey,
  content: string,
): Promise<void> {
  try {
    await backendInvoke('project_state_write', { projectId, key, content });
  } catch (err) {
    console.error(`Failed to save ${key}:`, err);
  }
}

/**
 * Absolute path to a state file, for the one case that must hand a real path to
 * an external process: the generated MCP config, which reaches the CLI as
 * `--mcp-config <path>`.
 */
export async function projectStatePath(projectId: string, key: string): Promise<string> {
  return backendInvoke<string>('project_state_path', { projectId, key });
}

/** Drop every app-private file for a project (called when it's removed). */
export async function clearProjectState(projectId: string): Promise<void> {
  try {
    await backendInvoke('project_state_clear', { projectId });
  } catch (err) {
    console.error('Failed to clear project state:', err);
  }
}
