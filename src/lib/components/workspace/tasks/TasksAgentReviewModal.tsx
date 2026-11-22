import { launchViewFor } from '$lib/services/terminal-chat';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { getAgentRoster } from '$lib/stores/runs';
import { AgentBrandMark } from '$lib/components/shared/useAgentBrand';
import AgentLaunchConfigFields from '$lib/components/shared/AgentLaunchConfigFields';
import { loadLiveAgentProviderModels } from '$lib/services/live-agent-models';
import { structuredChatAgentFor } from '$lib/services/structured-chat/panes';
import { cachedModelCatalog } from '$lib/services/structured-chat/model-catalog';
import type { AgentProviderModel } from '$lib/services/agent-provider-catalogue';
import type { ChatReasoningEffort } from '$lib/types/chat';
import { AgentSparklesIcon } from './TasksIcons';
import Dropdown, { type DropdownOption } from '$lib/components/shared/Dropdown';
import { useStore } from '$lib/react/useStore';
import {
  worktreesByProject,
  activeWorktreeByProject,
  refreshProjectWorktrees,
  mainWorktreeRow,
} from '$lib/stores/projectWorktrees';
import { get } from '$lib/stores/storeCompat';
import { allProjectSettings, projectConfigFor } from '$lib/stores/projectSettings';
import '$lib/components/shared/AgentPlacementModal.css';
import './TasksStyles.css';

function TerminalIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}

function ChatIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function HomeRepoIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <polyline points="9 22 9 12 15 12 15 22" />
    </svg>
  );
}

function GitBranchIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  );
}

