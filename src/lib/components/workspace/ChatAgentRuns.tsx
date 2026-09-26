import { useEffect, useRef, useState } from 'react';
import type { OrchestratorTask } from '$lib/services/orchestrator/task-lifecycle';
import type { ChatMessage } from '$lib/types/chat';
import { readAgentScreen } from '$lib/services/terminal-screen';
import { getAgentDisplayName, getSessionOutputProduced, setActiveSession } from '$lib/stores/terminal';
import { showTerminal } from '$lib/stores/layout';
import { requestStageExpansion } from '$lib/stores/layoutControl';
import { setInteractionMode } from '$lib/stores/interactionMode';
import { AgentBrandMark } from '$lib/components/shared/useAgentBrand.tsx';

/**
 * One box per agent the orchestrator dispatched from a chat turn: who it is,
 * whether it is working, waiting on you, finished or failed, its live process
 * (minimised by default), its report once it ends, and — when it asks
 * something — a reply box that answers THAT agent only. Works the same for
 * one agent or six; each card tracks its own task.
 */

type RunState = 'starting' | 'working' | 'needs-input' | 'finished' | 'failed';

function runState(task: OrchestratorTask): RunState {
  switch (task.status) {
    case 'blocked': return 'needs-input';
    case 'complete': return 'finished';
    case 'failed':
    case 'cancelled': return 'failed';
    case 'in-progress': {
      if (!task.promptSentAt) return 'starting';
      // A chat session stays leased after it answers, ready for the next
      // message; its "finished" activity is what says this turn is over.
      const last = task.activity?.at(-1);
      if (last?.kind === 'finished' && last.ts >= task.promptSentAt) return 'finished';
      return 'working';
    }
    default: return 'starting';
  }
}

const STATE_LABEL: Record<RunState, string> = {
  starting: 'Starting',
  working: 'Working',
  'needs-input': 'Needs input',
  finished: 'Finished',
  failed: 'Failed',
};

const PROCESS_LINES = 60;

/** The agent's own report for this task: the newest completion card's text. */
function latestReport(taskId: string, messages: ChatMessage[], since: number): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].ts < since) break;
    const completion = messages[index].completion;
    // A blocked card's text is the question, which the request box shows.
    if (completion?.taskId !== taskId || completion.status === 'blocked') continue;
    const text = (completion.summary || completion.reason || '').trim();
    if (text) return text;
  }
  return null;
}

function tailLines(text: string, count: number): string {
  const lines = text.split('\n');
  return lines.slice(-count).join('\n').trim();
}

/**
 * The agent's rendered pane, cleaned of its CLI's chrome. Re-read only when
 * the session has produced output since the last read, and not at all once
 * the task is over and the box is closed — an idle agent costs nothing.
 */
