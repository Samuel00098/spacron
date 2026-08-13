import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  tasks,
  addTask,
  updateTaskStatus,
  moveTask,
  deleteTask,
  loadProjectTasks,
  PRIORITY_LABEL,
  isOverdue,
  compareTaskUrgency,
  type Task,
  type TaskStatus,
} from '$lib/stores/tasks';
import { activeProject } from '$lib/stores/workspace';
import { showToast } from '$lib/stores/notification';
import { getDispatchableAgents, sendChatMessage } from '$lib/stores/orchestrator';
import { getAgentDisplayName } from '$lib/stores/terminal';
import { AgentBrandMark } from '$lib/components/shared/useAgentBrand';
import { createVoiceInputSession, mergeVoiceTranscript } from '$lib/services/voice-input';
import { refineVoicePrompt } from '$lib/services/voice-refinement';
import { useStore } from '$lib/react/useStore';
import TaskEditorModal from './TaskEditorModal';
import './TasksPanel.css';

type StatusRecord<T> = { todo: T; doing: T; done: T };

const columns: { id: TaskStatus; label: string; color: string; borderColor: string; badgeBg: string; badgeColor: string }[] = [
  { id: 'todo',  label: 'To Do',       color: 'var(--text-muted)',  borderColor: 'rgba(148,148,166,0.4)',  badgeBg: 'rgba(148,148,166,0.1)',  badgeColor: 'var(--text-muted)' },
  { id: 'doing', label: 'In Progress', color: 'var(--warning)',     borderColor: 'rgba(251,191,36,0.45)', badgeBg: 'rgba(251,191,36,0.12)', badgeColor: 'var(--warning)' },
  { id: 'done',  label: 'Done',        color: 'var(--success)',     borderColor: 'rgba(74,222,128,0.45)', badgeBg: 'rgba(74,222,128,0.12)', badgeColor: 'var(--success)' },
];const statusOrder: TaskStatus[] = ['todo', 'doing', 'done'];

function formatDue(ts: number): string {
  const day = 86400000;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(ts);
  due.setHours(0, 0, 0, 0);
  const diffDays = Math.round((due.getTime() - today.getTime()) / day);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Tomorrow';
  if (diffDays === -1) return 'Yesterday';
  return due.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function RocketGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
      <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
      <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
      <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
    </svg>
  );
}

function PencilGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
    </svg>
  );
}

