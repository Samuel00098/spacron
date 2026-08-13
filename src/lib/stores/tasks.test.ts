import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import { get } from './storeCompat';
import { addTask, getProjectTaskPanelLines, moveTask, tasks, updateTaskFields, updateTaskStatus } from './tasks';

describe('task panel summaries', () => {
  beforeEach(() => {
    tasks.set([]);
  });

  it('summarizes project tasks in action-oriented order', () => {
    addTask('project-1', 'Write the Docker container switch', 'todo');
    addTask('project-1', 'Wire task panel into orchestrator prompts', 'doing');
    addTask('project-1', 'Clean old docs', 'done');
    addTask('project-2', 'Ignore other project', 'doing');

    expect(getProjectTaskPanelLines('project-1')).toEqual([
      'In progress (1): Wire task panel into orchestrator prompts',
      'To do (1): Write the Docker container switch',
      'Done (1): Clean old docs',
    ]);
  });

  it('adds priority and due-date meta to open columns but not Done', () => {
    const future = Date.now() + 3 * 86400000;
    addTask('p', 'Write the Docker switch', 'todo', { priority: 'high', dueDate: future });
    addTask('p', 'Fix the flaky test', 'todo', { priority: 'medium' });
    addTask('p', 'Clean old docs', 'todo');
    addTask('p', 'Shipped thing', 'done', { priority: 'high', dueDate: Date.now() - 86400000 });

    const lines = getProjectTaskPanelLines('p');
    expect(lines[0]).toMatch(
      /^To do \(3\): \[High\] Write the Docker switch \(due \d{4}-\d{2}-\d{2}\); \[Med\] Fix the flaky test; Clean old docs$/,
    );
    // Done strips the meta even when the task carried it — the work is finished.
    expect(lines).toContain('Done (1): Shipped thing');
  });

  it('marks overdue tasks and sorts them first within their priority', () => {
    addTask('p', 'Late task', 'todo', { priority: 'high', dueDate: Date.now() - 86400000 });
    addTask('p', 'Due soon', 'todo', { priority: 'high', dueDate: Date.now() + 86400000 });

    expect(getProjectTaskPanelLines('p')[0]).toMatch(
      /^To do \(2\): \[High\] Late task \(OVERDUE \d{4}-\d{2}-\d{2}\); \[High\] Due soon \(due \d{4}-\d{2}-\d{2}\)$/,
    );
  });

  it('sorts by priority first, unset priority last', () => {
    addTask('p', 'Low prio', 'todo', { priority: 'low' });
    addTask('p', 'High prio', 'todo', { priority: 'high' });
    addTask('p', 'Med prio', 'todo', { priority: 'medium' });
    addTask('p', 'No prio', 'todo');

    expect(getProjectTaskPanelLines('p')[0]).toBe(
      'To do (4): [High] High prio; [Med] Med prio; [Low] Low prio; No prio',
    );
  });

  it('reports the full column count even beyond the six listed', () => {
    for (let i = 0; i < 8; i++) addTask('p', `Task ${i}`, 'todo');

    expect(getProjectTaskPanelLines('p')[0]).toBe(
      'To do (8): Task 0; Task 1; Task 2; Task 3; Task 4; Task 5',
    );
  });
});

describe('task fields', () => {
  beforeEach(() => {
    tasks.set([]);
  });

  it('carries priority, due date and description from addTask', () => {
    const due = Date.now();
    const task = addTask('p', 'Ship the dashboard', 'doing', {
      priority: 'high',
      dueDate: due,
      description: 'Add the usage meters to the status bar.',
    });
    expect(task.priority).toBe('high');
    expect(task.dueDate).toBe(due);
    expect(task.description).toBe('Add the usage meters to the status bar.');

    // Legacy callers get an explicit null due date, not an undefined gap.
    const plain = addTask('p', 'Plain task', 'todo');
    expect(plain.dueDate).toBeNull();
    expect(plain.priority).toBeUndefined();
  });

  it('updates individual fields via updateTaskFields', () => {
    const task = addTask('p', 'Old title', 'todo');
    updateTaskFields(task.id, { title: 'New title', priority: 'low' });
    const updated = get(tasks).find((t) => t.id === task.id);
    expect(updated?.title).toBe('New title');
    expect(updated?.priority).toBe('low');

    // Blank description is normalised away.
    updateTaskFields(task.id, { description: '   ' });
    expect(get(tasks).find((t) => t.id === task.id)?.description).toBeUndefined();
  });
});

describe('task moving and ordering', () => {
  beforeEach(() => {
    tasks.set([]);
  });

  it('appends to the target column and renumbers it', () => {
    const a = addTask('p', 'A', 'todo');
    const b = addTask('p', 'B', 'todo');
    const c = addTask('p', 'C', 'doing');

    updateTaskStatus(a.id, 'doing');
    const doing = get(tasks).filter((t) => t.status === 'doing');
    expect(doing.map((t) => t.title)).toEqual(['C', 'A']);
    expect(doing.map((t) => t.order)).toEqual([0, 1]);
    expect(get(tasks).find((t) => t.id === b.id)?.order).toBeUndefined();
  });

  it('inserts before a target card when reordering within a column', () => {
    const a = addTask('p', 'A', 'todo');
    const b = addTask('p', 'B', 'todo');
    const c = addTask('p', 'C', 'todo');

    moveTask(c.id, 'todo', a.id);
    const todo = get(tasks).filter((t) => t.status === 'todo');
    expect(todo.map((t) => t.title)).toEqual(['C', 'A', 'B']);
  });

  it('treats an unknown beforeId as append', () => {
    const a = addTask('p', 'A', 'todo');
    const b = addTask('p', 'B', 'todo');
    moveTask(a.id, 'todo', 'does-not-exist');
    expect(get(tasks).filter((t) => t.status === 'todo').map((t) => t.title)).toEqual(['B', 'A']);
  });

  it('places a moved task by urgency — a drop below a lower-priority task cannot win', () => {
    const low = addTask('p', 'Low prio', 'doing', { priority: 'low' });
    const high = addTask('p', 'High prio', 'todo', { priority: 'high' });

    // Dropping the high-priority card below the low one: the board's urgency
    // rule wins over the drop position, so it lands first.
    moveTask(high.id, 'doing', low.id);
    const doing = get(tasks).filter((t) => t.status === 'doing');
    expect(doing.map((t) => t.title)).toEqual(['High prio', 'Low prio']);
    expect(doing.map((t) => t.order)).toEqual([0, 1]);
  });

  it('keeps drag order as the tiebreaker between equal-urgency tasks', () => {
    const a = addTask('p', 'A', 'todo', { priority: 'high' });
    const b = addTask('p', 'B', 'todo', { priority: 'high' });
    moveTask(b.id, 'todo', a.id);
    expect(get(tasks).filter((t) => t.status === 'todo').map((t) => t.title)).toEqual(['B', 'A']);
  });
});
