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
import { setSessionRole } from '$lib/stores/terminal';
import type { AgentRole } from '$lib/services/orchestrator/agent-charter';
import { loadJson } from '$lib/utils/storage';
import { getAgentBrand } from './agentBrands';
import { AgentBrandMark } from './useAgentBrand';
import './AgentSpawnModal.css';

const ROLE_STORAGE_KEY = 'spacron_spawn_role';



export default function AgentSpawnModal({ onclose }: { onclose: () => void }) {
  const project = useStore(activeProject);
  const $customAgents = useStore(customAgents);
  const $removedPresetAgents = useStore(removedPresetAgents);
  const layout = useStore(layoutSnapshot);
  const isDev = layout.ambient === 'development';

  const [spawnCounts, setSpawnCounts] = useState<Map<string, number>>(new Map());
  const [spawning, setSpawning] = useState(false);
  const [skipWorktree, setSkipWorktree] = useState(false);
  const [role, setRole] = useState<AgentRole | ''>(
    () => loadJson<AgentRole | ''>(ROLE_STORAGE_KEY, '')
  );
  const [roleOpen, setRoleOpen] = useState(false);
  const roleRef = useRef<HTMLDivElement>(null);

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
      for (const [cmd, count] of entries) {
        for (let i = 0; i < count; i++) {
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
          }            if (id !== null) {
            takenNames.push(name);
            applyOrchestratorAgentName(id, name);
            if (role) setSessionRole(id, role);
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
  }, [spawnCounts, project, isDev, onclose, role]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && totalSpawnCount > 0 && !spawning) {
      e.preventDefault();
      void handleSpawnConfirm();
    }
    if (e.key === 'Escape') onclose();
  }

  useEffect(() => {
    if (role) {
      localStorage.setItem(ROLE_STORAGE_KEY, JSON.stringify(role));
    } else {
      localStorage.removeItem(ROLE_STORAGE_KEY);
    }
  }, [role]);

  // Close the role dropdown on outside click
  useEffect(() => {
    if (!roleOpen) return;
    const handleOutside = (e: MouseEvent) => {
      if (roleRef.current && !roleRef.current.contains(e.target as Node)) {
        setRoleOpen(false);
      }
    };
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, [roleOpen]);

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
              <span className="asm-subtitle">Pick a coding CLI to launch in a fresh worktree</span>
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
                  onClick={() => !spawning && (selected ? decrementSpawn(preset.command) : incrementSpawn(preset.command))}
                  onKeyDown={(e) => {
                    if ((e.key === 'Enter' || e.key === ' ') && !spawning) {
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
          <div className="asm-footer-left">
            <div className="asm-role-collapsed" ref={roleRef}>
              <button
                className={`asm-role-toggle${role ? ' has-role' : ''}`}
                onClick={() => setRoleOpen(!roleOpen)}
                title="Assign a team role"
                aria-label="Assign a team role for handoff and review"
                aria-expanded={roleOpen}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M20 7h-9a5 5 0 0 0-5 5v2a5 5 0 0 0 5 5h1v2l3-2h5a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2z" />
                  <line x1="8" y1="12" x2="14" y2="12" />
                  <line x1="8" y1="16" x2="14" y2="16" />
                </svg>
                <span className="asm-role-toggle-label">{role ? role.charAt(0).toUpperCase() + role.slice(1) : 'Role'}</span>
                <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className={`asm-chevron${roleOpen ? ' open' : ''}`}>
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
              {roleOpen && (
                <>
                  <div className="asm-role-backdrop" onClick={() => setRoleOpen(false)} />
                  <div className="asm-role-dropdown">
                    {(['coordinator', 'scout', 'builder', 'reviewer'] as const).map((r) => (
                      <button
                        key={r}
                        className={`asm-role-item${role === r ? ' active' : ''}`}
                        data-role={r}
                        onClick={() => {
                          setRole(role === r ? '' : r);
                          setRoleOpen(false);
                        }}
                      >
                        <span className="asm-role-indicator" />
                        <span>{r.charAt(0).toUpperCase() + r.slice(1)}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
            <label className="asm-isolate-toggle" title="When on, the agent runs directly in the project root so git tag, push, and other admin operations work on the main branch">
              <input
                type="checkbox"
                checked={skipWorktree}
                onChange={(e) => setSkipWorktree(e.target.checked)}
              />
              <span className="asm-toggle-label">Main repo</span>
            </label>
          </div>
          <button
            className="asm-confirm-btn"
            onClick={() => void handleSpawnConfirm()}
            disabled={totalSpawnCount === 0 || spawning}
          >
            {spawning ? 'Spawning…' : `Spawn${totalSpawnCount > 0 ? ` ${totalSpawnCount}` : ''}`}
          </button>
        </footer>
      </div>
    </div>
  );
}
