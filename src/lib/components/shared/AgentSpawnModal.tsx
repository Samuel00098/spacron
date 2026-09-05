import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { useStore } from '$lib/react/useStore';
import { useModalFocus } from '$lib/react/useModalFocus';
import { activeProject } from '$lib/stores/workspace';
import { showToast } from '$lib/stores/notification';
import { customAgents, removedPresetAgents } from '$lib/stores/customAgents';
import { getPresetRuns, filterInstalledAgents } from '$lib/stores/runs';
import {
  usageState,
  refreshUsage,
  installedAgentCommands,
  haveAgentDetection,
  type DetectedAgent,
} from '$lib/stores/usage';
import { isTauriRuntime } from '$lib/utils/tauri';
import { get } from '$lib/stores/storeCompat';
import { layoutSnapshot } from '$lib/stores/layoutControl';
import {
  sessions,
  spawnAgentPreset,
  manualPromptTargetId,
  setSessionWorktree,
} from '$lib/stores/terminal';
import {
  agentPermissionMode,
  agentDefaultArgs,
  agentDefaultEnv,
} from '$lib/stores/settings';
import { hasCustomizedYoloAgents } from '$lib/services/agent-permissions';
import { runAgentSignIn, shouldOfferSignIn } from '$lib/services/agent-signin';
import { pickAssistantName } from '$lib/services/orchestrator/agent-names';
import { applyOrchestratorAgentName } from '$lib/services/orchestrator/terminal-lease';
import { createTaskWorktree, removeTaskWorktree } from '$lib/services/orchestrator/worktree-manager';
import { adoptSpawnedAgent } from '$lib/stores/orchestrator';
import {
  defaultAgentPlacement,
  expandSpawnPlan,
  type AgentPlacement,
} from '$lib/stores/agentPlacement';

import { getAgentBrand } from './agentBrands';
import { AgentBrandMark } from './useAgentBrand';
import './AgentSpawnModal.css';

