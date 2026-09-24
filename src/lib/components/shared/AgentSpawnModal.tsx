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
import { invoke } from '@tauri-apps/api/core';
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
import { DEEPSEEK_HARNESS_COMMAND, isDeepSeekHarness, openDeepSeekHarnessPanel } from '$lib/services/deepseek-harness';
import {
  defaultAgentPlacement,
  expandSpawnPlan,
  type AgentPlacement,
} from '$lib/stores/agentPlacement';

import { getAgentBrand } from './agentBrands';
import { AgentBrandMark } from './useAgentBrand';
import AgentLaunchConfigFields from './AgentLaunchConfigFields';
import AgentUpdateButton from './AgentUpdateButton';
import { agentUpdates, isAgentUpdating, refreshAgentUpdatesIfStale } from '$lib/stores/agentUpdates';
import { loadLiveAgentProviderModels, prewarmLiveAgentProviderModels } from '$lib/services/live-agent-models';
import { getAgentProviderLaunchOptions } from '$lib/services/agent-provider-catalogue';
import type { AgentProviderModel } from '$lib/services/agent-provider-catalogue';
import type { ChatReasoningEffort } from '$lib/types/chat';
import './AgentSpawnModal.css';

export default function AgentSpawnModal({ onclose }: { onclose: () => void }) {
  const project = useStore(activeProject);
  const asmBackdropRef = useRef<HTMLDivElement | null>(null);
  useModalFocus(asmBackdropRef);
  const $customAgents = useStore(customAgents);
  const $removedPresetAgents = useStore(removedPresetAgents);
  const $usage = useStore(usageState);
  const $agentUpdates = useStore(agentUpdates);
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
  const [launchConfigs, setLaunchConfigs] = useState<Map<string, { model: string | null; reasoningEffort: ChatReasoningEffort }>>(new Map());
  const [modelsByCommand, setModelsByCommand] = useState<Map<string, AgentProviderModel[]>>(new Map());
  const [loadingCommands, setLoadingCommands] = useState<Set<string>>(new Set());
  const requestedModelCommands = useRef(new Set<string>());
  // Unmount guard for the model probes below. It must NOT be per effect run:
  // `selectedPresets` changes on every +/- click and preset refresh, and a
  // per-run flag discarded a slow probe's result (Codex takes ~2s) while the
  // request-once set stopped it being asked again, so the picker stuck on "Auto".
  const modalMounted = useRef(true);
  useEffect(() => {
    modalMounted.current = true;
    return () => { modalMounted.current = false; };
  }, []);
  const [activeCommand, setActiveCommand] = useState<string | null>(null);
  const [rescanning, setRescanning] = useState(false);
  const [gitRepositoryAvailable, setGitRepositoryAvailable] = useState<boolean | null>(null);

  // A newly-created blank project is a real folder but is not a Git
  // repository. Worktrees require a repository and a resolved HEAD, while a
  // main-repo agent works correctly in an empty folder.
  useEffect(() => {
    let cancelled = false;
    const projectId = project?.id;
    if (!projectId || !isTauriRuntime()) {
      setGitRepositoryAvailable(projectId ? true : false);
      return () => {
        cancelled = true;
      };
    }

    setGitRepositoryAvailable(null);
    void invoke('workspace_git_status', { projectId })
      .then(() => {
        if (!cancelled) setGitRepositoryAvailable(true);
      })
      .catch(() => {
        if (!cancelled) setGitRepositoryAvailable(false);
      });

    return () => {
      cancelled = true;
    };
  }, [project?.id]);

  const defaultPlacement = gitRepositoryAvailable === true
    ? defaultAgentPlacement()
    : 'main';

  useEffect(() => {
    if (gitRepositoryAvailable !== false) return;
    setSpawnPlacements((current) => {
      let changed = false;
      const next = new Map(current);
      for (const [command, placement] of next) {
        if (placement === 'worktree') {
          next.set(command, 'main');
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [gitRepositoryAvailable]);

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

  // An agent that starts updating while picked is dropped from the plan: its
  // files are being replaced, so a spawn now would start a half-installed CLI.
  useEffect(() => {
    if (!$agentUpdates.updating.length) return;
    setSpawnCounts((prev) => {
      if (!$agentUpdates.updating.some((c) => prev.has(c))) return prev;
      const next = new Map(prev);
      for (const command of $agentUpdates.updating) next.delete(command);
      return next;
    });
  }, [$agentUpdates.updating]);

  useEffect(() => {
    refreshAgentUpdatesIfStale();
  }, [$usage.lastFetchedAt]);

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

  // Probe every offered CLI as soon as the modal lists it, so the model
  // picker is already filled by the time one is selected.
  useEffect(() => {
    prewarmLiveAgentProviderModels(spawnPresets.map((preset) => preset.command));
  }, [spawnPresets]);

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

  useEffect(() => {
    const commands = selectedPresets.map((preset) => preset.command);
    if (!commands.length) return;
    for (const command of commands) {
      if (requestedModelCommands.current.has(command)) continue;
      requestedModelCommands.current.add(command);
      setLoadingCommands((current) => new Set(current).add(command));
      void loadLiveAgentProviderModels(command)
        .then((models) => {
          if (!modalMounted.current) return;
          if (models.length) {
            setModelsByCommand((current) => new Map(current).set(command, models));
          } else {
            // An empty answer is not a catalogue; let a later render retry.
            requestedModelCommands.current.delete(command);
          }
        })
        .catch(() => {
          // Do not cache a failed fetch as an empty catalogue. The field
          // offers only "CLI default" meanwhile, and a later modal open
          // can retry the local CLI probe.
          requestedModelCommands.current.delete(command);
        })
        .finally(() => {
          if (modalMounted.current) {
            setLoadingCommands((current) => {
              const next = new Set(current);
              next.delete(command);
              return next;
            });
          }
        });
    }
  }, [selectedPresets]);

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
    if (isAgentUpdating(command)) return;
    setActiveCommand(command);
    setSpawnPlacements((prev) => {
      if (prev.has(command)) return prev;
      const next = new Map(prev);
      next.set(command, defaultPlacement);
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
    if (isAgentUpdating(command)) return;
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
          next.set(command, defaultPlacement);
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

  const launchConfigFor = (command: string) => launchConfigs.get(command) ?? { model: null, reasoningEffort: 'default' as ChatReasoningEffort };

  const setLaunchModel = (command: string, model: string | null) => {
    setLaunchConfigs((current) => {
      const next = new Map(current);
      next.set(command, { ...launchConfigFor(command), model });
      return next;
    });
  };

  const setLaunchReasoning = (command: string, reasoningEffort: ChatReasoningEffort) => {
    setLaunchConfigs((current) => {
      const next = new Map(current);
      next.set(command, { ...launchConfigFor(command), reasoningEffort });
      return next;
    });
  };

  const handleSpawnConfirm = useCallback(async () => {
    const selected = Array.from(spawnCounts.entries()).filter(
      ([cmd, count]) => count > 0 && !isAgentUpdating(cmd)
    );
    if (!selected.length) return;

    // DeepSeek Harness has no terminal UI: its tile opens one web panel for the
    // project (however many were picked) instead of spawning terminals.
    const entries = selected.filter(([cmd]) => !isDeepSeekHarness(cmd));
    if (entries.length < selected.length) {
      // Same placement rule as every other agent below.
      const placement = spawnPlacements.get(DEEPSEEK_HARNESS_COMMAND) ?? defaultPlacement;
      void openDeepSeekHarnessPanel({ isolated: placement === 'worktree' && gitRepositoryAvailable === true });
    }
    if (!entries.length) {
      onclose();
      return;
    }

    const plan = expandSpawnPlan(
      entries.map(([cmd, count]) => ({
        key: cmd,
        label: spawnPresets.find((p) => p.command === cmd)?.name ?? cmd,
        count,
      }))
    );
    const placements = plan.map(
      (item) => spawnPlacements.get(item.key) ?? defaultPlacement
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
        const skipWorktree = placements[index] !== 'worktree' || gitRepositoryAvailable !== true;
        const name = pickAssistantName(takenNames);
        if (!skipWorktree && !projectId) throw new Error('Open a project first to create an isolated worktree.');
        const worktree = projectId && !skipWorktree
          ? await createTaskWorktree({
              projectId,
              taskId: `fb_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
              label: name,
            })
          : null;

        const launchConfig = launchConfigFor(cmd);
        const launchOptions = getAgentProviderLaunchOptions(cmd, {
          model: launchConfig.model,
          reasoningEffort: launchConfig.reasoningEffort,
        });

        const id = await spawnAgentPreset(cmd, worktree?.path ?? cwd, {
          isDev,
          projectId,
          runtimeArgs: launchOptions.runtimeArgs || undefined,
          onSessionCreated: worktree ? (id) => setSessionWorktree(id, worktree) : undefined,
        });
        if (id !== null) {
          takenNames.push(name);
          applyOrchestratorAgentName(id, name);
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
      showToast(err instanceof Error ? err.message : String(err), 'error');
      if (!total) return;
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
  }, [spawnCounts, spawnPlacements, spawnPresets, launchConfigs, defaultPlacement, gitRepositoryAvailable, project, isDev, onclose]);

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
    ? spawnPlacements.get(activePreset.command) ?? defaultPlacement
    : defaultPlacement;

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
              <span className="asm-subtitle">Choose agents, counts, local CLI model, reasoning, and workspace.</span>
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
                const updating = $agentUpdates.updating.includes(preset.command);

                return (
                  <div
                    key={preset.id}
                    className={`asm-agent-tile${isSelected ? ' selected' : ''}${isActive ? ' active' : ''}${updating ? ' agent-updating' : ''}`}
                    aria-disabled={updating || undefined}
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
                    aria-label={updating ? `${preset.name} is updating` : `Select ${preset.name}`}
                  >
                    <span className="asm-tile-update agent-update-slot">
                      <AgentUpdateButton command={preset.command} name={preset.name} />
                    </span>

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
                  disabled={gitRepositoryAvailable !== true}
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
                  <small>
                    {gitRepositoryAvailable === false
                      ? 'Unavailable: this project is not a Git repository'
                      : 'Dedicated worktree & branch'}
                  </small>
                </button>
              </div>
            </div>

            <AgentLaunchConfigFields
              command={activePreset.command}
              models={modelsByCommand.get(activePreset.command) ?? []}
              loading={loadingCommands.has(activePreset.command)}
              model={launchConfigFor(activePreset.command).model}
              reasoningEffort={launchConfigFor(activePreset.command).reasoningEffort}
              onModelChange={(model) => setLaunchModel(activePreset.command, model)}
              onReasoningChange={(reasoningEffort) => setLaunchReasoning(activePreset.command, reasoningEffort)}
              boundarySelector=".asm-card"
            />
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
