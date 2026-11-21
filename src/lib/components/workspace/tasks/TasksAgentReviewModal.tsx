import { useEffect, useRef, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { getAgentRoster } from '$lib/stores/runs';
import { AgentBrandMark } from '$lib/components/shared/useAgentBrand';
import AgentLaunchConfigFields from '$lib/components/shared/AgentLaunchConfigFields';
import { loadLiveAgentProviderModels } from '$lib/services/live-agent-models';
import type { AgentProviderModel } from '$lib/services/agent-provider-catalogue';
import type { ChatReasoningEffort } from '$lib/types/chat';
import type { AgentPlacement } from '$lib/stores/agentPlacement';
import '$lib/components/shared/AgentPlacementModal.css';

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

const LOCATION_OPTIONS: Array<{
  value: AgentPlacement;
  label: string;
  detail: string;
  icon: () => ReactElement;
}> = [
  {
    value: 'worktree',
    label: 'Isolated worktree',
    detail:
      'Its own branch off HEAD, in a separate folder. Safe for parallel agents, but its edits will not show up in your main checkout until you merge them.',
    icon: WorktreeIcon,
  },
  {
    value: 'main',
    label: 'Main repo',
    detail:
      'Runs directly in the project root on your current branch. You see every edit immediately, and git tag and push work, but concurrent agents can collide.',
    icon: MainRepoIcon,
  },
];

export interface TasksAgentReviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  itemType: 'pr' | 'issue';
  itemNumber: number;
  itemTitle: string;
  itemBody: string;
  headBranch?: string;
  baseBranch?: string;
  onLaunch: (config: {
    agentCommand: string;
    agentName: string;
    placement: AgentPlacement;
    model: string | null;
    reasoningEffort: ChatReasoningEffort;
  }) => void;
}

export default function TasksAgentReviewModal({
  isOpen,
  onClose,
  itemType,
  itemNumber,
  itemTitle,
  itemBody,
  headBranch,
  baseBranch,
  onLaunch,
}: TasksAgentReviewModalProps) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const backdropRef = useRef<HTMLDivElement | null>(null);

  const roster = getAgentRoster();
  const [selectedAgent, setSelectedAgent] = useState(roster[0] ?? { command: 'codex', name: 'Codex CLI' });
  const [placement, setPlacement] = useState<AgentPlacement>('worktree');
  const [model, setModel] = useState<string | null>(null);
  const [reasoningEffort, setReasoningEffort] = useState<ChatReasoningEffort>('default');
  const [models, setModels] = useState<AgentProviderModel[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);

  // Load models whenever the active agent command changes
  useEffect(() => {
    let cancelled = false;
    const command = selectedAgent?.command;
    if (!command) return;

    setLoadingModels(true);
    setModel(null);
    setReasoningEffort('default');

    loadLiveAgentProviderModels(command)
      .then((m) => {
        if (!cancelled) {
          setModels(m);
        }
      })
      .catch((err) => {
        console.warn(`Could not load models for ${command}:`, err);
        if (!cancelled) setModels([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingModels(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedAgent?.command]);

  // Focus and keyboard listeners
  useEffect(() => {
    if (!isOpen) return;
    cardRef.current?.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        handleConfirm();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, selectedAgent, placement, model, reasoningEffort]);

  if (!isOpen) return null;

  const handleConfirm = () => {
    onLaunch({
      agentCommand: selectedAgent.command,
      agentName: selectedAgent.name,
      placement,
      model,
      reasoningEffort,
    });
    onClose();
  };

  const actionText =
    itemType === 'pr'
      ? placement === 'worktree'
        ? 'Start Review in Worktree'
        : 'Start Review in Main Repo'
      : placement === 'worktree'
        ? 'Start in Worktree'
        : 'Start in Main Repo';

  const modalContent = (
    <div
      className="apm-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Configure review agent launch"
      ref={backdropRef}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="apm-card" ref={cardRef} tabIndex={-1} style={{ width: 500 }}>
        {/* Header */}
        <header className="apm-header">
          <span className="apm-badge" aria-hidden="true">
            <WorktreeIcon />
          </span>
          <div className="apm-header-text">
            <span className="apm-title">Configure this agent launch</span>
            <span className="apm-subtitle">
              {selectedAgent?.name || 'Agent'} · location, local CLI model, and reasoning
            </span>
          </div>
        </header>

        {/* Agent Roster Selector (Hand-off style) */}
        {roster.length > 0 && (
          <div className="apm-agent-select-section">
            <span className="apm-section-label">Agent</span>
            <div className="apm-agent-roster-row">
              {roster.map((agent) => {
                const isSelected = selectedAgent?.command === agent.command;
                return (
                  <button
                    key={agent.command}
                    type="button"
                    className={`apm-agent-pill ${isSelected ? 'active' : ''}`}
                    onClick={() => setSelectedAgent(agent)}
                  >
                    <AgentBrandMark command={agent.command} name={agent.name} className="apm-agent-pill-mark" />
                    <span>{agent.name}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Location Selection: Worktree vs Main Repo */}
        <div className="apm-options" role="radiogroup" aria-label="Agent working directory">
          {LOCATION_OPTIONS.map((option) => {
            const Icon = option.icon;
            const selected = placement === option.value;
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={selected}
                className={`apm-option${selected ? ' selected' : ''}`}
                onClick={() => setPlacement(option.value)}
              >
                <span className="apm-option-icon" aria-hidden="true">
                  <Icon />
                </span>
                <span className="apm-option-text">
                  <span className="apm-option-label">{option.label}</span>
                  <span className="apm-option-detail">{option.detail}</span>
                </span>
                <span className="apm-radio" aria-hidden="true" />
              </button>
            );
          })}
        </div>

        {/* Model and Reasoning Configuration */}
        <div style={{ padding: '0 4px' }}>
          <AgentLaunchConfigFields
            command={selectedAgent?.command || 'codex'}
            models={models}
            loading={loadingModels}
            model={model}
            reasoningEffort={reasoningEffort}
            onModelChange={(m) => setModel(m)}
            onReasoningChange={(effort) => setReasoningEffort(effort)}
            boundarySelector=".apm-card"
          />
        </div>

        {/* Item context preview note */}
        <div style={{ padding: '8px 20px 4px', fontSize: 11, color: 'var(--text-muted)' }}>
          {itemType === 'pr' ? (
            <>
              Reviewing PR <strong>#{itemNumber}</strong>: {itemTitle.slice(0, 48)}
              {itemTitle.length > 48 ? '…' : ''}
              {headBranch && (
                <span style={{ marginLeft: 6 }}>
                  (<code>{headBranch}</code> → <code>{baseBranch || 'main'}</code>)
                </span>
              )}
            </>
          ) : (
            <>
              Assigned Issue <strong>#{itemNumber}</strong>: {itemTitle.slice(0, 48)}
              {itemTitle.length > 48 ? '…' : ''}
            </>
          )}
        </div>

        {/* Footer actions */}
        <footer className="apm-footer">
          <span className="apm-hint">
            <kbd>Esc</kbd> to cancel · <kbd>Ctrl+Enter</kbd> to launch
          </span>
          <div className="apm-actions">
            <button type="button" className="apm-cancel-btn" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="apm-confirm-btn" onClick={handleConfirm}>
              {actionText}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );

  return typeof document !== 'undefined' ? createPortal(modalContent, document.body) : modalContent;
}