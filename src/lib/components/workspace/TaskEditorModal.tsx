import { useEffect, useRef, useState } from 'react';
import { useModalFocus } from '$lib/react/useModalFocus';
import {
  updateTaskFields,
  updateTaskStatus,
  deleteTask,
  toIsoDate,
  type Task,
  type TaskPriority,
  type TaskStatus,
} from '$lib/stores/tasks';
import { showToast } from '$lib/stores/notification';
import { getAgentDisplayName } from '$lib/stores/terminal';
import { AgentBrandMark } from '$lib/components/shared/useAgentBrand';
import './TaskEditorModal.css';

const PRIORITIES: { id: TaskPriority; label: string }[] = [
  { id: 'high', label: 'High' },
  { id: 'medium', label: 'Med' },
  { id: 'low', label: 'Low' },
];

const STATUSES: { id: TaskStatus; label: string }[] = [
  { id: 'todo', label: 'To Do' },
  { id: 'doing', label: 'In Progress' },
  { id: 'done', label: 'Done' },
];

// Keystroke-to-store delay for the title/notes autosave.
const AUTO_SAVE_DELAY_MS = 500;

function RocketGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
      <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
      <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
      <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
    </svg>
  );
}

/**
 * The task detail editor: title + notes inline, priority / due date / status as
 * controls, plus "Run with agent" — the Orca-style task→agent link — and delete.
 * Every control writes straight to the store (which persists), so nothing is
 * left unsaved if the modal is dismissed.
 */