export default function TasksPanel() {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [isNarrow, setIsNarrow] = useState(false);
  const [newTaskInputs, setNewTaskInputs] = useState<StatusRecord<string>>({ todo: '', doing: '', done: '' });
  const [listeningStatus, setListeningStatus] = useState<StatusRecord<boolean>>({ todo: false, doing: false, done: false });
  const [refiningStatus, setRefiningStatus] = useState<StatusRecord<boolean>>({ todo: false, doing: false, done: false });

  // Drag & drop state. `dropTarget` tracks where the dragged card would land so
  // the column and the card under the cursor can light up.
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ col: TaskStatus; beforeId: string | null } | null>(null);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [runMenuTaskId, setRunMenuTaskId] = useState<string | null>(null);
  // Set right after a drag ends so the browser's follow-up click on the source
  // card doesn't open the editor — the drop already did the work.
  const justDraggedRef = useRef(false);
  // The card currently collapsing out of its column after a cross-column drop.
  const [exitingId, setExitingId] = useState<string | null>(null);
  // FLIP: rects of every card just before a board mutation, so the commit can
  // animate cards sliding to their new seats instead of teleporting.
  const prevCardRectsRef = useRef<Map<string, DOMRect>>(new Map());
  // Suppress the entrance animation on the board's first paint — loading a
  // project shouldn't replay the whole entrance.
  const [suppressEnter, setSuppressEnter] = useState(true);
  // A cross-column exit is a delayed commit; track it so a superseded exit can
  // be flushed immediately instead of leaving an invisible card behind.
  const exitTimerRef = useRef<number | null>(null);
  const pendingExitRef = useRef<(() => void) | null>(null);
  // Cross-column drops delay the commit; the post-drop click guard must cover
  // that window. Same-column drops commit instantly, so they keep the original
  // hair-trigger guard instead of swallowing clicks for 300ms+.
  const longClickGuardRef = useRef(false);

  const allTasks = useStore(tasks);
  const project = useStore(activeProject);
  const projectId = project?.id ?? '';

  const projectTasks = useMemo(
    () => allTasks.filter((t) => t.projectId === projectId),
    [allTasks, projectId],
  );

  const doneCount = projectTasks.filter((t) => t.status === 'done').length;
  const openCount = projectTasks.length - doneCount;

  const editingTask = useMemo(
    () => (editingTaskId ? projectTasks.find((t) => t.id === editingTaskId) ?? null : null),
    [editingTaskId, projectTasks],
  );

  // Agents that can actually be launched for this project, for "Run with agent".
  const dispatchableAgents = useMemo(() => getDispatchableAgents(projectId), [projectId]);

  // Columns sort by urgency (priority → due date → drag order) — the same rule
  // the agent context uses, so the board and the fleet agree on what matters.
  function getColumnTasks(status: TaskStatus) {
    return projectTasks.filter((t) => t.status === status).sort(compareTaskUrgency);
  }

  // ── Card motion (FLIP + entrances + exits) ────────────────────────────────
  // Record every card's current rect. Call immediately BEFORE a store mutation
  // so the post-commit FLIP pass can animate each still-mounted card from its
  // old seat to its new one.
  function snapshotCards() {
    const rects = new Map<string, DOMRect>();
    panelRef.current?.querySelectorAll<HTMLElement>('.task-card').forEach((el) => {
      const id = el.dataset.taskId;
      if (id) rects.set(id, el.getBoundingClientRect());
    });
    prevCardRectsRef.current = rects;
  }

  // Collapse a card out of its column (fade + shrink + height), then run
  // `done` once it is gone. Used on cross-column drops so the card visibly
  // LEAVES the source column before the store commit removes it.
  function beginCardExit(id: string, done: () => void) {
    const el = panelRef.current?.querySelector<HTMLElement>(`.task-card[data-task-id="${id}"]`);
    if (!el) {
      done();
      return;
    }
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      done();
      return;
    }
    const h = el.offsetHeight;
    el.style.transition = 'none';
    el.style.height = `${h}px`;
    el.style.overflow = 'hidden';
    void el.offsetHeight;
    el.style.transition =
      'height var(--dur-base) var(--ease-out), opacity var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out), margin-bottom var(--dur-base) var(--ease-out)';
    el.style.opacity = '0';
    el.style.transform = 'scale(0.96)';
    el.style.height = '0px';
    // Pull back most of the list gap so the collapse doesn't leave a hole.
    el.style.marginBottom = '-2px';
    exitTimerRef.current = window.setTimeout(done, 260);
  }

  // Mirrors latest input text so the voice-session callbacks (created once,
  // below) always read the current value without needing to be recreated.
  const newTaskInputsRef = useRef(newTaskInputs);
  useEffect(() => {
    newTaskInputsRef.current = newTaskInputs;
  }, [newTaskInputs]);

  function submitTask(status: TaskStatus) {
    const title = newTaskInputsRef.current[status].trim();
    if (!title || !projectId) return;
    snapshotCards();
    addTask(projectId, title, status);
    setNewTaskInputs((prev) => ({ ...prev, [status]: '' }));
  }

  function handleInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>, status: TaskStatus) {
    if (e.key === 'Enter') submitTask(status);
  }

  // voiceBaseInputs/voiceDraftInputs are write-mostly bookkeeping used inside
  // the voice session callbacks — never rendered directly — so plain refs
  // (not state) match their original non-reactive role.
  const voiceBaseInputsRef = useRef<StatusRecord<string>>({ todo: '', doing: '', done: '' });
  const voiceDraftInputsRef = useRef<StatusRecord<string>>({ todo: '', doing: '', done: '' });

  const voiceSessionsRef = useRef<StatusRecord<ReturnType<typeof createVoiceInputSession>> | null>(null);
  if (!voiceSessionsRef.current) {
    const makeSession = (status: TaskStatus, label: string) =>
      createVoiceInputSession({
        onStart: () => {
          setListeningStatus((prev) => ({ ...prev, [status]: true }));
          setRefiningStatus((prev) => ({ ...prev, [status]: false }));
          voiceBaseInputsRef.current[status] = newTaskInputsRef.current[status];
          voiceDraftInputsRef.current[status] = '';
          showToast(`Listening for ${label} task...`, 'info');
        },
        onResult: (transcript) => {
          voiceDraftInputsRef.current[status] = transcript;
        },
        onProcessingStart: () => {
          setListeningStatus((prev) => ({ ...prev, [status]: false }));
          setRefiningStatus((prev) => ({ ...prev, [status]: true }));
        },
        onEnd: () => {
          setListeningStatus((prev) => ({ ...prev, [status]: false }));
          setRefiningStatus((prev) => ({ ...prev, [status]: true }));
          void (async () => {
            try {
              const { text: refined } = await refineVoicePrompt(voiceDraftInputsRef.current[status]);
              setNewTaskInputs((prev) => ({
                ...prev,
                [status]: mergeVoiceTranscript(voiceBaseInputsRef.current[status], refined),
              }));
            } catch (e) {
              console.error('Failed to refine voice input:', e);
            } finally {
              setRefiningStatus((prev) => ({ ...prev, [status]: false }));
              voiceBaseInputsRef.current[status] = '';
              voiceDraftInputsRef.current[status] = '';
            }
          })();
        },
        onError: (message) => {
          setListeningStatus((prev) => ({ ...prev, [status]: false }));
          setRefiningStatus((prev) => ({ ...prev, [status]: false }));
          voiceBaseInputsRef.current[status] = '';
          voiceDraftInputsRef.current[status] = '';
          showToast(message, 'error');
        },
      });

    voiceSessionsRef.current = {
      todo: makeSession('todo', 'To Do'),
      doing: makeSession('doing', 'In Progress'),
      done: makeSession('done', 'Done'),
    };
  }

  async function toggleVoiceInput(status: TaskStatus) {
    const sessions = voiceSessionsRef.current!;
    if (refiningStatus[status]) return;
    if (listeningStatus[status]) {
      sessions[status].stop();
      return;
    }
    await sessions[status].start();
  }

  // Load the board when the project changes. It persists in the app config dir,
  // not in the repo — see `$lib/services/project-state`.
  useEffect(() => {
    if (project) void loadProjectTasks(project);
  }, [project]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    function handleGlobalVoiceShortcut(event: KeyboardEvent) {
      if (event.key !== 'Alt' || event.location !== KeyboardEvent.DOM_KEY_LOCATION_LEFT || event.repeat) return;
      const panelEl = panelRef.current;
      const activeElement = document.activeElement;
      if (!panelEl || !activeElement || !panelEl.contains(activeElement)) return;
      event.preventDefault();
      const taskInput = (activeElement as HTMLElement).closest('.kanban-col')?.querySelector('.add-task-input');
      const taskInputIndex = taskInput
        ? Array.from(panelEl.querySelectorAll('.add-task-input')).indexOf(taskInput as HTMLInputElement)
        : -1;
      const preferredStatus = taskInputIndex >= 0 ? columns[taskInputIndex]?.id : null;
      void toggleVoiceInput(preferredStatus ?? 'todo');
    }
    document.addEventListener('keydown', handleGlobalVoiceShortcut);
    return () => document.removeEventListener('keydown', handleGlobalVoiceShortcut);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const panelEl = panelRef.current;
    if (!panelEl) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setIsNarrow(entry.contentRect.width < 520);
      }
    });
    ro.observe(panelEl);
    return () => ro.disconnect();
  }, []);

  // FLIP settle: after a board mutation snapshotCards() captured, animate every
  // still-mounted card from its old seat to its new one. Cards that just
  // mounted (adds, cross-column arrivals) are skipped — their CSS entrance
  // covers them. Runs before paint, so there is never a flash of the final
  // layout.
  useLayoutEffect(() => {
    const prev = prevCardRectsRef.current;
    if (prev.size === 0) return;
    prevCardRectsRef.current = new Map();
    const timers: number[] = [];
    const cards = Array.from(panelRef.current?.querySelectorAll<HTMLElement>('.task-card') ?? []);
    for (const el of cards) {
      const id = el.dataset.taskId;
      if (!id) continue;
      const from = prev.get(id);
      if (!from) continue;
      const to = el.getBoundingClientRect();
      const dx = from.left - to.left;
      const dy = from.top - to.top;
      if (dx === 0 && dy === 0) continue;
      el.style.transition = 'none';
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      void el.offsetHeight;
      el.style.transition = 'transform var(--dur-base) var(--ease-out)';
      el.style.transform = '';
      // Only the card's OWN transition end clears it — a child button's hover
      // transition bubbling up would otherwise snap the card mid-slide.
      const clear = (e?: Event) => {
        if (e && e.target !== el) return;
        el.removeEventListener('transitionend', clear);
        el.style.transition = '';
        el.style.transform = '';
      };
      el.addEventListener('transitionend', clear);
      timers.push(window.setTimeout(clear, 340));
    }
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [projectTasks]);

  // First paint: drop the entrance-suppression class so later mounts animate.
  useLayoutEffect(() => {
    setSuppressEnter(false);
  }, []);

  // Unmount safety: never leave a pending exit timer or a half-collapsed card.
  useEffect(
    () => () => {
      pendingExitRef.current?.();
    },
    [],
  );

  function moveTaskByArrow(taskId: string, currentStatus: TaskStatus, dir: 1 | -1) {
    const idx = statusOrder.indexOf(currentStatus);
    const next = statusOrder[idx + dir];
    if (next) {
      snapshotCards();
      moveTask(taskId, next);
    }
  }

  // ── Drag & drop ────────────────────────────────────────────────────────────
  function onCardDragStart(e: React.DragEvent, task: Task) {
    // Dragging from a button (run / move / edit / delete) would fight the click;
    // start the drag only from the card body.
    if ((e.target as HTMLElement).closest('button')) {
      e.preventDefault();
      return;
    }
    setDragId(task.id);
    e.dataTransfer.setData('text/plain', task.id);
    e.dataTransfer.effectAllowed = 'move';
  }

  function onDragEnd() {
    setDragId(null);
    setDropTarget(null);
    // Long enough to swallow the follow-up click AND the exit-window delay of a
    // cross-column drop (the card still sits in its old column until then);
    // same-column drops keep the original hair-trigger guard.
    justDraggedRef.current = true;
    const delay = longClickGuardRef.current ? 320 : 0;
    longClickGuardRef.current = false;
    window.setTimeout(() => {
      justDraggedRef.current = false;
    }, delay);
  }

  function onCardDragOver(e: React.DragEvent, col: TaskStatus, beforeId: string) {
    e.preventDefault();
    e.stopPropagation();
    setDropTarget({ col, beforeId });
  }

  function onColDragOver(e: React.DragEvent, col: TaskStatus) {
    e.preventDefault();
    setDropTarget({ col, beforeId: null });
  }

  function onColDrop(e: React.DragEvent, col: TaskStatus) {
    e.preventDefault();
    // Flush a superseded exit (a second drop mid-collapse) so its card is never
    // left invisible behind a cancelled timer.
    pendingExitRef.current?.();
    const id = dragId ?? e.dataTransfer.getData('text/plain');
    const beforeId = dropTarget?.col === col ? dropTarget.beforeId : null;
    const task = id ? projectTasks.find((t) => t.id === id) : undefined;
    const movingCol = !!task && task.status !== col;
    setDragId(null);
    setDropTarget(null);
    setRunMenuTaskId(null);
    if (!id) return;

    if (movingCol) {
      // Let the card visibly leave its column before the store commit moves it.
      // `commit` is idempotent: beginCardExit may call it synchronously (reduced
      // motion / element missing) or via its timer, and the flush path may call
      // it again — it must only ever run the move once.
      setExitingId(id);
      snapshotCards();
      let committed = false;
      const commit = () => {
        if (committed) return;
        committed = true;
        if (exitTimerRef.current != null) {
          window.clearTimeout(exitTimerRef.current);
          exitTimerRef.current = null;
        }
        pendingExitRef.current = null;
        setExitingId(null);
        moveTask(id, col, beforeId);
      };
      longClickGuardRef.current = true;
      beginCardExit(id, commit);
      pendingExitRef.current = commit;
      return;
    }

    snapshotCards();
    moveTask(id, col, beforeId);
  }

  // Close the card's agent menu on Escape or any pointer-down outside it. The
  // run button itself is exempt (it toggles on click — a pre-close would
  // reopen it immediately), and so is the menu itself.
  useEffect(() => {
    if (!runMenuTaskId) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setRunMenuTaskId(null);
    }
    function onPointerDown(e: PointerEvent) {
      const target = e.target as Element | null;
      if (!target || target.closest('.run-btn')) return;
      const menu = panelRef.current?.querySelector('.task-run-menu');
      if (menu?.contains(target)) return;
      setRunMenuTaskId(null);
    }
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [runMenuTaskId]);

  // ── Run with agent ─────────────────────────────────────────────────────────
  function runTaskWithAgent(task: Task, command: string) {
    const root = project?.root_path;
    if (!root || !projectId) return;
    // The task is the goal; its notes become the body of the prompt.
    const prompt = task.description?.trim() ? `${task.title}\n\n${task.description}` : task.title;
    void sendChatMessage(projectId, root, prompt, { forcedAgent: command });
    // Spawning work from a task moves it to In Progress, like Orca's
    // task→worktree flow.
    if (task.status !== 'doing') {
      snapshotCards();
      updateTaskStatus(task.id, 'doing');
    }
    setRunMenuTaskId(null);
    setEditingTaskId(null);
  }

  function runClick(e: React.MouseEvent, task: Task) {
    e.stopPropagation();
    if (dispatchableAgents.length === 0) {
      showToast('No agents available to run this task', 'warning', 3500);
      return;
    }
    if (dispatchableAgents.length === 1) {
      runTaskWithAgent(task, dispatchableAgents[0].command);
      return;
    }
    setRunMenuTaskId((cur) => (cur === task.id ? null : task.id));
  }

  return (
    <div className="tasks-panel" ref={panelRef}>
      {!projectId ? (
        <div className="empty-state">
          <svg width="52" height="52" viewBox="0 0 64 64" fill="none" stroke="currentColor" className="animated-svg-floating" style={{ marginBottom: 10 }}>
            <circle cx="32" cy="32" r="28" fill="var(--bg-hover)" stroke="var(--border)" strokeWidth="1" />
            <rect x="22" y="18" width="20" height="28" rx="2" stroke="var(--text-secondary)" strokeWidth="1.5" />
            <circle cx="27" cy="24" r="2" fill="var(--accent)" />
            <line x1="32" y1="24" x2="38" y2="24" stroke="var(--text-secondary)" strokeWidth="1.2" />
            <circle cx="27" cy="32" r="2" fill="var(--text-muted)" />
            <line x1="32" y1="32" x2="38" y2="32" stroke="var(--text-muted)" strokeWidth="1.2" />
            <circle cx="27" cy="40" r="2" fill="var(--text-muted)" />
            <line x1="32" y1="40" x2="36" y2="40" stroke="var(--text-muted)" strokeWidth="1.2" />
            <circle cx="44" cy="22" r="7" fill="rgba(74, 222, 128, 0.15)" stroke="var(--success)" strokeWidth="1.2" />
            <polyline points="41 22 43 24 47 20" fill="none" stroke="var(--success)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <p className="empty-title">No Active Project</p>
          <p className="empty-desc">Open a project folder to track and organize your tasks.</p>
        </div>
      ) : (
        <>
          <div className="panel-meta">
            <div className="meta-left">
              <span className="meta-icon">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="7" height="7" rx="1.5" />
                  <rect x="14" y="3" width="7" height="7" rx="1.5" />
                  <rect x="3" y="14" width="7" height="7" rx="1.5" />
                  <rect x="14" y="14" width="7" height="7" rx="1.5" />
                </svg>
              </span>
              <div className="meta-text">
                <span className="meta-project">{project?.name ?? 'Project'}</span>
                {projectTasks.length > 0 && (
                  <span className="meta-sub">
                    <span className="meta-sub-dot open" />{openCount} open
                    <span className="meta-sub-dot done" />{doneCount} done
                  </span>
                )}
              </div>
            </div>
            <span className="meta-count">{projectTasks.length} {projectTasks.length === 1 ? 'task' : 'tasks'}</span>
          </div>

          <div className={`kanban-board${isNarrow ? ' kanban-board--stacked' : ''}${suppressEnter ? ' no-enter' : ''}`}>
            {columns.map((col) => {
              const colTasks = getColumnTasks(col.id);
              return (
                <div
                  className={`kanban-col${dropTarget?.col === col.id && dragId ? ' drag-over' : ''}`}
                  key={col.id}
                  onDragOver={(e) => onColDragOver(e, col.id)}
                  onDrop={(e) => onColDrop(e, col.id)}
                >
                  <div className="col-header">
                    <span className="col-dot" style={{ background: col.color, boxShadow: `0 0 0 3px ${col.badgeBg}` }}></span>
                    <span className="col-label">{col.label}</span>
                    <span className="col-badge" style={{ background: col.badgeBg, color: col.badgeColor }}>{colTasks.length}</span>
                  </div>

                  <div className="task-list">
                    {colTasks.map((task) => (
                      <div
                        className={`task-card${col.id === 'done' ? ' is-done' : ''}${dragId === task.id ? ' dragging' : ''}${dropTarget?.beforeId === task.id && dragId ? ' drop-before' : ''}`}
                        style={{ borderLeftColor: col.borderColor }}
                        key={task.id}
                        data-task-id={task.id}
                        draggable={exitingId !== task.id}
                        onDragStart={(e) => onCardDragStart(e, task)}
                        onDragEnd={onDragEnd}
                        onDragOver={(e) => onCardDragOver(e, col.id, task.id)}
                        onClick={() => {
                          // A drop can be followed by a click on the source card.
                          if (justDraggedRef.current) return;
                          // And a mid-collapse card isn't clickable yet.
                          if (exitingId === task.id) return;
                          setEditingTaskId(task.id);
                        }}
                      >
                        {col.id === 'done' && (
                          <span className="task-check">
                            <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                          </span>
                        )}
                        <div className="task-main">
                          <span className="task-title">{task.title}</span>
                          {task.description && <span className="task-desc-preview">{task.description}</span>}
                          {(task.priority || task.dueDate != null) && (
                            <div className="task-meta">
                              {task.priority && (
                                <span className={`task-pri pri-${task.priority}`}>
                                  <span className="pri-dot" />
                                  {PRIORITY_LABEL[task.priority]}
                                </span>
                              )}
                              {task.dueDate != null && (
                                <span className={`task-due${isOverdue(task.dueDate) && col.id !== 'done' ? ' overdue' : ''}`}>
                                  <svg className="due-icon" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <rect x="3" y="4" width="18" height="18" rx="2" />
                                    <line x1="16" y1="2" x2="16" y2="6" />
                                    <line x1="8" y1="2" x2="8" y2="6" />
                                    <line x1="3" y1="10" x2="21" y2="10" />
                                  </svg>
                                  {formatDue(task.dueDate)}
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                        <div className="task-actions">
                          <button className="task-btn run-btn" onClick={(e) => runClick(e, task)} title="Run with agent" aria-label="Run with agent">
                            <RocketGlyph />
                          </button>
                          {col.id !== 'todo' && (
                            <button className="task-btn" onClick={(e) => { e.stopPropagation(); moveTaskByArrow(task.id, col.id, -1); }} title="Move back">
                              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="15 18 9 12 15 6"/>
                              </svg>
                            </button>
                          )}
                          {col.id !== 'done' && (
                            <button className="task-btn" onClick={(e) => { e.stopPropagation(); moveTaskByArrow(task.id, col.id, 1); }} title="Move forward">
                              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="9 18 15 12 9 6"/>
                              </svg>
                            </button>
                          )}
                          <button className="task-btn" onClick={(e) => { e.stopPropagation(); setEditingTaskId(task.id); }} title="Edit" aria-label="Edit task">
                            <PencilGlyph />
                          </button>
                          <button className="task-btn delete-btn" onClick={(e) => { e.stopPropagation(); snapshotCards(); deleteTask(task.id); }} title="Delete">
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                            </svg>
                          </button>
                        </div>
                        {runMenuTaskId === task.id && (
                          <div className="task-run-menu" onClick={(e) => e.stopPropagation()}>
                            {dispatchableAgents.map((a) => (
                              <button
                                key={a.command}
                                className="task-run-opt"
                                onClick={() => runTaskWithAgent(task, a.command)}
                              >
                                <AgentBrandMark command={a.command} name={a.name} />
                                <span>{getAgentDisplayName(a.command) ?? a.name ?? a.command}</span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>

                  <div className="add-task-row">
                    {refiningStatus[col.id] && (
                      <div className="refining-label">
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="spin-icon">
                          <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/>
                        </svg>
                        Refining…
                      </div>
                    )}
                    <div className="add-task-input-wrap">
                      <input
                        className="add-task-input"
                        type="text"
                        placeholder="New task…"
                        value={newTaskInputs[col.id]}
                        onChange={(e) => setNewTaskInputs((prev) => ({ ...prev, [col.id]: e.target.value }))}
                        onKeyDown={(e) => handleInputKeyDown(e, col.id)}
                        style={{ '--col-color': col.color } as React.CSSProperties}
                      />
                      <div className="add-task-actions">
                        <button
                          className={`voice-btn${listeningStatus[col.id] ? ' listening' : ''}${refiningStatus[col.id] ? ' refining' : ''}`}
                          onClick={() => toggleVoiceInput(col.id)}
                          title={listeningStatus[col.id] ? 'Stop listening' : refiningStatus[col.id] ? 'Refining with AI…' : 'Voice input'}
                          aria-label="Voice input"
                          disabled={refiningStatus[col.id]}
                        >
                          {refiningStatus[col.id] ? (
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="spin-icon">
                              <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/>
                            </svg>
                          ) : (
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/>
                              <path d="M19 10v1a7 7 0 0 1-14 0v-1"/>
                              <line x1="12" x2="12" y1="19" y2="22"/>
                            </svg>
                          )}
                        </button>
                        <button
                          className="add-btn"
                          onClick={() => submitTask(col.id)}
                          disabled={!newTaskInputs[col.id].trim()}
                          title="Add task"
                          aria-label="Add task"
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                          </svg>
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {editingTask && (
            <TaskEditorModal
              task={editingTask}
              agents={dispatchableAgents}
              onRun={(command) => runTaskWithAgent(editingTask, command)}
              onClose={() => setEditingTaskId(null)}
            />
          )}
        </>
      )}
    </div>
  );
}
