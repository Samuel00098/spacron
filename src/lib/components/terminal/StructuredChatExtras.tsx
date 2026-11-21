/**
 * The rest of the chat chrome the live structured view needed: per-pane chat
 * tabs, the background-task panel, the goal mirror, the agent's own mode chip,
 * answered-card receipts and a sign-in card. They live here so
 * `TerminalChatView` only mounts them; each reads the structured stores
 * directly and renders nothing when it has nothing to say.
 */
import { useEffect, useMemo, useReducer, useState } from 'react';
import { useStore } from '$lib/react/useStore';
import { useStructuredChatUnread, type StructuredChatAgent } from '$lib/services/structured-chat/panes';
import type { StructuredSubagentSession } from '$lib/services/structured-chat/provider';
import { groupRunningTools } from '$lib/services/structured-chat/running-tools';
import {
  cancelStructuredSubagent,
  getStructuredChat,
  getStructuredSubagents,
  interruptStructuredChat,
  subscribeStructuredChat,
  subscribeStructuredSubagents,
} from '$lib/services/structured-chat/registry';
import {
  approvalReceipts,
  recordHasConversation,
  archiveStructuredRecord,
  clearStructuredConversation,
  resumeStructuredSessionInPane,
  structuredSessions,
  subscribeStructuredEvents,
  useStructuredSessionRecord,
  type ApprovalReceipt,
} from '$lib/services/structured-chat/session-store';

function useStructuredState(agent: StructuredChatAgent | null, sessionId: number) {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => subscribeStructuredChat(agent, bump), [agent]);
  return getStructuredChat(agent, sessionId);
}

/**
 * This pane's conversation tabs: the chat it is showing plus the other
 * resumable chats of the same agent and project. Switching detaches the current
 * one (it keeps its journal and comes back with a click), never closes it.
 */
export function ChatTabStrip({ sessionId }: { sessionId: number }) {
  const current = useStructuredSessionRecord(sessionId);
  const unread = useStructuredChatUnread(sessionId);
  const all = useStore(structuredSessions);
  const tabs = useMemo(() => Object.values(all)
    .filter((record) => !record.archived && record.view === 'chat' && record.provider === current?.provider && record.projectId === current?.projectId
      // Ready, working or starting means the record is open in some pane:
      // resuming it here would be refused, so it is not offered as a tab.
      && (record.id === current?.id || (!['ready', 'working', 'starting'].includes(record.lifecycle) && recordHasConversation(record))))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 8), [all, current?.id, current?.provider, current?.projectId]);
  if (!current || tabs.length < 2) return null;
  return (
    <div className="structured-chat-tabs" role="tablist" aria-label="Chat tabs">
      {tabs.map((tab) => {
        const active = tab.id === current.id;
        return (
          <span key={tab.id} className={`structured-chat-tab${active ? ' active' : ''}${active && unread ? ' unread' : ''}`}>
            <button
              type="button"
              role="tab"
              aria-selected={active}
              title={tab.title ?? 'Untitled chat'}
              onClick={() => { if (!active) void resumeStructuredSessionInPane(sessionId, tab.id); }}
            >
              {tab.title ?? 'Untitled chat'}
            </button>
            {active && unread && <span className="structured-chat-tab-dot" aria-label="Finished while you were away" />}
            {!active && (
              <button
                type="button"
                className="structured-chat-tab-close"
                aria-label={`Archive ${tab.title ?? 'chat'}`}
                title="Archive this chat"
                onClick={() => archiveStructuredRecord(tab.id)}
              >
                ×
              </button>
            )}
          </span>
        );
      })}
      <button
        type="button"
        className="structured-chat-tab-new"
        title="Start a new conversation in this chat"
        aria-label="New chat in this chat"
        onClick={() => void clearStructuredConversation(sessionId)}
      >
        +
      </button>
    </div>
  );
}

/**
 * The agent's own mode, when it advertises one and is in its plan mode. Other
 * ACP modes (OpenCode's build, Cursor's agent) are personas, not a state the
 * user set here, so they are not shown as a chip.
 */
export function AgentModeChip({ mode }: { mode: string | null | undefined }) {
  if (!mode || !/plan/i.test(mode)) return null;
  return (
    <span className="terminal-chat-pill structured-chat-mode" title="The agent is working in its own plan mode">
      Plan
    </span>
  );
}

/**
 * The objective this chat last sent the agent through `/goal`. The agent owns
 * the goal: Pause, Resume and Clear send `/goal …` to it and update the mirror,
 * so the buttons never claim a change the agent did not receive.
 */
export function GoalPanel({ sessionId, onCommand }: { sessionId: number; onCommand: (command: string) => void }) {
  const record = useStructuredSessionRecord(sessionId);
  const goal = record?.goal;
  if (!goal) return null;
  return (
    <div className="structured-chat-goal" role="region" aria-label="Goal">
      <span className={`structured-chat-goal-dot ${goal.state}`} aria-hidden="true" />
      <span className="structured-chat-goal-label">Goal</span>
      <span className="structured-chat-goal-text" title={goal.text}>{goal.text}</span>
      <span className="structured-chat-goal-state">{goal.state}</span>
      <button
        type="button"
        className="tcr-link-btn"
        onClick={() => onCommand(`/goal ${goal.state === 'paused' ? 'resume' : 'pause'}`)}
      >
        {goal.state === 'paused' ? 'Resume' : 'Pause'}
      </button>
      <button type="button" className="tcr-link-btn" onClick={() => onCommand('/goal clear')}>Clear</button>
    </div>
  );
}

/** "1m 5s", from a start time; only ever shown for a task that is running. */
function elapsedSince(from: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - from) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function useTicker(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [on]);
  return now;
}