export interface TasksAgentReviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  itemType: 'pr' | 'issue';
  itemNumber: number;
  itemTitle: string;
  itemBody: string;
  headBranch?: string;
  baseBranch?: string;
  projectId?: string;
  projectRoot?: string;
  onLaunch: (config: {
    agentCommand: string;
    agentName: string;
    launchTarget: 'terminal' | 'chat';
    worktreePath: string | null;
    model: string | null;
    reasoningEffort: ChatReasoningEffort;
    prompt: string;
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
  projectId,
  projectRoot,
  onLaunch,
}: TasksAgentReviewModalProps) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const backdropRef = useRef<HTMLDivElement | null>(null);

  const roster = getAgentRoster();
  const [selectedAgent, setSelectedAgent] = useState(roster[0] ?? { command: 'codex', name: 'Codex' });
  const [launchTarget, setLaunchTarget] = useState<'terminal' | 'chat'>(() => launchViewFor(selectedAgent.command));
  const structuredAgent = structuredChatAgentFor(selectedAgent.command);
  const supportsChat = Boolean(structuredAgent);

  useEffect(() => {
    if (isOpen) setLaunchTarget(supportsChat ? launchViewFor(selectedAgent.command) : 'terminal');
  }, [isOpen, selectedAgent.command, supportsChat]);

  useEffect(() => {
    if (!supportsChat && launchTarget === 'chat') {
      setLaunchTarget('terminal');
    }
  }, [supportsChat, launchTarget]);
  const [selectedWorktreePath, setSelectedWorktreePath] = useState<string>('');
  const [model, setModel] = useState<string | null>(null);
  const [reasoningEffort, setReasoningEffort] = useState<ChatReasoningEffort>('default');
  const [models, setModels] = useState<AgentProviderModel[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [prompt, setPrompt] = useState<string>('');

  const $worktrees = useStore(worktreesByProject);

  const worktreeList = useMemo(() => {
    const list = (projectId && $worktrees[projectId]) || [];
    if (list.length > 0) return list;
    if (projectRoot) return [mainWorktreeRow(projectRoot)];
    return [];
  }, [projectId, $worktrees, projectRoot]);

  // Load models whenever the active agent command changes
  useEffect(() => {
    let cancelled = false;
    const command = selectedAgent?.command;
    if (!command) return;

    setLoadingModels(true);
    setModels([]);

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

  const chatModels = useMemo<AgentProviderModel[]>(() => {
    if (!structuredAgent) return [];
    const cached = cachedModelCatalog(structuredAgent);
    if (cached && cached.length > 0) {
      return cached.map((m) => ({
        id: m.id,
        label: m.label,
        isDefault: m.isDefault,
        reasoningEfforts: m.efforts as ChatReasoningEffort[] | undefined,
        defaultReasoningEffort: (m.defaultEffort as ChatReasoningEffort) || null,
      }));
    }
    return [];
  }, [structuredAgent]);

  // Codex uses one catalogue for both launch modes. A previously connected
  // chat can supply it while the local probe is still loading.
  const effectiveModels = structuredAgent === 'codex'
    ? (models.length ? models : chatModels)
    : (launchTarget === 'chat' && chatModels.length ? chatModels : models);

  // Set prompt & worktree when modal opens
  useEffect(() => {
    if (!isOpen) return;

    if (projectId) {
      void refreshProjectWorktrees(projectId, projectRoot);
    }

    // Default prompt pre-fill
    const pConfig = projectRoot ? projectConfigFor(get(allProjectSettings), projectRoot, projectId) : null;
    const customBrief = pConfig?.customInstructions?.trim();
    const customSuffix = customBrief ? `\n\nProject Instructions & Guidelines:\n${customBrief}` : '';

    const initialPrompt =
      itemType === 'pr'
        ? `Review Pull Request #${itemNumber}: ${itemTitle}\nBranch: ${headBranch || 'HEAD'} → ${baseBranch || 'main'}\n\n${
            itemBody ? itemBody.trim() + '\n\n' : ''
          }Please review the changes in this pull request, inspect code quality and correctness, check for regressions, test coverage, or logic errors, and provide a clear, constructive review.${customSuffix}`
        : `Work on Issue #${itemNumber}: ${itemTitle}\n\n${
            itemBody ? itemBody.trim() + '\n\n' : ''
          }Please investigate this issue, identify the root cause, implement a fix, and verify with tests.${customSuffix}`;
    setPrompt(initialPrompt);

    // Default worktree selection:
    // 1. If PR has a headBranch and an open worktree matches it, select that
    if (headBranch && worktreeList.length > 0) {
      const match = worktreeList.find((w) => w.branch === headBranch || w.name === headBranch);
      if (match) {
        setSelectedWorktreePath(match.path);
        return;
      }
    }
    // 2. Otherwise active worktree or main
    const activePath = projectId ? get(activeWorktreeByProject)[projectId] : null;
    if (activePath) {
      setSelectedWorktreePath(activePath);
    } else {
      const mainRow = worktreeList.find((w) => w.is_main);
      setSelectedWorktreePath(mainRow?.path || projectRoot || '');
    }
  }, [isOpen, itemType, itemNumber, itemTitle, itemBody, headBranch, baseBranch, projectId, projectRoot]);

  // Keyboard listeners
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
  }, [isOpen, selectedAgent, launchTarget, selectedWorktreePath, model, reasoningEffort, prompt]);

  const worktreeOptions = useMemo<DropdownOption[]>(() => {
    if (worktreeList.length === 0) {
      return [
        {
          value: projectRoot || '',
          label: `Main Repository (${baseBranch || 'main'})`,
          sublabel: projectRoot || '',
          icon: <HomeRepoIcon />,
        },
      ];
    }
    return worktreeList.map((w) => {
      const isMain = w.is_main;
      const isPr = headBranch && (w.branch === headBranch || w.name === headBranch);
      return {
        value: w.path,
        label: isMain ? `Main Repository (${w.branch || 'main'})` : `${w.name}${isPr ? ' (PR)' : ''}`,
        sublabel: w.branch ? `branch: ${w.branch}` : w.path,
        tooltip: w.path,
        icon: isMain ? <HomeRepoIcon /> : <GitBranchIcon />,
      };
    });
  }, [worktreeList, projectRoot, baseBranch, headBranch]);

  if (!isOpen) return null;

  const handleConfirm = () => {
    onLaunch({
      agentCommand: selectedAgent.command,
      agentName: selectedAgent.name,
      launchTarget,
      worktreePath: selectedWorktreePath || null,
      model,
      reasoningEffort,
      prompt: prompt.trim(),
    });
    onClose();
  };

  const actionText =
    itemType === 'pr'
      ? launchTarget === 'terminal'
        ? 'Start Review in Terminal'
        : 'Send to Agent Chat'
      : launchTarget === 'terminal'
        ? 'Start in Terminal'
        : 'Send to Agent Chat';

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
      <div className="tasks-agent-modal-card" ref={cardRef} tabIndex={-1}>
        {/* Header */}
        <header className="tasks-modal-header">
          <div className="tasks-modal-header-left">
            <span className="apm-badge" aria-hidden="true" style={{ color: 'var(--accent)' }}>
              <AgentSparklesIcon size={18} />
            </span>
            <div className="apm-header-text">
              <span className="apm-title">
                {itemType === 'pr' ? 'Configure Agent Review' : 'Configure Agent Launch'}
              </span>
              <span className="apm-subtitle">
                {selectedAgent?.name || 'Agent'} · {launchTarget === 'terminal' ? 'Interactive Terminal' : 'Agent Chat'}
              </span>
            </div>
          </div>
          <button
            type="button"
            className="tasks-modal-close-btn"
            onClick={onClose}
            title="Close"
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <div className="tasks-review-body">
        <div className="tasks-review-settings">
        {/* Agent Roster Selector */}
        {roster.length > 0 && (
          <div className="tasks-modal-section">
            <span className="tasks-modal-section-label">Agent</span>
            <div className="tasks-agent-roster-row">
              {roster.map((agent) => {
                const isSelected = selectedAgent?.command === agent.command;
                return (
                  <button
                    key={agent.command}
                    type="button"
                    className={`apm-agent-pill ${isSelected ? 'active' : ''}`}
                    onClick={() => {
                      if (isSelected) return;
                      setSelectedAgent(agent);
                      setModel(null);
                      setReasoningEffort('default');
                    }}
                  >
                    <AgentBrandMark command={agent.command} name={agent.name} className="apm-agent-pill-mark" />
                    <span>{agent.name}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Launch Mode: Terminal vs Chat */}
        <div className="tasks-modal-section">
          <span className="tasks-modal-section-label">Launch Mode</span>
          <div className={`tasks-modal-target-grid ${!supportsChat ? 'single' : ''}`} role="radiogroup" aria-label="Launch target mode">
            <button
              type="button"
              role="radio"
              aria-checked={launchTarget === 'terminal'}
              className={`tasks-modal-target-card ${launchTarget === 'terminal' ? 'selected' : ''}`}
              onClick={() => setLaunchTarget('terminal')}
            >
              <div className="tasks-modal-target-icon">
                <TerminalIcon size={15} />
              </div>
              <div className="tasks-modal-target-info">
                <span className="tasks-modal-target-title">Interactive Terminal</span>
                <span className="tasks-modal-target-desc">CLI session in terminal</span>
              </div>
            </button>
            {supportsChat && (
              <button
                type="button"
                role="radio"
                aria-checked={launchTarget === 'chat'}
                className={`tasks-modal-target-card ${launchTarget === 'chat' ? 'selected' : ''}`}
                onClick={() => setLaunchTarget('chat')}
              >
                <div className="tasks-modal-target-icon">
                  <ChatIcon size={15} />
                </div>
                <div className="tasks-modal-target-info">
                  <span className="tasks-modal-target-title">Agent Chat</span>
                  <span className="tasks-modal-target-desc">Conversational chat thread</span>
                </div>
              </button>
            )}
          </div>
          {!supportsChat && (
            <div className="tasks-modal-chat-unsupported-note">
              <span>{selectedAgent?.name || 'This agent'} runs directly in the terminal (chat protocol is not supported for this CLI).</span>
            </div>
          )}
        </div>

        {/* Working Directory / Worktree Selection */}
        <div className="tasks-modal-section">
          <div className="tasks-modal-section-label">
            <span>Working Directory / Worktree</span>
            <span className="tasks-modal-section-sub">Pick from open project worktrees</span>
          </div>
          <div className="tasks-modal-worktree-wrap">
            <Dropdown
              options={worktreeOptions}
              value={selectedWorktreePath}
              onChange={(val) => setSelectedWorktreePath(val)}
              boundarySelector=".tasks-agent-modal-card"
              direction="down"
              menuMaxHeight={144}
              ariaLabel="Select working worktree"
            />
          </div>
        </div>

        {/* Model and Reasoning Configuration */}
        <div className="tasks-modal-config-wrap">
          <AgentLaunchConfigFields
            mode={launchTarget === 'chat' ? 'chat' : 'cli'}
            command={selectedAgent?.command || 'codex'}
            models={effectiveModels}
            loading={loadingModels}
            model={model}
            reasoningEffort={reasoningEffort}
            onModelChange={setModel}
            onReasoningChange={setReasoningEffort}
            boundarySelector=".tasks-agent-modal-card"
          />
        </div>

        </div>
        {/* Review Instructions & Prompt Box */}
        <div className="tasks-modal-section tasks-review-prompt">
          <div className="tasks-modal-section-label">
            <span>Review Instructions & Prompt</span>
            <span className="tasks-modal-section-sub">Delivered directly to the agent</span>
          </div>
          <textarea
            className="tasks-modal-prompt-textarea"
            rows={4}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Instructions sent to the agent..."
          />
        </div>

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
