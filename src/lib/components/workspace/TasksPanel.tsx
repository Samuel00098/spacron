import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  tasks,
  openIssuesRequest,
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
import { getAgentDisplayName, setActiveSession } from '$lib/stores/terminal';
import { AgentBrandMark } from '$lib/components/shared/useAgentBrand';
import { createVoiceInputSession, mergeVoiceTranscript } from '$lib/services/voice-input';
import { recordTranscription } from '$lib/stores/voiceHistory';
import { refineVoicePrompt } from '$lib/services/voice-refinement';
import { useStore } from '$lib/react/useStore';
import { useLayoutStore } from '$lib/stores/zustand/layout';
import { quickSpawnAgent } from '$lib/services/quick-spawn';
import { createChatThread, setChatThreadWorktree, sharedWorktreeAt, selectChatThread } from '$lib/stores/chatThreads';
import { showProjectChat } from '$lib/stores/chatNavigation';
import { setInteractionMode } from '$lib/stores/interactionMode';
import TaskEditorModal from './TaskEditorModal';
import './TasksPanel.css';
import './tasks/TasksStyles.css';
import TasksTabHeader, { type TaskPanelTab } from './tasks/TasksTabHeader';
import TasksIssuesList from './tasks/TasksIssuesList';
import TasksLinearIssues from './tasks/TasksLinearIssues';
import TasksIssueDetail from './tasks/TasksIssueDetail';
import TasksPullRequestsList from './tasks/TasksPullRequestsList';
import TasksPullRequestDetail from './tasks/TasksPullRequestDetail';
import TasksActionsList from './tasks/TasksActionsList';
import TasksNewIssueModal from './tasks/TasksNewIssueModal';
import TasksNewPRModal from './tasks/TasksNewPRModal';
import TasksAgentReviewModal from './tasks/TasksAgentReviewModal';
import type { AgentPlacement } from '$lib/stores/agentPlacement';
import type { ChatReasoningEffort } from '$lib/types/chat';
import {
  getRepoInfo,
  listIssues,
  listPullRequests,
  type RemoteRepoInfo,
  type WorkItemIssue,
  type WorkItemPR,
} from '$lib/services/work-items';

type StatusRecord<T> = { todo: T; doing: T; done: T };