/**
 * Running work behind the turn: spawned children (stoppable on their own) and
 * the tool calls still in flight. None of these protocols can stop one tool by
 * itself, so that row's button says **Stop turn** and ends the turn.
 */
export function BackgroundTaskStrip({ sessionId, agent }: { sessionId: number; agent: StructuredChatAgent | null }) {
  const state = useStructuredState(agent, sessionId);
  const [children, setChildren] = useState<StructuredSubagentSession[]>([]);
  useEffect(() => {
    if (!agent) return undefined;
    setChildren(getStructuredSubagents(agent, sessionId));
    return subscribeStructuredSubagents(sessionId, () => setChildren(getStructuredSubagents(agent, sessionId)));
  }, [agent, sessionId]);

  const runningChildren = children.filter((child) => ['starting', 'running', 'needs-input'].includes(child.status));
  const toolGroups = useMemo(() => groupRunningTools(state?.items ?? []), [state?.items]);
  const now = useTicker(runningChildren.length > 0);
  if (!runningChildren.length && !toolGroups.length) return null;
  return (
    <div className="structured-chat-tasks" role="region" aria-label="Background tasks">
      <span className="structured-chat-tasks-label">
        Background · {runningChildren.length + toolGroups.length}
      </span>
      {runningChildren.map((child) => (
        <span key={child.id} className={`structured-chat-task status-${child.status} has-stop`}>
          <span className={`structured-chat-task-dot status-${child.status}`} aria-hidden="true" />
          <span className="structured-chat-task-name">{child.agent}</span>
          <span className="structured-chat-task-detail" title={child.assignment}>{child.assignment}</span>
          <span className="structured-chat-task-time">{elapsedSince(child.startedAt, now)}</span>
          <button
            type="button"
            className="structured-chat-task-stop"
            title={`Stop this ${child.agent} task`}
            onClick={() => { if (agent) void cancelStructuredSubagent(agent, sessionId, child.id); }}
          >
            Stop
          </button>
        </span>
      ))}
      {toolGroups.map((group, index) => {
        const hasStop = index === 0;
        return (
          <span key={group.kind} className={`structured-chat-task status-running ${hasStop ? 'has-stop' : 'no-stop'}`}>
            <span className="structured-chat-task-dot status-running" aria-hidden="true" />
            <span className="structured-chat-task-name">
              {group.label}{group.rows.length > 1 ? ` · ${group.rows.length}` : ''}
            </span>
            <span
              className="structured-chat-task-detail"
              title={group.rows.map((row) => `${row.name}${row.detail ? `: ${row.detail}` : ''}`).join('\n')}
            >
              {group.rows.slice(0, 2).map((row) => row.detail || row.name).join(' · ')}
              {group.rows.length > 2 ? '…' : ''}
              {group.rows.some((row) => row.detached) ? ' (detached)' : ''}
            </span>
            {hasStop && (
              <button
                type="button"
                className="structured-chat-task-stop"
                title="These protocols have no per-tool stop, so this stops the turn"
                onClick={() => { if (agent) void interruptStructuredChat(agent, sessionId); }}
              >
                Stop turn
              </button>
            )}
          </span>
        );
      })}
    </div>
  );
}

function receiptAnswer(receipt: ApprovalReceipt): string {
  if (receipt.optionLabel) return `Chose “${receipt.optionLabel}”`;
  if (receipt.optionId) return `Chose ${receipt.optionId}`;
  if (receipt.decision === 'accept') return 'Allowed once';
  if (receipt.decision === 'acceptForSession') return 'Allowed for this chat';
  if (receipt.decision === 'decline') return 'Declined';
  return 'Answered';
}

/**
 * Answered approval and question cards, as receipts. Built from the journal's
 * paired request/resolve events, so the answer that was actually sent stays in
 * the transcript after a reload instead of the card just disappearing.
 */
export function AnswerReceipts({ sessionId }: { sessionId: number }) {
  const current = useStructuredSessionRecord(sessionId);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => subscribeStructuredEvents((paneId, event) => {
    if (paneId === sessionId && event.type === 'approval.resolved') bump();
  }), [sessionId]);
  const receipts = current ? approvalReceipts(current.id) : [];
  if (!receipts.length) return null;
  return (
    <div className="structured-chat-receipts" aria-label="Answered requests">
      {receipts.map((receipt) => (
        <div key={`${receipt.requestId}-${receipt.at}`} className="structured-chat-receipt">
          <span className="structured-chat-receipt-answer">{receiptAnswer(receipt)}</span>
          <span className="structured-chat-receipt-title" title={receipt.title}>{receipt.title}</span>
        </div>
      ))}
    </div>
  );
}

/** Does this start failure look like the CLI needs its own sign-in first? */
export function looksLikeAuthError(message: string): boolean {
  return /\bauth|sign.?in|log.?in|credential|unauthor|forbidden|401|api.?key/i.test(message);
}

/**
 * The agent could not start because it wants a sign-in Spacron cannot perform
 * for it — the CLI owns that flow, so the card says where and offers a retry.
 */
export function SignInNotice({ label, onRetry, onOpenTerminal }: {
  label: string;
  onRetry: () => void;
  onOpenTerminal: () => void;
}) {
  return (
    <div className="tcr-command-notice structured-chat-signin" role="alert">
      <span>
        <strong>{label} needs a sign-in.</strong> Finish it in {label}&apos;s own CLI (or its browser window), then retry this chat.
      </span>
      <button type="button" className="tcr-link-btn" onClick={onRetry}>Retry</button>
      <button type="button" className="tcr-link-btn" onClick={onOpenTerminal}>Open terminal</button>
    </div>
  );
}