function useAgentProcess(task: OrchestratorTask, open: boolean): string {
  const sessionId = task.assignedSessionId ?? task.lastSessionId ?? null;
  const active = task.status === 'in-progress' || task.status === 'blocked';
  const [text, setText] = useState(() => readProcess(task));
  const producedRef = useRef(-1);

  useEffect(() => {
    producedRef.current = -1;
    setText(readProcess(task));
    if (sessionId == null || (!active && !open)) return;
    const tick = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      const produced = getSessionOutputProduced(sessionId);
      if (produced === producedRef.current) return;
      producedRef.current = produced;
      setText(readProcess(task));
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
    // `task` is read fresh through readProcess; the effect keys on what
    // changes whether it should poll at all.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, active, open, task.status]);

  return text;
}

function readProcess(task: OrchestratorTask): string {
  const sessionId = task.assignedSessionId ?? task.lastSessionId ?? null;
  const screen = sessionId != null ? readAgentScreen(sessionId, { maxLines: 200 }) : null;
  return tailLines(screen ?? task.transcript ?? '', PROCESS_LINES);
}

function AgentRunCard({
  task,
  messages,
  onAnswer,
}: {
  task: OrchestratorTask;
  messages: ChatMessage[];
  onAnswer: (taskId: string, text: string) => Promise<void>;
}) {
  const state = runState(task);
  const [collapsed, setCollapsed] = useState(false);
  const [processOpen, setProcessOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const process = useAgentProcess(task, processOpen && !collapsed);

  const agentType = task.agentPreset ? getAgentDisplayName(task.agentPreset) ?? task.agentPreset : 'Agent';
  const name = task.name?.trim() || agentType;
  // Only this turn's report: a card from an earlier prompt is old news.
  const report = latestReport(task.id, messages, task.promptSentAt ?? 0);
  const ended = state === 'finished' || state === 'failed';
  const lastLine = process.split('\n').filter((line) => line.trim()).at(-1)?.trim() ?? '';
  const sessionId = task.assignedSessionId ?? task.lastSessionId ?? null;
  // What goes on the report block when the agent never filed one itself:
  // the end of what it printed, which is its answer for a CLI that just replies.
  const reportText = ended ? report ?? tailLines(process, 14) : '';
  const question = task.blockedReason?.trim() || `${name} is waiting for your input.`;

  async function send() {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await onAnswer(task.id, text);
      setDraft('');
    } finally {
      setSending(false);
    }
  }

  function openTerminal() {
    if (sessionId == null) return;
    setInteractionMode('cli');
    setActiveSession(sessionId);
    showTerminal();
    requestStageExpansion(`agent:${sessionId}`);
  }

  return (
    <div className={`chat-agent-run ${state}${collapsed ? ' collapsed' : ''}`}>
      <div className="chat-agent-run-head">
        <button
          type="button"
          className="chat-agent-run-toggle"
          onClick={() => setCollapsed((value) => !value)}
          aria-expanded={!collapsed}
          title={collapsed ? 'Show this agent' : 'Minimise this agent'}
        >
          <span className="chat-agent-run-mark">
            <AgentBrandMark command={task.agentPreset} name={name} />
          </span>
          <span className="chat-agent-run-name">{name}</span>
          {name !== agentType && <span className="chat-agent-run-type">{agentType}</span>}
          <span className={`chat-agent-run-state ${state}`}>{STATE_LABEL[state]}</span>
          {collapsed && lastLine && state === 'working' && (
            <span className="chat-agent-run-peek">{lastLine}</span>
          )}
        </button>
        {sessionId != null && (
          <button type="button" className="chat-agent-run-action" onClick={openTerminal} title="Open this agent's terminal in Code mode">
            Terminal
          </button>
        )}
      </div>

      {!collapsed && (
        <div className="chat-agent-run-body">
          <div className="chat-agent-run-task" title={task.goal}>{task.title}</div>

          {state === 'needs-input' && (
            <div className="chat-agent-run-request" role="group" aria-label={`${name} has a request`}>
              <strong>{name} has a request</strong>
              <p>{question}</p>
              <div className="chat-agent-run-reply">
                <textarea
                  value={draft}
                  rows={1}
                  placeholder={`Answer ${name}…`}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      void send();
                    }
                  }}
                  aria-label={`Answer ${name}`}
                />
                <button type="button" className="primary" onClick={() => void send()} disabled={!draft.trim() || sending}>
                  {sending ? 'Sending…' : 'Send'}
                </button>
              </div>
            </div>
          )}

          {reportText && (
            <div className={`chat-agent-run-report ${state}`}>
              <span>{report ? 'Report' : 'Last output'}</span>
              <p>{reportText}</p>
            </div>
          )}

          <details
            className="chat-agent-run-process"
            open={processOpen}
            onToggle={(event) => setProcessOpen((event.currentTarget as HTMLDetailsElement).open)}
          >
            <summary>
              <span>Process</span>
              {!processOpen && lastLine && <span className="chat-agent-run-peek">{lastLine}</span>}
            </summary>
            <pre>{process || 'No output yet.'}</pre>
          </details>
        </div>
      )}
    </div>
  );
}

export default function ChatAgentRuns({
  tasks,
  messages,
  onAnswer,
}: {
  tasks: OrchestratorTask[];
  messages: ChatMessage[];
  onAnswer: (taskId: string, text: string) => Promise<void>;
}) {
  if (!tasks.length) return null;
  const counts = tasks.reduce<Record<RunState, number>>((acc, task) => {
    acc[runState(task)] += 1;
    return acc;
  }, { starting: 0, working: 0, 'needs-input': 0, finished: 0, failed: 0 });
  const summary = (Object.keys(counts) as RunState[])
    .filter((key) => counts[key])
    .map((key) => `${counts[key]} ${STATE_LABEL[key].toLowerCase()}`)
    .join(' · ');

  return (
    <div className="chat-agent-runs" aria-label="Agents on this request">
      <div className="chat-agent-runs-head">
        <span>{tasks.length === 1 ? '1 agent' : `${tasks.length} agents`}</span>
        <span>{summary}</span>
      </div>
      {tasks.map((task) => (
        <AgentRunCard key={task.id} task={task} messages={messages} onAnswer={onAnswer} />
      ))}
    </div>
  );
}