export default function AgentSpawnModal({ onclose }: { onclose: () => void }) {
  const project = useStore(activeProject);
  const asmBackdropRef = useRef<HTMLDivElement | null>(null);
  useModalFocus(asmBackdropRef);
  const $customAgents = useStore(customAgents);
  const $removedPresetAgents = useStore(removedPresetAgents);
  const $usage = useStore(usageState);
  const layout = useStore(layoutSnapshot);
  const isDev = layout.ambient === 'development';

  const $permissionMode = useStore(agentPermissionMode);
  const $agentDefaultArgs = useStore(agentDefaultArgs);
  const $agentDefaultEnv = useStore(agentDefaultEnv);
  const somePinned = hasCustomizedYoloAgents($permissionMode, {
    agentDefaultArgs: $agentDefaultArgs,
    agentDefaultEnv: $agentDefaultEnv,
  });
  const yolo = $permissionMode === 'yolo';

  const [spawnCounts, setSpawnCounts] = useState<Map<string, number>>(new Map());
  const [spawnPlacements, setSpawnPlacements] = useState<Map<string, AgentPlacement>>(new Map());
  const [activeCommand, setActiveCommand] = useState<string | null>(null);
  const [rescanning, setRescanning] = useState(false);

  // One-click sign-in: close picker, open CLI in terminal to complete login
  const openSignIn = (command: string, name: string) => {
    const cwd = project?.root_path;
    const projectId = project?.id;
    if (!cwd || !projectId) {
      showToast('Open a project first to sign in to an agent', 'warning');
      return;
    }
    onclose();
    void runAgentSignIn({ command, name, cwd, projectId, isDev });
  };

  useEffect(() => {
    void refreshUsage();
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void refreshUsage();
    }, SPAWN_MODAL_POLL_MS);
    return () => clearInterval(timer);
  }, []);

  const spawnPresets = useMemo(() => {
    void $removedPresetAgents;
    if (!project) return [];
    const all = getPresetRuns(project.id).filter((r) => r.isAgent);
    return filterInstalledAgents(all, {
      installedCommands: installedAgentCommands($usage),
      customCommands: new Set($customAgents.map((a) => a.command)),
      haveDetection: haveAgentDetection($usage),
    });
  }, [project, $usage.lastFetchedAt, $usage.detected, $customAgents, $removedPresetAgents]);

  const detectedByCommand = useMemo(() => {
    const map = new Map<string, DetectedAgent>();
    for (const det of $usage.detected) map.set(det.command, det);
    return map;
  }, [$usage.detected]);

  const scanning = isTauriRuntime() && $usage.loading && $usage.lastFetchedAt === 0;

  const totalSpawnCount = useMemo(
    () => Array.from(spawnCounts.values()).reduce((a, b) => a + b, 0),
    [spawnCounts]
  );

  // All presets currently chosen (count > 0)
  const selectedPresets = useMemo(() => {
    return spawnPresets.filter((p) => (spawnCounts.get(p.command) ?? 0) > 0);
  }, [spawnPresets, spawnCounts]);

  // Active agent shown in the configuration section
  const activePreset = useMemo(() => {
    if (activeCommand) {
      const found = spawnPresets.find((p) => p.command === activeCommand);
      if (found) return found;
    }
    if (selectedPresets.length > 0) return selectedPresets[0];
    return spawnPresets[0] ?? null;
  }, [spawnPresets, activeCommand, selectedPresets]);

  useEffect(() => {
    if (!activeCommand && spawnPresets.length > 0) {
      setActiveCommand(spawnPresets[0].command);
    }
  }, [spawnPresets, activeCommand]);

  const incrementSpawn = (command: string) => {
    setActiveCommand(command);
    setSpawnPlacements((prev) => {
      if (prev.has(command)) return prev;
      const next = new Map(prev);
      next.set(command, defaultAgentPlacement());
      return next;
    });
    setSpawnCounts((prev) => {
      const next = new Map(prev);
      next.set(command, (next.get(command) ?? 0) + 1);
      return next;
    });
  };

  const decrementSpawn = (command: string) => {
    setSpawnCounts((prev) => {
      const next = new Map(prev);
      const count = next.get(command) ?? 0;
      if (count <= 1) {
        next.delete(command);
      } else {
        next.set(command, count - 1);
      }
      return next;
    });
    if ((spawnCounts.get(command) ?? 0) <= 1) {
      setSpawnPlacements((placements) => {
        const nextPlacements = new Map(placements);
        nextPlacements.delete(command);
        return nextPlacements;
      });
    }
  };

  const handleTileClick = (command: string) => {
    setActiveCommand(command);
    const count = spawnCounts.get(command) ?? 0;
    if (count === 0) {
      setSpawnCounts((prev) => {
        const next = new Map(prev);
        next.set(command, 1);
        return next;
      });
      setSpawnPlacements((prev) => {
        if (!prev.has(command)) {
          const next = new Map(prev);
          next.set(command, defaultAgentPlacement());
          return next;
        }
        return prev;
      });
    }
  };

  const setSpawnPlacement = (command: string, placement: AgentPlacement) => {
    setSpawnPlacements((prev) => {
      const next = new Map(prev);
      next.set(command, placement);
      return next;
    });
  };

  const handleSpawnConfirm = useCallback(async () => {
    const entries = Array.from(spawnCounts.entries()).filter(([, count]) => count > 0);
    if (!entries.length) return;

    const plan = expandSpawnPlan(
      entries.map(([cmd, count]) => ({
        key: cmd,
        label: spawnPresets.find((p) => p.command === cmd)?.name ?? cmd,
        count,
      }))
    );
    const placements = plan.map(
      (item) => spawnPlacements.get(item.key) ?? defaultAgentPlacement()
    );

    onclose();

    const cwd = project?.root_path;
    const projectId = project?.id;
    const currentSessions = get(sessions);
    const takenNames = currentSessions
      .filter((s) => s.isRunning && s.agentName)
      .map((s) => s.agentName as string);

    let lastId: number | null = null;
    let total = 0;
    const spawnedNames: string[] = [];

    try {
      for (const [index, { key: cmd }] of plan.entries()) {
        const skipWorktree = placements[index] === 'main';
        const name = pickAssistantName(takenNames);
        let worktree = projectId && !skipWorktree
          ? await createTaskWorktree({
              projectId,
              taskId: `fb_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
              label: name,
            })
          : null;

        let id = await spawnAgentPreset(cmd, worktree?.path ?? cwd, { isDev });
        if (id === null && worktree) {
          if (projectId) void removeTaskWorktree(projectId, worktree, false);
          worktree = null;
          id = await spawnAgentPreset(cmd, cwd, { isDev });
        }
        if (id !== null) {
          takenNames.push(name);
          applyOrchestratorAgentName(id, name);
          if (worktree) setSessionWorktree(id, worktree);
          if (projectId) adoptSpawnedAgent(id, projectId);
          spawnedNames.push(name);
          lastId = id;
          total++;
        } else if (worktree && projectId) {
          void removeTaskWorktree(projectId, worktree, false);
        }
      }
    } catch (err) {
      console.error('Failed spawning agents:', err);
    }

    if (!total) {
      showToast(
        projectId
          ? "Couldn't start the agent. See the console for details."
          : 'Open a project first to spawn an agent',
        'warning'
      );
      return;
    }

    if (lastId !== null) {
      manualPromptTargetId.set(lastId);
    }

    showToast(
      total === 1
        ? `Spawned ${spawnedNames[0]}`
        : `Spawned ${total} agents: ${spawnedNames.join(', ')}`,
      'success',
      undefined,
      true
    );
  }, [spawnCounts, spawnPlacements, spawnPresets, project, isDev, onclose]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && totalSpawnCount > 0) {
      e.preventDefault();
      void handleSpawnConfirm();
    }
    if (e.key === 'Escape') onclose();
  }

  function handleBackdropClick(e: React.MouseEvent) {
    if (e.target === e.currentTarget) onclose();
  }

  const activePlacement = activePreset
    ? spawnPlacements.get(activePreset.command) ?? defaultAgentPlacement()
    : defaultAgentPlacement();

  return (
    <div
      className="asm-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Spawn Agents"
      tabIndex={-1}
      ref={asmBackdropRef}
      onClick={handleBackdropClick}
      onKeyDown={handleKeyDown}
    >
      <div className="asm-card">
        {/* Header with relatable Bot/Agent Icon */}
        <header className="asm-header">
          <div className="asm-title-row">
            <span className="asm-title-badge" aria-hidden="true">
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 8V4H8" />
                <rect width="16" height="12" x="4" y="8" rx="2" />
                <path d="M2 14h2" />
                <path d="M20 14h2" />
                <line x1="9" y1="13" x2="9" y2="15" />
                <line x1="15" y1="13" x2="15" y2="15" />
              </svg>
            </span>
            <div className="asm-title-text">
              <span className="asm-title">Spawn Agents</span>
              <span className="asm-subtitle">Choose agents, set instance counts under each, and configure workspace.</span>
            </div>
          </div>
          <button className="asm-close-btn" onClick={onclose} aria-label="Close dialog">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </header>

        {/* Top Section: Agent Icons Grid with Steppers right under each agent */}
        <div className="asm-preset-list">
          {spawnPresets.length === 0 ? (
            <div className="asm-empty">
              {scanning
                ? 'Scanning for installed agents…'
                : 'No agent CLIs detected on this machine. Install one, then hit Rescan below, or add a custom agent in Settings → Agents.'}
            </div>
          ) : (
            <div className="asm-icon-grid">
              {spawnPresets.map((preset) => {
                const count = spawnCounts.get(preset.command) ?? 0;
                const brand = getAgentBrand(preset.command, preset.name);
                const isSelected = count > 0;
                const isActive = activePreset?.command === preset.command;
                const logoColor =
                  brand.color === 'mono' ? 'var(--text-primary)' : brand.color;
                const det = detectedByCommand.get(preset.command);
                const offerSignIn = shouldOfferSignIn(det);

                return (
                  <div
                    key={preset.id}
                    className={`asm-agent-tile${isSelected ? ' selected' : ''}${isActive ? ' active' : ''}`}
                    style={{ ['--logo' as string]: logoColor }}
                    onClick={() => handleTileClick(preset.command)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        handleTileClick(preset.command);
                      }
                    }}
                    aria-label={`Select ${preset.name}`}
                  >
                    {count > 0 && (
                      <span
                        className={`asm-tile-count-badge${brand.color === 'mono' ? ' mono' : ''}`}
                        aria-label={`${count} selected`}
                      >
                        ×{count}
                      </span>
                    )}

                    <div className="asm-tile-icon" aria-hidden="true">
                      <AgentBrandMark command={preset.command} name={preset.name} />
                    </div>

                    <span className="asm-tile-name">{preset.name}</span>

                    <div className="asm-tile-badge-row">
                      {renderStateBadge(
                        det,
                        preset.id.startsWith('custom:'),
                        preset.name
                      )}
                      {offerSignIn && (
                        <button
                          type="button"
                          className="asm-signin-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            void openSignIn(preset.command, preset.name);
                          }}
                          title={`Run \`${preset.command}\` in a new terminal to sign in, then hit Rescan.`}
                        >
                          Sign in
                        </button>
                      )}
                    </div>

                    {/* Stepper directly under the agent icon */}
                    <div
                      className={`asm-tile-stepper${count > 0 ? ' has-count' : ''}`}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {count > 0 ? (
                        <>
                          <button
                            type="button"
                            className="asm-tile-step-btn"
                            onClick={(e) => {
                              e.stopPropagation();
                              decrementSpawn(preset.command);
                            }}
                            aria-label={`Decrease count for ${preset.name}`}
                          >
                            −
                          </button>
                          <span className="asm-tile-step-count">{count}</span>
                          <button
                            type="button"
                            className="asm-tile-step-btn"
                            onClick={(e) => {
                              e.stopPropagation();
                              incrementSpawn(preset.command);
                            }}
                            aria-label={`Increase count for ${preset.name}`}
                          >
                            +
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="asm-tile-add-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleTileClick(preset.command);
                          }}
                          aria-label={`Add ${preset.name}`}
                        >
                          + Add
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Configuration Section: Workspace Target for active agent */}
        {activePreset && (
          <div className="asm-config-section">
            <div className="asm-config-header">
              <div className="asm-config-agent-info">
                <span className="asm-config-label">Configuring</span>
                <span className="asm-config-agent-name">{activePreset.name}</span>
                <code className="asm-config-agent-cmd">{activePreset.command}</code>
              </div>
              {shouldOfferSignIn(detectedByCommand.get(activePreset.command)) && (
                <button
                  type="button"
                  className="asm-signin-btn"
                  onClick={() => void openSignIn(activePreset.command, activePreset.name)}
                  title={`Run \`${activePreset.command}\` in a new terminal to sign in, then hit Rescan.`}
                >
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <polyline points="4 7 9 12 4 17" />
                    <line x1="12" y1="19" x2="20" y2="19" />
                  </svg>
                  Sign in
                </button>
              )}
            </div>

            {/* Quick-switch tabs when multiple agents are picked */}
            {selectedPresets.length > 1 && (
              <div className="asm-selected-agent-tabs" role="tablist" aria-label="Selected agents">
                {selectedPresets.map((p) => {
                  const count = spawnCounts.get(p.command) ?? 0;
                  const isTabActive = activePreset?.command === p.command;
                  return (
                    <button
                      key={p.command}
                      type="button"
                      role="tab"
                      aria-selected={isTabActive}
                      className={`asm-agent-tab${isTabActive ? ' active' : ''}`}
                      onClick={() => setActiveCommand(p.command)}
                    >
                      <span>{p.name}</span>
                      <span className="asm-tab-count">×{count}</span>
                    </button>
                  );
                })}
              </div>
            )}

            {/* Workspace target switcher */}
            <div className="asm-config-field">
              <span className="asm-field-title">
                Workspace target {selectedPresets.length > 1 ? `for ${activePreset.name}` : ''}
              </span>
              <div
                className="asm-placement-grid"
                role="radiogroup"
                aria-label={`Where ${activePreset.name} works`}
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={activePlacement === 'main'}
                  className={`asm-placement-card${activePlacement === 'main' ? ' selected' : ''}`}
                  onClick={() => setSpawnPlacement(activePreset.command, 'main')}
                >
                  <div className="asm-placement-card-header">
                    <span className="asm-placement-radio" aria-hidden="true">
                      {activePlacement === 'main' && <span className="asm-radio-inner" />}
                    </span>
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="asm-placement-icon"
                    >
                      <line x1="6" y1="3" x2="6" y2="15" />
                      <circle cx="18" cy="6" r="3" />
                      <circle cx="6" cy="18" r="3" />
                      <path d="M18 9a9 9 0 0 1-9 9" />
                    </svg>
                    <strong>Main repo</strong>
                  </div>
                  <small>Edits appear in tree immediately</small>
                </button>

                <button
                  type="button"
                  role="radio"
                  aria-checked={activePlacement === 'worktree'}
                  className={`asm-placement-card${activePlacement === 'worktree' ? ' selected' : ''}`}
                  onClick={() => setSpawnPlacement(activePreset.command, 'worktree')}
                >
                  <div className="asm-placement-card-header">
                    <span className="asm-placement-radio" aria-hidden="true">
                      {activePlacement === 'worktree' && <span className="asm-radio-inner" />}
                    </span>
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="asm-placement-icon"
                    >
                      <rect x="3" y="3" width="7" height="7" rx="1" />
                      <rect x="14" y="3" width="7" height="7" rx="1" />
                      <rect x="14" y="14" width="7" height="7" rx="1" />
                      <path d="M10 6.5h4" />
                      <path d="M17.5 10v4" />
                    </svg>
                    <strong>Isolated repo</strong>
                  </div>
                  <small>Dedicated worktree &amp; branch</small>
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Footer */}
        <footer className="asm-footer">
          <div className="asm-footer-left">
            <span
              className="asm-perm"
              data-mode={$permissionMode}
              title={
                (yolo
                  ? "Each CLI launches with its own skip-permissions flag (claude --dangerously-skip-permissions, codex --dangerously-bypass-approvals-and-sandbox, …), so a run never stalls waiting for you. CLIs that have no such flag still ask."
                  : 'Agents launch bare and ask before acting, as they normally would.') +
                (somePinned
                  ? ' Some agents are pinned to the other mode and ignore this.'
                  : '') +
                ' Change it in Settings → Agents.'
              }
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5z" />
                {yolo ? <path d="m4 3 16 18" /> : <path d="m9 12 2 2 4-4" />}
              </svg>
              <span className="asm-perm-label">
                {yolo ? 'Yolo: permission prompts bypassed' : 'Manual: agents ask first'}
              </span>
              {somePinned && <span className="asm-perm-note">· some pinned</span>}
            </span>

            {isTauriRuntime() && (
              <button
                type="button"
                className={`asm-rescan${rescanning ? ' scanning' : ''}`}
                onClick={() => {
                  setRescanning(true);
                  void refreshUsage(true).finally(() => setRescanning(false));
                }}
                disabled={$usage.loading}
                title="Rescan your PATH for newly installed or removed agent CLIs"
              >
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
                  <polyline points="21 3 21 8 16 8" />
                </svg>
                {rescanning ? 'Scanning…' : 'Rescan'}
              </button>
            )}
          </div>

          <button
            type="button"
            className="asm-confirm-btn"
            onClick={() => void handleSpawnConfirm()}
            disabled={totalSpawnCount === 0}
          >
            {totalSpawnCount === 0
              ? 'Select an agent'
              : totalSpawnCount === 1
                ? 'Spawn 1 Agent'
                : `Spawn ${totalSpawnCount} Agents`}
          </button>
        </footer>
      </div>
    </div>
  );
}

const SPAWN_MODAL_POLL_MS = 20 * 1000;

function renderStateBadge(
  det: DetectedAgent | undefined,
  isCustom: boolean,
  name: string
) {
  if (isCustom) {
    return (
      <span
        className="asm-badge custom"
        title="Custom agent, added by you in Settings → Agents. Spacron can't auto-detect it, so it's always shown here."
      >
        <span className="asm-badge-dot" aria-hidden="true" />
        Custom
      </span>
    );
  }
  if (det?.signedIn) {
    return (
      <span
        className="asm-badge"
        data-tone="ready"
        title={`${name} is signed in and ready to spawn.`}
      >
        <span className="asm-badge-dot" aria-hidden="true" />
        Signed in
      </span>
    );
  }
  if (det?.installed && !det.detectsSignIn) {
    return (
      <span
        className="asm-badge"
        data-tone="partial"
        title="Installed. This CLI keeps its credentials in your system keychain or environment (API keys), so Spacron can't tell whether you're signed in."
      >
        <span className="asm-badge-dot" aria-hidden="true" />
        Installed
      </span>
    );
  }
  if (det?.installed) {
    return (
      <span
        className="asm-badge"
        data-tone="partial"
        title={`Installed but no sign-in detected. Run \`${det.command}\` once to sign in, then hit Rescan if you already did.`}
      >
        <span className="asm-badge-dot" aria-hidden="true" />
        Installed
      </span>
    );
  }
  return null;
}
