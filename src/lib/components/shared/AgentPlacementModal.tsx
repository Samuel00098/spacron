import { useEffect, useRef, useState, type ReactElement } from 'react';
import { useStore } from '$lib/react/useStore';
import {
  agentPlacementRequest,
  resolveAgentPlacement,
  type AgentPlacement,
} from '$lib/stores/agentPlacement';

import './AgentPlacementModal.css';

function WorktreeIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="6" cy="6" r="3" />
      <circle cx="18" cy="18" r="3" />
      <path d="M6 9v6a3 3 0 0 0 3 3h6" />
    </svg>
  );
}

function MainRepoIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

const OPTIONS: Array<{
  value: AgentPlacement;
  label: string;
  short: string;
  detail: string;
  icon: () => ReactElement;
}> = [
  {
    value: 'worktree',
    label: 'Isolated worktree',
    short: 'Isolated',
    detail:
      'Its own branch off HEAD, in a separate folder. Safe for parallel agents — but its edits will not show up in your main checkout until you merge them.',
    icon: WorktreeIcon,
  },
  {
    value: 'main',
    label: 'Main repo',
    short: 'Main repo',
    detail:
      'Runs directly in the project root on your current branch. You see every edit immediately, and git tag / push work — but concurrent agents can collide.',
    icon: MainRepoIcon,
  },
];

/**
 * Blocking "where should this run?" step shown before ANY agent is spawned —
 * from the spawn modal and from an orchestrator dispatch alike.
 *
 * Placement is per agent, not per batch: spawning three agents can mean one in
 * the main repo and two isolated. One agent gets the roomy two-card layout that
 * explains the trade-off; several get a compact row each, plus "set all"
 * shortcuts for the common case where they all go the same way.
 *
 * See `$lib/stores/agentPlacement` for why this is a dialog and not a setting.
 */
export default function AgentPlacementModal() {
  const request = useStore(agentPlacementRequest);
  const [choices, setChoices] = useState<AgentPlacement[]>([]);
  const cardRef = useRef<HTMLDivElement | null>(null);

  // Reseed (and refocus) whenever a new request reaches the head of the queue.
  useEffect(() => {
    if (!request) return;
    setChoices(request.agents.map(() => request.suggested));
    cardRef.current?.focus();
  }, [request?.id]);

  if (!request) return null;

  // The seeding effect runs a tick after the request lands, so fall back to the
  // suggestion rather than rendering a row with no selection.
  const placements = request.agents.map((_agent, i) => choices[i] ?? request.suggested);
  const isMulti = request.agents.length > 1;

  const confirm = () => resolveAgentPlacement(request.id, placements);
  const cancel = () => resolveAgentPlacement(request.id, null);

  const setAt = (index: number, value: AgentPlacement) =>
    setChoices(placements.map((current, i) => (i === index ? value : current)));
  const setAll = (value: AgentPlacement) => setChoices(placements.map(() => value));

  const isolatedCount = placements.filter((p) => p === 'worktree').length;
  const mainCount = placements.length - isolatedCount;

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      confirm();
    } else if (!isMulti && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      // Only meaningful for the single-agent card layout; with several agents
      // the arrows belong to whichever row has focus.
      e.preventDefault();
      setAll(placements[0] === 'worktree' ? 'main' : 'worktree');
    }
  }

  function confirmLabel() {
    if (!isMulti) return placements[0] === 'main' ? 'Start in main repo' : 'Start in worktree';
    if (!mainCount) return `Start ${placements.length} isolated`;
    if (!isolatedCount) return `Start ${placements.length} in main repo`;
    return `Start ${placements.length} agents`;
  }

  return (
    <div
      className="apm-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Choose where the agent runs"
      onClick={(e) => {
        if (e.target === e.currentTarget) cancel();
      }}
    >
      <div className="apm-card" ref={cardRef} tabIndex={-1} onKeyDown={handleKeyDown}>
        <header className="apm-header">
          <span className="apm-badge" aria-hidden="true">
            <WorktreeIcon />
          </span>
          <div className="apm-header-text">
            <span className="apm-title">
              {isMulti ? 'Where should each agent run?' : 'Where should this agent run?'}
            </span>
            <span className="apm-subtitle">
              {isMulti
                ? `${request.agents.length} agents · ${request.source === 'orchestrator' ? 'requested by the orchestrator' : 'set each one independently'}`
                : `${request.agents[0] ?? 'Agent'} · ${request.source === 'orchestrator' ? 'requested by the orchestrator' : 'starting now'}`}
            </span>
          </div>
        </header>

        {isMulti ? (
          <>
            <div className="apm-setall">
              <span className="apm-setall-label">Set all</span>
              {OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className="apm-setall-btn"
                  onClick={() => setAll(option.value)}
                >
                  {option.short}
                </button>
              ))}
            </div>

            <ul className="apm-agent-list">
              {request.agents.map((agent, index) => (
                <li className="apm-agent-row" key={`${agent}-${index}`}>
                  <span className="apm-agent-icon" aria-hidden="true">
                    {placements[index] === 'main' ? <MainRepoIcon /> : <WorktreeIcon />}
                  </span>
                  <span className="apm-agent-name" title={agent}>
                    {agent}
                  </span>
                  <span
                    className="apm-segmented"
                    role="radiogroup"
                    aria-label={`Where ${agent} runs`}
                  >
                    {OPTIONS.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        role="radio"
                        aria-checked={placements[index] === option.value}
                        className={`apm-segment${placements[index] === option.value ? ' active' : ''}`}
                        onClick={() => setAt(index, option.value)}
                      >
                        {option.short}
                      </button>
                    ))}
                  </span>
                </li>
              ))}
            </ul>

            <dl className="apm-legend">
              {OPTIONS.map((option) => (
                <div className="apm-legend-item" key={option.value}>
                  <dt>{option.label}</dt>
                  <dd>{option.detail}</dd>
                </div>
              ))}
            </dl>
          </>
        ) : (
          <div className="apm-options" role="radiogroup" aria-label="Agent working directory">
            {OPTIONS.map((option) => {
              const Icon = option.icon;
              const selected = placements[0] === option.value;
              const suggested = request.suggested === option.value && !!request.suggestionReason;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  className={`apm-option${selected ? ' selected' : ''}`}
                  onClick={() => setAt(0, option.value)}
                  onDoubleClick={confirm}
                >
                  <span className="apm-option-icon" aria-hidden="true">
                    <Icon />
                  </span>
                  <span className="apm-option-text">
                    <span className="apm-option-label">
                      {option.label}
                      {suggested && <span className="apm-option-tag">Suggested</span>}
                    </span>
                    <span className="apm-option-detail">{option.detail}</span>
                  </span>
                  <span className="apm-radio" aria-hidden="true" />
                </button>
              );
            })}
          </div>
        )}

        {request.suggestionReason && <p className="apm-reason">{request.suggestionReason}</p>}

        <footer className="apm-footer">
          <span className="apm-hint">
            {isMulti ? (
              <>
                {isolatedCount} isolated · {mainCount} in main repo
              </>
            ) : (
              <>
                <kbd>↑</kbd>
                <kbd>↓</kbd>
                to switch · <kbd>Enter</kbd> to start
              </>
            )}
          </span>
          <div className="apm-actions">
            <button type="button" className="apm-cancel-btn" onClick={cancel}>
              Cancel
            </button>
            <button type="button" className="apm-confirm-btn" onClick={confirm}>
              {confirmLabel()}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