const columns: { id: TaskStatus; label: string; color: string; borderColor: string; badgeBg: string; badgeColor: string }[] = [
  { id: 'todo',  label: 'To Do',       color: 'var(--text-muted)',  borderColor: 'rgba(148,148,166,0.4)',  badgeBg: 'rgba(148,148,166,0.1)',  badgeColor: 'var(--text-muted)' },
  { id: 'doing', label: 'In Progress', color: 'var(--warning)',     borderColor: 'rgba(251,191,36,0.45)', badgeBg: 'rgba(251,191,36,0.12)', badgeColor: 'var(--warning)' },
  { id: 'done',  label: 'Done',        color: 'var(--success)',     borderColor: 'rgba(74,222,128,0.45)', badgeBg: 'rgba(74,222,128,0.12)', badgeColor: 'var(--success)' },
];const statusOrder: TaskStatus[] = ['todo', 'doing', 'done'];
// Cursor travel (px) before a card press becomes a drag — below it, the
// gesture is still a click and must not hijack the editor-opening click.
const DRAG_ARM_THRESHOLD_PX = 5;
// Rough tallest-case height of the run menu (its max-height cap plus the
// trigger offset). If less than this fits below the run button inside the
// panel, the menu flips above it instead of clipping against the column.
const RUN_MENU_MAX_PX = 210;

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
  // The run menu opens below its card by default; a card near the column
  // bottom flips it above the run button (see runClick) so nothing clips.
  const [runMenuUp, setRunMenuUp] = useState(false);
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
  // Live gesture record for the active card drag (null when idle). Drags are
  // pointer-based — see the drag & drop section below for why HTML5 DnD is not
  // usable inside Tauri.
  const pointerDragRef = useRef<{
    taskId: string;
    startX: number;
    startY: number;
    armed: boolean;
    detach: () => void;
  } | null>(null);

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

  // Source Control & Multi-Tab State
  const [activeTab, setActiveTab] = useState<TaskPanelTab>('board');
  const [issueProvider, setIssueProvider] = useState<'repo' | 'linear'>('repo');
  const [linearRefresh, setLinearRefresh] = useState(0);
  const showingLinear = activeTab === 'issues' && issueProvider === 'linear';
  const [selectedItem, setSelectedItem] = useState<{ type: 'issue' | 'pr'; number: number } | null>(null);
  const issuesRequest = useStore(openIssuesRequest);
  const [repoInfo, setRepoInfo] = useState<RemoteRepoInfo | null>(null);
  const [issues, setIssues] = useState<WorkItemIssue[]>([]);
  const [prs, setPrs] = useState<WorkItemPR[]>([]);
  const [loadingItems, setLoadingItems] = useState(false);
  const [itemsError, setItemsError] = useState<string | null>(null);
  const [isNewIssueModalOpen, setIsNewIssueModalOpen] = useState(false);
  const [isNewPRModalOpen, setIsNewPRModalOpen] = useState(false);

  useEffect(() => {
    if (!issuesRequest) return;
    setActiveTab('issues');
    setSelectedItem(null);
    openIssuesRequest.set(false);
  }, [issuesRequest]);

  const loadRemoteItems = async () => {
    if (!projectId) return;
    setLoadingItems(true);
    setItemsError(null);
    try {
      const info = await getRepoInfo(projectId);
      setRepoInfo(info);
      const [fetchedIssues, fetchedPRs] = await Promise.all([
        listIssues(projectId, 'all').catch(() => []),
        listPullRequests(projectId, 'all').catch(() => []),
      ]);
      setIssues(fetchedIssues);
      setPrs(fetchedPRs);
    } catch (err) {
      setItemsError(typeof err === 'string' ? err : 'Could not connect to source control');
    } finally {
      setLoadingItems(false);
    }
  };

  useEffect(() => {
    if (projectId) {
      void loadRemoteItems();
    }
  }, [projectId]);

  const [reviewModalState, setReviewModalState] = useState<{
    isOpen: boolean;
    itemType: 'pr' | 'issue';
    itemNumber: number;
    itemTitle: string;
    itemBody: string;
    headBranch?: string;
    baseBranch?: string;
  }>({
    isOpen: false,
    itemType: 'pr',
    itemNumber: 0,
    itemTitle: '',
    itemBody: '',
  });

  const openAgentReviewModal = (
    type: 'issue' | 'pr',
    title: string,
    body: string,
    number: number,
    headBranch?: string,
    baseBranch?: string
  ) => {
    setReviewModalState({
      isOpen: true,
      itemType: type,
      itemNumber: number,
      itemTitle: title,
      itemBody: body,
      headBranch,
      baseBranch,
    });
  };

  const handleLaunchAgentReview = async (config: {
    agentCommand: string;
    agentName: string;
    launchTarget: 'terminal' | 'chat';
    worktreePath: string | null;
    model: string | null;
    reasoningEffort: ChatReasoningEffort;
    prompt: string;
  }) => {
    const root = project?.root_path;
    if (!root || !projectId) return;

    const targetCwd = config.worktreePath || root;
    const finalPrompt = config.prompt.trim();

    // Hide Tasks panel so the stage immediately reveals the agent working
    useLayoutStore.setState({ tasksVisible: false, activeView: 'terminal' });
    if (config.launchTarget === 'chat') {
      setInteractionMode('chat');
    } else {
      setInteractionMode('cli');
      useLayoutStore.getState().showTerminal();
    }

    const sessionId = await quickSpawnAgent(config.agentCommand, {
      model: config.model || undefined,
      reasoningEffort: config.reasoningEffort,
      prompt: finalPrompt,
      view: config.launchTarget,
      worktreePath: targetCwd,
    });

    if (sessionId !== null) {
      setActiveSession(sessionId);
    }

    showToast(
      `Spawned ${config.agentName} in ${config.launchTarget === 'chat' ? 'chat' : 'terminal'} to ${
        reviewModalState.itemType === 'pr'
          ? 'review PR #' + reviewModalState.itemNumber
          : 'work on issue #' + reviewModalState.itemNumber
      }`,
      'success',
      undefined,
      true
    );
  };

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

  // Enter adds the task; Shift+Enter breaks the line. An IME mid-composition
  // owns Enter, so it never submits a half-typed word.
  function handleInputKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>, status: TaskStatus) {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    submitTask(status);
  }

  // The add-task boxes start one line tall and grow with their text up to the
  // CSS max-height, then scroll. Re-measured whenever the text changes (typing,
  // voice, submit clearing it) and whenever a box's width changes, since a
  // narrower column wraps the same text onto more lines.
  const taskInputEls = useRef<Map<TaskStatus, HTMLTextAreaElement>>(new Map());
  function autosizeTaskInput(el: HTMLTextAreaElement) {
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
  }
  useLayoutEffect(() => {
    taskInputEls.current.forEach(autosizeTaskInput);
  }, [newTaskInputs]);
  const taskInputWidths = useRef(new WeakMap<Element, number>());
  const taskInputObserver = useRef<ResizeObserver | null>(null);
  if (!taskInputObserver.current && typeof ResizeObserver !== 'undefined') {
    taskInputObserver.current = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const width = entry.contentRect.width;
        if (taskInputWidths.current.get(entry.target) === width) continue;
        taskInputWidths.current.set(entry.target, width);
        autosizeTaskInput(entry.target as HTMLTextAreaElement);
      }
    });
  }
  useEffect(() => () => taskInputObserver.current?.disconnect(), []);
  function bindTaskInput(status: TaskStatus, el: HTMLTextAreaElement | null) {
    const prev = taskInputEls.current.get(status);
    if (prev === el) return;
    if (prev) taskInputObserver.current?.unobserve(prev);
    if (el) {
      taskInputEls.current.set(status, el);
      taskInputObserver.current?.observe(el);
    } else {
      taskInputEls.current.delete(status);
    }
  }
  // Stable per-column ref callbacks, so React does not detach and re-attach
  // (and re-observe) every box on every render.
  const taskInputRefs = useMemo(
    () =>
      Object.fromEntries(
        columns.map((c) => [c.id, (el: HTMLTextAreaElement | null) => bindTaskInput(c.id, el)]),
      ) as StatusRecord<(el: HTMLTextAreaElement | null) => void>,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

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
        // onTurnComplete, not onEnd: the session now reserves onEnd for "the
        // capture graph is gone" and fires this after EVERY finalized turn —
        // which is what a commit-after-each-utterance consumer needs.
        onTurnComplete: () => {
          setListeningStatus((prev) => ({ ...prev, [status]: false }));
          setRefiningStatus((prev) => ({ ...prev, [status]: true }));
          void (async () => {
            const spoken = voiceDraftInputsRef.current[status];
            try {
              const { text: refined } = await refineVoicePrompt(spoken);
              // Same log the dictation hotkey writes to — Settings → Voice →
              // History. Task dictation is dictation.
              recordTranscription({
                text: refined,
                raw: spoken,
                target: 'task',
                targetLabel: `New ${label} task`,
                refined: refined !== spoken,
              });
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
        ? Array.from(panelEl.querySelectorAll('.add-task-input')).indexOf(taskInput as HTMLTextAreaElement)
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

  // Unmount safety: never leave a pending exit timer, a half-collapsed card,
  // or window listeners from an in-flight drag behind.
  useEffect(
    () => () => {
      pointerDragRef.current?.detach();
      pendingExitRef.current?.();
    },
    [],
  );

  // ── Drag & drop ────────────────────────────────────────────────────────────
  // Pointer-based, because HTML5 drag-and-drop never fires inside Tauri on
  // Windows: the window registers its own OS-level drop handler (for file
  // drops), which disables the WebView's native DnD pipeline entirely. A press
  // on a card body arms a potential drag, moving past the arm threshold starts
  // it, every move hit-tests the board into the same `{col, beforeId}` target
  // shape, and release runs through the same cross-column exit / reorder commit
  // path the old drop handlers used.
  const projectTasksRef = useRef(projectTasks);
  useEffect(() => {
    projectTasksRef.current = projectTasks;
  }, [projectTasks]);

  function hitTestDrop(clientX: number, clientY: number, draggedId: string): { col: TaskStatus; beforeId: string | null } | null {
    const stack = document.elementsFromPoint(clientX, clientY);
    const colEl = stack.find((el): el is HTMLElement => el instanceof HTMLElement && el.classList.contains('kanban-col'));
    if (!colEl) return null;
    const col = statusOrder.find((s) => s === colEl.dataset.colId);
    if (!col) return null;
    let beforeId: string | null = null;
    for (const el of colEl.querySelectorAll<HTMLElement>('.task-card')) {
      const id = el.dataset.taskId;
      if (!id || id === draggedId) continue;
      const r = el.getBoundingClientRect();
      if (clientY < r.top + r.height / 2) {
        beforeId = id;
        break;
      }
    }
    return { col, beforeId };
  }

  function commitDrop(id: string, col: TaskStatus, beforeId: string | null) {
    // Flush a superseded exit (a second drop mid-collapse) so its card is never
    // left invisible behind a cancelled timer.
    pendingExitRef.current?.();
    const task = projectTasksRef.current.find((t) => t.id === id);
    if (!task) return;

    if (task.status !== col) {
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
      beginCardExit(id, commit);
      pendingExitRef.current = commit;
      return;
    }

    snapshotCards();
    moveTask(id, col, beforeId);
  }

  function endPointerDrag(dropAt?: { x: number; y: number }) {
    const drag = pointerDragRef.current;
    if (!drag) return;
    pointerDragRef.current = null;
    drag.detach();

    // Released before the arm threshold: a plain click, which the card's own
    // onClick handles.
    if (!drag.armed) return;

    setDragId(null);
    setDropTarget(null);
    // Long enough to swallow the follow-up click AND the exit-window delay of a
    // cross-column drop (the card still sits in its old column until then).
    justDraggedRef.current = true;
    window.setTimeout(() => {
      justDraggedRef.current = false;
    }, 320);

    if (!dropAt) return; // pointercancel / Escape / released off-board
    const target = hitTestDrop(dropAt.x, dropAt.y, drag.taskId);
    if (!target) return;
    commitDrop(drag.taskId, target.col, target.beforeId);
  }

  function onCardPointerDown(e: React.PointerEvent, task: Task) {
    if (e.button !== 0) return;
    // Presses on buttons / inputs / an open run menu belong to those controls —
    // dragging starts only from the card body. And a card mid-collapse (cross-
    // column exit) must not be grabbable, like the old draggable={false}.
    const target = e.target as HTMLElement;
    if (
      exitingId === task.id ||
      target.closest('button') ||
      target.closest('input') ||
      target.closest('.task-run-menu')
    ) {
      return;
    }
    e.preventDefault();

    const drag: NonNullable<typeof pointerDragRef.current> = {
      taskId: task.id,
      startX: e.clientX,
      startY: e.clientY,
      armed: false,
      detach: () => {},
    };
    pointerDragRef.current = drag;

    const onMove = (ev: PointerEvent) => {
      if (pointerDragRef.current !== drag) return;
      if (!drag.armed) {
        if (Math.hypot(ev.clientX - drag.startX, ev.clientY - drag.startY) < DRAG_ARM_THRESHOLD_PX) return;
        drag.armed = true;
        setDragId(drag.taskId);
        document.body.style.userSelect = 'none';
      }
      ev.preventDefault();
      setDropTarget(hitTestDrop(ev.clientX, ev.clientY, drag.taskId));
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.button !== 0) return;
      endPointerDrag(drag.armed ? { x: ev.clientX, y: ev.clientY } : undefined);
    };
    const onCancel = () => endPointerDrag();
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') endPointerDrag();
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey, true);
    drag.detach = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey, true);
      document.body.style.userSelect = '';
    };
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
    const rect = e.currentTarget.getBoundingClientRect();
    const panelRect = panelRef.current?.getBoundingClientRect();
    setRunMenuUp(!!panelRect && panelRect.bottom - rect.bottom < RUN_MENU_MAX_PX);
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
          <TasksTabHeader
            activeTab={activeTab}
            onTabChange={(tab) => {
              setActiveTab(tab);
              setSelectedItem(null);
            }}
            issuesCount={issueProvider === 'repo' ? issues.filter((i) => i.state === 'open').length : 0}
            issueProvider={issueProvider}
            onIssueProviderChange={(provider) => {
              setSelectedItem(null);
              setIssueProvider(provider);
            }}
            prsCount={prs.filter((p) => p.state === 'open').length}
            repoInfo={repoInfo}
            onRefresh={showingLinear ? () => setLinearRefresh((value) => value + 1) : loadRemoteItems}
            onOpenNewIssue={() => setIsNewIssueModalOpen(true)}
            onOpenNewPR={() => setIsNewPRModalOpen(true)}
          />

          {showingLinear ? (
            <TasksLinearIssues projectId={projectId} refresh={linearRefresh} />
          ) : selectedItem?.type === 'issue' ? (
            <TasksIssueDetail
              projectId={projectId}
              issueNumber={selectedItem.number}
              onBack={() => setSelectedItem(null)}
              onAssignToAgent={(t, b, n) => openAgentReviewModal('issue', t, b, n)}
            />
          ) : selectedItem?.type === 'pr' ? (
            <TasksPullRequestDetail
              projectId={projectId}
              prNumber={selectedItem.number}
              onBack={() => setSelectedItem(null)}
              onAssignToAgent={(t, b, n, hb, bb) => openAgentReviewModal('pr', t, b, n, hb, bb)}
            />
          ) : activeTab === 'issues' ? (
            <TasksIssuesList
              issues={issues}
              loading={loadingItems}
              error={itemsError}
              onSelectIssue={(issue) => setSelectedItem({ type: 'issue', number: issue.number })}
              onAssignToAgent={(t, b, n) => openAgentReviewModal('issue', t, b, n)}
            />
          ) : activeTab === 'prs' ? (
            <TasksPullRequestsList
              pullRequests={prs}
              loading={loadingItems}
              error={itemsError}
              onSelectPR={(pr) => setSelectedItem({ type: 'pr', number: pr.number })}
              onAssignToAgent={(t, b, n, hb, bb) => openAgentReviewModal('pr', t, b, n, hb, bb)}
            />
          ) : activeTab === 'actions' ? (
            <TasksActionsList projectId={projectId} />
          ) : (
            <>
              <div className="panel-meta">
            <div className="meta-left">
              <span className="meta-icon">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
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
                  data-col-id={col.id}
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
                        onPointerDown={(e) => onCardPointerDown(e, task)}
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
                          <div
                            className={`task-run-menu${runMenuUp ? ' run-up' : ''}`}
                            onClick={(e) => e.stopPropagation()}
                          >
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
                      <textarea
                        ref={taskInputRefs[col.id]}
                        className="add-task-input"
                        rows={1}
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
        </>
      )}

      {isNewIssueModalOpen && (
        <TasksNewIssueModal
          projectId={projectId}
          onClose={() => setIsNewIssueModalOpen(false)}
          onCreated={(newIssue) => {
            setIssues((prev) => [newIssue, ...prev]);
            setSelectedItem({ type: 'issue', number: newIssue.number });
          }}
        />
      )}

      {isNewPRModalOpen && (
        <TasksNewPRModal
          projectId={projectId}
          defaultBranch={repoInfo?.defaultBranch || 'main'}
          currentBranch={repoInfo?.currentBranch || ''}
          onClose={() => setIsNewPRModalOpen(false)}
          onCreated={loadRemoteItems}
        />
      )}

      {editingTask && (
        <TaskEditorModal
          task={editingTask}
          agents={dispatchableAgents}
          onRun={(command) => runTaskWithAgent(editingTask, command)}
          onClose={() => setEditingTaskId(null)}
        />
      )}

      <TasksAgentReviewModal
        isOpen={reviewModalState.isOpen}
        onClose={() => setReviewModalState((prev) => ({ ...prev, isOpen: false }))}
        itemType={reviewModalState.itemType}
        itemNumber={reviewModalState.itemNumber}
        itemTitle={reviewModalState.itemTitle}
        itemBody={reviewModalState.itemBody}
        headBranch={reviewModalState.headBranch}
        baseBranch={reviewModalState.baseBranch}
        projectId={projectId}
        projectRoot={project?.root_path}
        onLaunch={handleLaunchAgentReview}
      />
    </>
  )}
</div>
  );
}
