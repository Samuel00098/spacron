import { useEffect, useState, useMemo, useCallback } from 'react';
import { useStore } from '$lib/react/useStore';
import { activeProject } from '$lib/stores/workspace';
import { showToast } from '$lib/stores/notification';
import { customAgents, removedPresetAgents } from '$lib/stores/customAgents';
import { getPresetRuns } from '$lib/stores/runs';
import { get } from '$lib/stores/storeCompat';
import { layoutSnapshot } from '$lib/stores/layoutControl';
import {
  sessions,
  spawnAgentPreset,
  manualPromptTargetId,
  setSessionWorktree,
} from '$lib/stores/terminal';
import { pickAssistantName } from '$lib/services/orchestrator/agent-names';
import { applyOrchestratorAgentName } from '$lib/services/orchestrator/terminal-lease';
import { createTaskWorktree, removeTaskWorktree } from '$lib/services/orchestrator/worktree-manager';
import { adoptSpawnedAgent } from '$lib/stores/orchestrator';
import { requestAgentPlacement, expandSpawnPlan } from '$lib/stores/agentPlacement';

import { getAgentBrand } from './agentBrands';
import { AgentBrandMark } from './useAgentBrand';
import './AgentSpawnModal.css';


export default function AgentSpawnModal({ onclose }: { onclose: () => void }) {
  const project = useStore(activeProject);
  const $customAgents = useStore(customAgents);
  const $removedPresetAgents = useStore(removedPresetAgents);
  const layout = useStore(layoutSnapshot);
  const isDev = layout.ambient === 'development';

  const [spawnCounts, setSpawnCounts] = useState<Map<string, number>>(new Map());

  const spawnPresets = useMemo(() => {
    void $customAgents;
    void $removedPresetAgents;
    if (!project) return [];
    return getPresetRuns(project.id).filter((r) => r.isAgent);
  }, [$customAgents, $removedPresetAgents, project]);

  const totalSpawnCount = useMemo(
    () => Array.from(spawnCounts.values()).reduce((a, b) => a + b, 0),
    [spawnCounts]
  );

  const incrementSpawn = (command: string) => {
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
  };

  const handleSpawnConfirm = useCallback(async () => {
    const entries = Array.from(spawnCounts.entries()).filter(([, count]) => count > 0);
    if (!entries.length) return;

    // Always confirm the working directory before anything starts — a worktree
    // agent's edits are invisible in the main checkout, which is easy to miss if
    // the choice is only a toggle. Flattened to one entry per agent so a batch
    // can be mixed (one in the main repo, the rest isolated). Dismissing keeps
    // this modal open with the user's picks intact.
    const plan = expandSpawnPlan(
      entries.map(([cmd, count]) => ({
        key: cmd,
        label: spawnPresets.find((p) => p.command === cmd)?.name ?? cmd,
        count,
      }))
    );
    const placements = await requestAgentPlacement({
      agents: plan.map((item) => item.label),
      source: 'manual',
    });
    if (!placements) return;

    // Close the popup immediately so that the background spawning process
    // can run without modal overlays flickering on top of tab changes.
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
      // `plan` is already one entry per agent, index-aligned with `placements`,
      // so each agent honours its OWN answer from the dialog.
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
          // Register with the orchestrator so this agent gets the same
          // turn-end cue and readable-output treatment as a dispatched one.
          // The typed-launch detector deliberately skips modal spawns, so
          // without this they stay invisible to agent mode. Must come after
          // applyOrchestratorAgentName so the task adopts the assigned name.
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
          ? "Couldn't start the agent — see the console for details"
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
  }, [spawnCounts, spawnPresets, project, isDev, onclose]);

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

  return (
    <div
      className="asm-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Spawn Agents"
      tabIndex={-1}
      onClick={handleBackdropClick}
      onKeyDown={handleKeyDown}
    >
      <div className="asm-card">
        <header className="asm-header">
          <div className="asm-title-row">
            <span className="asm-title-badge" aria-hidden="true">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M13 2 3 14h7l-1 8 10-12h-7z" />
              </svg>
            </span>
            <div className="asm-title-text">
              <span className="asm-title">Spawn Agents</span>
              <span className="asm-subtitle">Pick a coding CLI — you'll choose where it runs next</span>
            </div>
          </div>
          <button className="asm-close-btn" onClick={onclose} aria-label="Close dialog">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </header>

        <div className="asm-preset-list">
          {spawnPresets.length === 0 ? (
            <div className="asm-empty">No matching agent presets found.</div>
          ) : (
            spawnPresets.map((preset) => {
              const count = spawnCounts.get(preset.command) ?? 0;
              // Bundled brand drives the tile's --logo color; the mark itself is
              // rendered via AgentBrandMark so a custom agent's dashboardicons
              // logo shows here too (falling back to bundled/glyph).
              const brand = getAgentBrand(preset.command, preset.name);
              const selected = count > 0;
              const logoColor =
                brand.color === 'mono' ? 'var(--text-primary, #e8e8e8)' : brand.color;
              return (
                <div
                  key={preset.id}
                  className={`asm-card-item${selected ? ' selected' : ''}`}
                  style={{ ['--logo' as string]: logoColor }}
                  role="button"
                  tabIndex={0}
                  aria-pressed={selected}
                  onClick={() => (selected ? decrementSpawn(preset.command) : incrementSpawn(preset.command))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      selected ? decrementSpawn(preset.command) : incrementSpawn(preset.command);
                    }
                  }}
                >
                  <div className="asm-logo" aria-hidden="true">
                    <AgentBrandMark command={preset.command} name={preset.name} />
                  </div>
                  <div className="asm-card-info">
                    <span className="asm-card-name">{preset.name}</span>
                    <span className="asm-card-cmd">{preset.command}</span>
                  </div>
                  <div
                    className={`asm-stepper${selected ? ' active' : ''}`}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      className="asm-btn asm-btn-decrement"
                      onClick={() => decrementSpawn(preset.command)}
                      disabled={count === 0}
                      aria-label={`Decrease count for ${preset.name}`}
                    >
                      −
                    </button>
                    <span className="asm-count-value">{count}</span>
                    <button
                      className="asm-btn asm-btn-increment"
                      onClick={() => incrementSpawn(preset.command)}
                      aria-label={`Increase count for ${preset.name}`}
                    >
                      +
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>

        <footer className="asm-footer">
          <div className="asm-footer-left">
            {/* Isolated vs main repo is no longer a toggle here — spawning opens
                the placement dialog so the choice is always a deliberate one. */}
            <span className="asm-hint">Next: choose isolated worktree or main repo</span>
          </div>
          <button
            className="asm-confirm-btn"
            onClick={() => void handleSpawnConfirm()}
            disabled={totalSpawnCount === 0}
          >
            {`Spawn${totalSpawnCount > 0 ? ` ${totalSpawnCount}` : ''}`}
          </button>
        </footer>
      </div>
    </div>
  );
}
