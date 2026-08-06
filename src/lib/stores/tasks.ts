import { writable, get, derived } from '$lib/stores/storeCompat';
import { readProjectState, writeProjectState } from '$lib/services/project-state';

export type TaskStatus = 'todo' | 'doing' | 'done';

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  projectId: string;
  createdAt: number;
}

// In-memory store — all currently loaded project tasks
export const tasks = writable<Task[]>([]);

// The board is keyed by project id alone now that it persists outside the repo —
// flushing no longer needs the project's root path, so nothing tracks it here.
export async function loadProjectTasks(project: { id: string; root_path: string }): Promise<void> {
  let loaded: Task[] = [];
  try {
    const raw = await readProjectState(project.id, project.root_path, 'tasks.json');
    const parsed = JSON.parse(raw ?? '');
    if (Array.isArray(parsed)) loaded = parsed;
  } catch {
    // nothing saved yet — start with an empty board
  }
  tasks.update(all => [
    ...all.filter(t => t.projectId !== project.id),
    ...loaded,
  ]);
}

async function flushProjectTasks(projectId: string): Promise<void> {
  const projectTasks = get(tasks).filter(t => t.projectId === projectId);
  await writeProjectState(projectId, 'tasks.json', JSON.stringify(projectTasks, null, 2));
}

export function addTask(projectId: string, title: string, status: TaskStatus = 'todo'): Task {
  const task: Task = {
    id: `t_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    title: title.trim(),
    status,
    projectId,
    createdAt: Date.now(),
  };
  tasks.update(all => [...all, task]);
  void flushProjectTasks(projectId);
  return task;
}

export function updateTaskStatus(id: string, status: TaskStatus) {
  let projectId = '';
  tasks.update(all => all.map(t => {
    if (t.id !== id) return t;
    projectId = t.projectId;
    return { ...t, status };
  }));
  if (projectId) void flushProjectTasks(projectId);
}

export function updateTaskTitle(id: string, title: string) {
  let projectId = '';
  tasks.update(all => all.map(t => {
    if (t.id !== id) return t;
    projectId = t.projectId;
    return { ...t, title: title.trim() };
  }));
  if (projectId) void flushProjectTasks(projectId);
}

export function deleteTask(id: string) {
  let projectId = '';
  tasks.update(all => {
    const task = all.find(t => t.id === id);
    if (task) projectId = task.projectId;
    return all.filter(t => t.id !== id);
  });
  if (projectId) void flushProjectTasks(projectId);
}

export function getProjectTasks(projectId: string) {
  return derived(tasks, $tasks => $tasks.filter(t => t.projectId === projectId));
}

function compactTaskTitle(title: string): string {
  const text = title.replace(/\s+/g, ' ').trim();
  return text.length <= 90 ? text : `${text.slice(0, 89)}...`;
}

export function getProjectTaskPanelLines(projectId: string): string[] {
  const projectTasks = get(tasks).filter(t => t.projectId === projectId);
  if (projectTasks.length === 0) return [];

  const labels: Record<TaskStatus, string> = {
    todo: 'To do',
    doing: 'In progress',
    done: 'Done',
  };
  return (['doing', 'todo', 'done'] as TaskStatus[])
    .map((status) => {
      const items = projectTasks
        .filter((task) => task.status === status)
        .slice(0, 6)
        .map((task) => compactTaskTitle(task.title));
      if (items.length === 0) return '';
      return `${labels[status]} (${items.length}): ${items.join('; ')}`;
    })
    .filter(Boolean);
}
