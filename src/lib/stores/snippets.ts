import { writable, get, derived } from '$lib/stores/storeCompat';
import { backendInvoke } from '$lib/services/backend';
import { allProjectSettings, projectConfigFor, type ProjectHooks } from '$lib/stores/projectSettings';

export interface ShellSnippet {
  id: string;
  name: string;
  command: string;
  description: string;
  projectId?: string; // If undefined, it is a global snippet
}

// In-memory store
export const snippets = writable<ShellSnippet[]>([]);

const projectPaths = new Map<string, string>();

export function getSnippetsPath(rootPath: string): string {
  return `${rootPath}/.spacron/snippets.json`;
}

// Load global snippets
export function loadGlobalSnippets() {
  let loaded: ShellSnippet[] = [];
  try {
    const raw = localStorage.getItem('spacron_global_snippets');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) loaded = parsed;
    }
  } catch (err) {
    console.error('Failed to load global snippets:', err);
  }
  snippets.update(all => [
    ...all.filter(s => s.projectId !== undefined), // keep project snippets
    ...loaded
  ]);
}

// Save global snippets
function saveGlobalSnippets() {
  const globals = get(snippets).filter(s => s.projectId === undefined);
  try {
    localStorage.setItem('spacron_global_snippets', JSON.stringify(globals));
  } catch (err) {
    // A full quota is the realistic failure here. Left unguarded it threw out
    // of `addSnippet` — past the caller's success toast and form reset — so the
    // panel froze mid-save and the snippet was gone at the next mount, when
    // `loadGlobalSnippets` read the older localStorage copy back over it.
    // Matching the project path: keep the snippet in memory, log the reason.
    console.error('Failed to save global snippets:', err);
  }
}

// Load project-specific snippets
export async function loadProjectSnippets(project: { id: string; root_path: string }): Promise<void> {
  projectPaths.set(project.id, project.root_path);
  const path = getSnippetsPath(project.root_path);
  let loaded: ShellSnippet[] = [];
  try {
    const raw = await backendInvoke<string>('fs_read_file', { path });
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      loaded = parsed.map(s => ({ ...s, projectId: project.id }));
    }
  } catch {
    // file doesn't exist yet — start with empty project snippets
  }
  snippets.update(all => [
    ...all.filter(s => s.projectId !== project.id), // keep other projects and global snippets
    ...loaded,
  ]);

  const pConfig = projectConfigFor(get(allProjectSettings), project.root_path, project.id);
  if (pConfig?.hooks) {
    syncProjectHooksToSnippets(project.id, pConfig.hooks, project.root_path);
  }
}

/**
 * Synchronize project lifecycle hooks (setup, dev, build, test, clean) into
 * project shell snippets so they show up directly in the right sidebar's Shell Snippets panel.
 */
export function syncProjectHooksToSnippets(
  projectId: string,
  hooks: Partial<ProjectHooks> | Record<string, string>,
  rootPath?: string
): void {
  if (rootPath) {
    projectPaths.set(projectId, rootPath);
  }
  const hookDefs: Array<{ key: keyof ProjectHooks; label: string; desc: string }> = [
    { key: 'setup', label: 'Setup', desc: 'Project setup / bootstrap command' },
    { key: 'dev', label: 'Dev', desc: 'Local development server command' },
    { key: 'build', label: 'Build', desc: 'Production build verification script' },
    { key: 'test', label: 'Test', desc: 'Test runner' },
    { key: 'clean', label: 'Clean', desc: 'Clean build caches or worktree' },
  ];

  snippets.update((all) => {
    // Retain global snippets, snippets for other projects, and non-hook project snippets
    const nonHookSnippets = all.filter(
      (s) => s.projectId !== projectId || !s.id.startsWith(`hook_${projectId}_`)
    );
    const newHookSnippets: ShellSnippet[] = [];
    const hooksRecord = hooks as Record<string, string | undefined>;
    for (const def of hookDefs) {
      const cmd = hooksRecord[def.key]?.trim();
      if (cmd) {
        newHookSnippets.push({
          id: `hook_${projectId}_${def.key}`,
          name: def.label,
          command: cmd,
          description: def.desc,
          projectId,
        });
      }
    }
    return [...nonHookSnippets, ...newHookSnippets];
  });

  void flushProjectSnippets(projectId);
}

// Save project-specific snippets
async function flushProjectSnippets(projectId: string): Promise<void> {
  const rootPath = projectPaths.get(projectId);
  if (!rootPath) return;
  const dir = `${rootPath}/.spacron`;
  const path = getSnippetsPath(rootPath);
  const projectSnippets = get(snippets).filter(s => s.projectId === projectId);
  // Strip the projectId field before saving to file so it's clean and portable
  const cleanSnippets = projectSnippets.map(({ id, name, command, description }) => ({
    id, name, command, description
  }));
  try {
    try { await backendInvoke('fs_create_dir', { path: dir }); } catch { /* already exists */ }
    await backendInvoke('fs_write_file', { path, content: JSON.stringify(cleanSnippets, null, 2) });
  } catch (err) {
    console.error('Failed to save project snippets:', err);
  }
}

// Add a snippet
export function addSnippet(name: string, command: string, description: string, projectId?: string): ShellSnippet {
  const snippet: ShellSnippet = {
    id: `sn_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    name: name.trim(),
    command: command.trim(),
    description: description.trim(),
    projectId
  };
  snippets.update(all => [...all, snippet]);
  if (projectId) {
    void flushProjectSnippets(projectId);
  } else {
    saveGlobalSnippets();
  }
  return snippet;
}

// Update a snippet
export function updateSnippet(id: string, name: string, command: string, description: string) {
  let projectId: string | undefined = undefined;
  let isGlobal = false;
  snippets.update(all => all.map(s => {
    if (s.id !== id) return s;
    projectId = s.projectId;
    if (projectId === undefined) isGlobal = true;
    return { ...s, name: name.trim(), command: command.trim(), description: description.trim() };
  }));
  
  if (isGlobal) {
    saveGlobalSnippets();
  } else if (projectId) {
    void flushProjectSnippets(projectId);
  }
}

// Delete a snippet
export function deleteSnippet(id: string) {
  let projectId: string | undefined = undefined;
  let isGlobal = false;
  snippets.update(all => {
    const target = all.find(s => s.id === id);
    if (target) {
      projectId = target.projectId;
      if (projectId === undefined) isGlobal = true;
    }
    return all.filter(s => s.id !== id);
  });
  
  if (isGlobal) {
    saveGlobalSnippets();
  } else if (projectId) {
    void flushProjectSnippets(projectId);
  }
}

export function getProjectSnippets(projectId: string) {
  return derived(snippets, $snippets => $snippets.filter(s => s.projectId === projectId));
}

export function getGlobalSnippets() {
  return derived(snippets, $snippets => $snippets.filter(s => s.projectId === undefined));
}