export default function TaskEditorModal({
  task,
  agents,
  onRun,
  onClose,
}: {
  task: Task;
  agents: { command: string; name: string }[];
  onRun: (command: string) => void;
  onClose: () => void;
}) {
  const backdropRef = useRef<HTMLDivElement | null>(null);
  useModalFocus(backdropRef, onClose);
  const [title, setTitle] = useState(task.title);
  const [desc, setDesc] = useState(task.description ?? '');
  const [showRunMenu, setShowRunMenu] = useState(false);

  // Title and notes auto-save: each keystroke (re)arms a short debounce that
  // writes straight to the store (which persists), so nothing is left unsaved
  // if the modal is dismissed mid-typing. Blur and unmount flush any pending
  // write synchronously. Everything reads through refs so the callbacks never
  // see stale text — `taskRef` in particular, since the `task` prop updates as
  // each save lands.
  const taskRef = useRef(task);
  taskRef.current = task;
  const titleRef = useRef(title);
  titleRef.current = title;
  const descRef = useRef(desc);
  descRef.current = desc;
  const titleTimerRef = useRef<number | null>(null);
  const descTimerRef = useRef<number | null>(null);

  function saveTitle() {
    if (titleTimerRef.current != null) {
      window.clearTimeout(titleTimerRef.current);
      titleTimerRef.current = null;
    }
    const trimmed = titleRef.current.trim();
    // Never save an emptied title — the blur handler snaps it back instead.
    if (!trimmed || trimmed === taskRef.current.title) return;
    updateTaskFields(task.id, { title: trimmed });
  }

  function saveDesc() {
    if (descTimerRef.current != null) {
      window.clearTimeout(descTimerRef.current);
      descTimerRef.current = null;
    }
    if (descRef.current !== (taskRef.current.description ?? '')) {
      updateTaskFields(task.id, { description: descRef.current });
    }
  }

  function scheduleTitleSave() {
    if (titleTimerRef.current != null) window.clearTimeout(titleTimerRef.current);
    titleTimerRef.current = window.setTimeout(saveTitle, AUTO_SAVE_DELAY_MS);
  }

  function scheduleDescSave() {
    if (descTimerRef.current != null) window.clearTimeout(descTimerRef.current);
    descTimerRef.current = window.setTimeout(saveDesc, AUTO_SAVE_DELAY_MS);
  }

  // Blur keeps the original empty-title semantics on top of the flush.
  function commitTitle() {
    saveTitle();
    if (!titleRef.current.trim()) setTitle(taskRef.current.title);
  }

  useEffect(
    () => () => {
      saveTitle();
      saveDesc();
    },
    [],
  );

  function setDueDate(value: string) {
    if (!value) {
      updateTaskFields(task.id, { dueDate: null });
      return;
    }
    // End of the chosen day, so "Today" stays true until midnight.
    const d = new Date(`${value}T23:59:59`);
    if (!Number.isNaN(d.getTime())) updateTaskFields(task.id, { dueDate: d.getTime() });
  }

  function run(command: string) {
    setShowRunMenu(false);
    onRun(command);
  }

  function runClick() {
    if (agents.length === 0) {
      showToast('No agents available to run this task', 'warning', 3500);
      return;
    }
    if (agents.length === 1) {
      run(agents[0].command);
      return;
    }
    setShowRunMenu((v) => !v);
  }

  return (
    <div
      className="task-editor-backdrop"
      ref={backdropRef}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="task-editor" role="dialog" aria-label={`Edit task: ${task.title}`}>
        <header className="te-head">
          <div className="te-head-left">
            <span className="te-icon">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 6h11" /><path d="M9 12h11" /><path d="M9 18h11" />
                <path d="m3.5 5.5 1.4 1.4L7.5 4.4" /><path d="m3.5 11.5 1.4 1.4 2.6-2.5" /><path d="m3.5 17.5 1.4 1.4 2.6-2.5" />
              </svg>
            </span>
            <span className="te-title">Task</span>
          </div>
          <button className="te-close" onClick={onClose} aria-label="Close" title="Close">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </header>

        <div className="te-body">
          <input
            className="te-field te-title-input"
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              scheduleTitleSave();
            }}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            }}
            placeholder="Task title"
            aria-label="Task title"
          />
          <textarea
            className="te-field te-desc"
            value={desc}
            onChange={(e) => {
              setDesc(e.target.value);
              scheduleDescSave();
            }}
            onBlur={saveDesc}
            placeholder="Notes: what should the agent do?"
            rows={4}
            aria-label="Task notes"
          />

          <div className="te-row">
            <span className="te-label">Priority</span>
            <div className="te-seg" role="group" aria-label="Priority">
              {PRIORITIES.map((p) => (
                <button
                  key={p.id}
                  className={`te-seg-btn pri-${p.id}${task.priority === p.id ? ' active' : ''}`}
                  onClick={() => updateTaskFields(task.id, { priority: p.id })}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <div className="te-row">
            <span className="te-label">Due</span>
            <div className="te-due">
              <input
                type="date"
                className="te-field te-date"
                value={task.dueDate != null ? toIsoDate(task.dueDate) : ''}
                onChange={(e) => setDueDate(e.target.value)}
                aria-label="Due date"
              />
              {task.dueDate != null && (
                <button
                  className="te-clear-due"
                  onClick={() => updateTaskFields(task.id, { dueDate: null })}
                  title="Clear due date"
                  aria-label="Clear due date"
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              )}
            </div>
          </div>

          <div className="te-row">
            <span className="te-label">Status</span>
            <div className="te-seg" role="group" aria-label="Status">
              {STATUSES.map((s) => (
                <button
                  key={s.id}
                  className={`te-seg-btn${task.status === s.id ? ' active' : ''}`}
                  onClick={() => updateTaskStatus(task.id, s.id)}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <footer className="te-foot">
          <div className="te-run-wrap">
            <button className="te-run" onClick={runClick}>
              <RocketGlyph />
              Run with agent
            </button>
            {showRunMenu && (
              <div className="task-run-menu te-run-menu">
                {agents.map((a) => (
                  <button
                    key={a.command}
                    className="task-run-opt"
                    onClick={() => run(a.command)}
                  >
                    <AgentBrandMark command={a.command} name={a.name} />
                    <span>{getAgentDisplayName(a.command) ?? a.name ?? a.command}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            className="te-delete"
            onClick={() => {
              deleteTask(task.id);
              onClose();
            }}
          >
            Delete
          </button>
        </footer>
      </div>
    </div>
  );
}
