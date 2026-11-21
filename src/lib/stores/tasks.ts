import { writable, get, derived } from '$lib/stores/storeCompat';
import { readProjectState, writeProjectState } from '$lib/services/project-state';

export type TaskStatus = 'todo' | 'doing' | 'done';

export type TaskPriority = 'high' | 'medium' | 'low';

/** Display labels for the three priorities, shared by the panel and the agent context. */
export const PRIORITY_LABEL: Record<TaskPriority, string> = {
  high: 'High',
  medium: 'Med',
  low: 'Low',
};

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  projectId: string;
  createdAt: number;
  /** High / medium / low — the same field set Orca's issue integrations carry. */
  priority?: TaskPriority;
  /** Due date as an epoch ms timestamp (end of day); null/absent = none. */
  dueDate?: number | null;
  /** Free-form notes; fed to an agent when the task is "run with agent". */
  description?: string;
  /** Tiebreaker within equal urgency. Legacy rows lack it and fall back to createdAt. */
  order?: number;
}

// In-memory store — all currently loaded project tasks
export const tasks = writable<Task[]>([]);

export const openIssuesRequest = writable(false);

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

export function addTask(
  projectId: string,
  title: string,
  status: TaskStatus = 'todo',
  extra?: { priority?: TaskPriority; dueDate?: number | null; description?: string },
): Task {
  const task: Task = {
    id: `t_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    title: title.trim(),
    status,
    projectId,
    createdAt: Date.now(),
    priority: extra?.priority,
    dueDate: extra?.dueDate ?? null,
    description: extra?.description?.trim() || undefined,
  };
  tasks.update(all => [...all, task]);
  void flushProjectTasks(projectId);
  return task;
}

/** Patch any editable field of a task (title, priority, due date, description, status). */
export function updateTaskFields(id: string, patch: Partial<Pick<Task, 'title' | 'status' | 'priority' | 'dueDate' | 'description'>>) {
  let projectId = '';
  tasks.update(all => all.map(t => {
    if (t.id !== id) return t;
    projectId = t.projectId;
    const next: Task = { ...t, ...patch };
    // Normalise on write: blank title is rejected; blank description becomes undefined.
    if (typeof next.title === 'string') next.title = next.title.trim();
    if (typeof next.description === 'string') next.description = next.description.trim() || undefined;
    return next;
  }));
  if (projectId) void flushProjectTasks(projectId);
}

/**
 * Move a task into `toStatus` (optionally before `beforeId` within that column)
 * and renumber the target column so drag & drop ordering is durable.
 *
 * One function covers the drag cases (between columns, and within a column) and
 * is also what `updateTaskStatus` delegates to, so every status change lands the
 * task at a deterministic position instead of wherever it happened to be.
 */
export function moveTask(taskId: string, toStatus: TaskStatus, beforeId?: string | null): void {
  let projectId = '';
  tasks.update(all => {
    const dragged = all.find(t => t.id === taskId);
    if (!dragged) return all;
    projectId = dragged.projectId;

    // Scope the whole move to the dragged task's project: a board is per-project,
    // and renumbering a global same-status column would rewrite other projects'
    // order values (invisible, but a move shouldn't touch what it didn't move).
    const inProject = all.filter(t => t.projectId === dragged.projectId);
    const others = inProject.filter(t => t.id !== taskId);
    const byId = new Map(others.map(t => [t.id, t]));
    // The column is ordered by urgency (the board's rule), so a drop "before X"
    // lands where the board will show it; the renumbered `order` then only
    // breaks ties between equal-urgency tasks.
    const columnIds = others
      .filter(t => t.status === toStatus)
      .sort(compareTaskUrgency)
      .map(t => t.id);
    const at = beforeId != null ? columnIds.indexOf(beforeId) : -1;
    const insertAt = at >= 0 ? at : columnIds.length;
    columnIds.splice(insertAt, 0, taskId);

    const orderById = new Map(columnIds.map((id, i) => [id, i]));

    // Rebuild the project's tasks in visual order — the dragged task at its new
    // position, its column sorted by order — so any consumer that iterates the
    // store directly sees the same sequence as the board. Other projects' rows
    // keep their exact positions.
    const rebuilt: Task[] = [];
    for (const status of ['todo', 'doing', 'done'] as TaskStatus[]) {
      const ids = status === toStatus
        ? columnIds
        : others
            .filter(t => t.status === status)
            .sort(compareTaskUrgency)
            .map(t => t.id);
      for (const id of ids) {
        const base = id === taskId ? dragged : byId.get(id);
        if (!base) continue;
        // The dragged task carries its new column; the rest keep theirs.
        const placed = id === taskId ? { ...base, status: toStatus } : base;
        const o = orderById.get(id);
        rebuilt.push(o !== undefined ? { ...placed, order: o } : placed);
      }
    }
    return [...all.filter(t => t.projectId !== dragged.projectId), ...rebuilt];
  });
  if (projectId) void flushProjectTasks(projectId);
}

/** Move a task to a status, appended at the end of that column. Kept as the
 *  existing name so callers (orchestrator brain, panels) don't all change. */
export function updateTaskStatus(id: string, status: TaskStatus) {
  moveTask(id, status);
}

/** Backwards-compatible title-only rename; kept for existing callers. */
export function updateTaskTitle(id: string, title: string) {
  updateTaskFields(id, { title });
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

/** Lower urgency rank sorts first: high < medium < low < unset. */
const PRIORITY_RANK: Record<TaskPriority, number> = { high: 0, medium: 1, low: 2 };

function priorityRank(task: Task): number {
  return task.priority ? PRIORITY_RANK[task.priority] : 3;
}

/**
 * The one urgency rule for BOTH the board and the agent context: priority first
 * (high → medium → low → unset), then due date (overdue first, undated last),
 * then manual board order as the tiebreaker. Sorting the board and the context
 * with the same comparator is what keeps the two views in agreement.
 */
export function compareTaskUrgency(a: Task, b: Task): number {
  const byPriority = priorityRank(a) - priorityRank(b);
  if (byPriority !== 0) return byPriority;
  const da = a.dueDate ?? Number.POSITIVE_INFINITY;
  const db = b.dueDate ?? Number.POSITIVE_INFINITY;
  if (da !== db) return da - db;
  return (a.order ?? a.createdAt) - (b.order ?? b.createdAt);
}

/** A timestamp → `YYYY-MM-DD` in local time — the shared date format for the
 *  panel's native picker and the agent context lines. */
export function toIsoDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** True when the due date has passed the start of today (same rule everywhere). */
export function isOverdue(ts: number): boolean {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return ts < today.getTime();
}

/** One task rendered for the agent context. Urgency meta is the point of the
 *  line — an agent can't plan around a bare title. Done tasks omit it (the work
 *  is finished; its deadline no longer matters). */
function formatTaskLine(task: Task, includeMeta: boolean): string {
  const bits: string[] = [];
  if (includeMeta && task.priority) bits.push(`[${PRIORITY_LABEL[task.priority]}]`);
  bits.push(compactTaskTitle(task.title));
  if (includeMeta && task.dueDate != null) {
    const iso = toIsoDate(task.dueDate);
    bits.push(isOverdue(task.dueDate) ? `(OVERDUE ${iso})` : `(due ${iso})`);
  }
  return bits.join(' ');
}

/**
 * The task panel condensed for the agent context: one line per status column,
 * urgency-ordered so the fleet plans around what matters first.
 *
 * Within a column tasks sort by priority (high → low, unset last), then by due
 * date (overdue first, undated last), then by board order — so the first six
 * listed are the six most urgent, and the count reports the whole column, not
 * just what got listed.
 */
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
      const column = projectTasks.filter((task) => task.status === status);
      if (column.length === 0) return '';
      const ordered = [...column].sort(compareTaskUrgency);
      const shown = ordered
        .slice(0, 6)
        .map((task) => formatTaskLine(task, status !== 'done'))
        .join('; ');
      return `${labels[status]} (${column.length}): ${shown}`;
    })
    .filter(Boolean);
}
