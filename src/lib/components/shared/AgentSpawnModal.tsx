import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
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
import './AgentSpawnModal.css';



export default function AgentSpawnModal({ onclose }: { onclose: () => void }) {
  const project = useStore(activeProject);
  const $customAgents = useStore(customAgents);
  const $removedPresetAgents = useStore(removedPresetAgents);
  const layout = useStore(layoutSnapshot);
  const isDev = layout.ambient === 'development';

  const [spawnCounts, setSpawnCounts] = useState<Map<string, number>>(new Map());
  const [spawning, setSpawning] = useState(false);

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
    setSpawning(true);

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
      for (const [cmd, count] of entries) {
        for (let i = 0; i < count; i++) {
          const name = pickAssistantName(takenNames);
          let worktree = projectId
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
            spawnedNames.push(name);
            lastId = id;
            total++;
          } else if (worktree && projectId) {
            void removeTaskWorktree(projectId, worktree, false);
          }
        }
      }
    } catch (err) {
      console.error('Failed spawning agents:', err);
    } finally {
      setSpawning(false);
    }

    if (!total) {
      showToast(
        projectId
          ? "Couldn't start the agent — see the console for details"
          : 'Open a project first to spawn an agent',
        'warning'
      );
      onclose();
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

    onclose();
  }, [spawnCounts, project, isDev, onclose]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && totalSpawnCount > 0 && !spawning) {
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
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="asm-title-icon"
            >
              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <line x1="19" y1="8" x2="19" y2="14" />
              <line x1="16" y1="11" x2="22" y2="11" />
            </svg>
            <span>Spawn Agents</span>
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
              return (
                <div key={preset.id} className={`asm-preset-row${count > 0 ? ' selected' : ''}`}>
                  <div className="asm-preset-info">
                    <span className="asm-preset-name">{preset.name}</span>
                    <span className="asm-preset-desc">{preset.command}</span>
                  </div>
                  <div className="asm-preset-controls">
                    <button
                      className="asm-btn asm-btn-decrement"
                      onClick={() => decrementSpawn(preset.command)}
                      disabled={count === 0 || spawning}
                      aria-label={`Decrease count for ${preset.name}`}
                    >
                      −
                    </button>
                    <span className="asm-count-value">{count}</span>
                    <button
                      className="asm-btn asm-btn-increment"
                      onClick={() => incrementSpawn(preset.command)}
                      disabled={spawning}
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
          <span className="asm-hint">Enter to confirm · Esc to dismiss</span>
          <button
            className="asm-confirm-btn"
            onClick={() => void handleSpawnConfirm()}
            disabled={totalSpawnCount === 0 || spawning}
          >
            {spawning ? 'Spawning...' : `Spawn${totalSpawnCount > 0 ? ` (${totalSpawnCount})` : ''}`}
          </button>
        </footer>
      </div>
    </div>
  );
}
