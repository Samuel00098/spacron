/**
 * The rest of the chat chrome the live structured view needed: per-pane chat
 * tabs, the background-task strip, the agent's own mode chip and a sign-in
 * card. They live here so `TerminalChatView` only mounts them; each one reads
 * the structured stores directly and renders nothing when it has nothing to
 * say.
 */
import { useEffect, useMemo, useReducer, useState } from 'react';
import { useStore } from '$lib/react/useStore';
import type { StructuredChatAgent } from '$lib/services/structured-chat/panes';
import type { StructuredSubagentSession } from '$lib/services/structured-chat/provider';
import {
  cancelStructuredSubagent,
  getStructuredChat,
  getStructuredSubagents,
  interruptStructuredChat,
  subscribeStructuredChat,
  subscribeStructuredSubagents,
} from '$lib/services/structured-chat/registry';
import {
  archiveStructuredRecord,
  clearStructuredConversation,
  resumeStructuredSessionInPane,
  structuredSessions,
  useStructuredSessionRecord,
} from '$lib/services/structured-chat/session-store';

function useStructuredState(agent: StructuredChatAgent | null, sessionId: number) {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => subscribeStructuredChat(agent, bump), [agent]);
  return getStructuredChat(agent, sessionId);
}

/**
 * This pane's conversation tabs: the chat it is showing plus the other open
 * chats of the same agent and project. Switching detaches the current one
 * (it keeps its journal and comes back with a click), never closes it.
 */
export function ChatTabStrip({ sessionId }: { sessionId: number }) {
  const current = useStructuredSessionRecord(sessionId);
  const all = useStore(structuredSessions);
  const tabs = useMemo(() => Object.values(all)
    .filter((record) => !record.archived && record.view === 'chat' && record.provider === current?.provider && record.projectId === current?.projectId
      // A record that is ready, working or starting is open in some pane:
      // resuming it here would be refused, so it is not offered as a tab.
      && (record.id === current?.id || !['ready', 'working', 'starting'].includes(record.lifecycle)))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 8), [all, current?.id, current?.provider, current?.projectId]);
  if (!current || tabs.length < 2) return null;
  return (
    <div className="structured-chat-tabs" role="tablist" aria-label="Chat tabs">
      {tabs.map((tab) => {
        const active = tab.id === current.id;
        return (
          <span key={tab.id} className={`structured-chat-tab${active ? ' active' : ''}`}>
            <button
              type="button"
              role="tab"
              aria-selected={active}
              title={tab.title ?? 'Untitled chat'}
              onClick={() => { if (!active) void resumeStructuredSessionInPane(sessionId, tab.id); }}
            >
              {tab.title ?? 'Untitled chat'}
            </button>
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
        title="Start a new conversation in this tab"
        aria-label="New chat"
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
 * Running work behind the turn: spawned children and the tool calls still in
 * flight. A child stops on its own; a tool row cannot be stopped alone by any
 * of these protocols, so its button stops the turn and says so.
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
  const runningTools = (state?.items ?? []).filter((item) => item.kind === 'tool' && item.toolStatus === 'running');
  if (!runningChildren.length && !runningTools.length) return null;
  return (
    <div className="structured-chat-tasks" role="region" aria-label="Background tasks">
      <span className="structured-chat-tasks-label">Background</span>
      {runningChildren.map((child) => (
        <span key={child.id} className={`structured-chat-task status-${child.status}`}>
          <span className="structured-chat-task-name">{child.agent}</span>
          <span className="structured-chat-task-detail">{child.assignment}</span>
          <button
            type="button"
            className="structured-chat-task-stop"
            title="Stop this task"
            onClick={() => { if (agent) void cancelStructuredSubagent(agent, sessionId, child.id); }}
          >
            Stop
          </button>
        </span>
      ))}
      {runningTools.length > 0 && (
        <span className="structured-chat-task">
          <span className="structured-chat-task-name">
            {runningTools.length === 1 ? runningTools[0].toolName ?? 'tool' : `${runningTools.length} tool calls`}
          </span>
          <span className="structured-chat-task-detail">running in this turn</span>
          <button
            type="button"
            className="structured-chat-task-stop"
            title="These protocols have no per-tool stop, so this stops the turn"
            onClick={() => { if (agent) void interruptStructuredChat(agent, sessionId); }}
          >
            Stop turn
          </button>
        </span>
      )}
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
