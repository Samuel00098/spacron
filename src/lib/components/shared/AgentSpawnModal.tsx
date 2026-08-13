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
import { requestAgentPlacement, expandSpawnPlan } from '$lib/stores/agentPlacement';

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

  // How these agents will actually launch. Read live rather than stated as a
  // fact, because the mode is a setting: a hardcoded "runs with permissions
  // bypassed" would be a lie the moment someone switches to Manual. `somePinned`
  // is the same divergence check the Agents pane shows its note from — with a
  // per-agent pin in play the mode below is the default, not the whole story.
  const $permissionMode = useStore(agentPermissionMode);
  const $agentDefaultArgs = useStore(agentDefaultArgs);
  const $agentDefaultEnv = useStore(agentDefaultEnv);
  const somePinned = hasCustomizedYoloAgents($permissionMode, {
    agentDefaultArgs: $agentDefaultArgs,
    agentDefaultEnv: $agentDefaultEnv,
  });
  const yolo = $permissionMode === 'yolo';

  const [spawnCounts, setSpawnCounts] = useState<Map<string, number>>(new Map());
  // True only for scans the user kicked off (the Rescan button), so the label
  // stays "Rescan" during quiet background ticks instead of flashing.
  const [rescanning, setRescanning] = useState(false);

  // One-click sign-in: close the picker, then open a terminal running the CLI
  // so the user can complete the login flow there. Shared with the Agents
  // settings pane via `runAgentSignIn`.
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

  // Detection only — the usage dock owns the polling schedule (15 min), but
  // opening the spawn picker is a deliberate "what can I launch right now", so
  // top the scan up once on mount and keep a lightweight tick while the modal
  // is open. A CLI installed *or removed* mid-session then appears (or
  // disappears) without waiting for the next background poll or a manual
  // Rescan. Only sign-in probes are cached in Rust (60s) — the PATH install
  // check is fresh on every scan — but 36 stat calls every 20s is nothing,
  // and `refreshUsage` dedupes in-flight calls.
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
    // Once detection has landed, built-ins are narrowed to the ones actually
    // on PATH; custom agents are always kept (the scan can't know them). Until
    // then — scan in flight, scan failed, or a browser session where no scan
    // exists — `haveDetection` is false and nothing is filtered, rather than
    // hiding agents on a detection hiccup.
    return filterInstalledAgents(all, {
      installedCommands: installedAgentCommands($usage),
      customCommands: new Set($customAgents.map((a) => a.command)),
      haveDetection: haveAgentDetection($usage),
    });
  }, [project, $usage.lastFetchedAt, $usage.detected, $customAgents, $removedPresetAgents]);

  // Detection results keyed by command, for the per-row state badge. Only
  // populated once the scan has run — before that (or in a browser session,
  // where no scan exists) every lookup misses and rows show no badge, which is
  // right because the list itself is unfiltered until detection lands.
  const detectedByCommand = useMemo(() => {
    const map = new Map<string, DetectedAgent>();
    for (const det of $usage.detected) map.set(det.command, det);
    return map;
  }, [$usage.detected]);

  /** First scan still in flight — show that rather than flashing the unfiltered list. */
  const scanning = isTauriRuntime() && $usage.loading && $usage.lastFetchedAt === 0;

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
      ref={asmBackdropRef}
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
            <div className="asm-empty">
              {scanning
                ? 'Scanning for installed agents…'
                : 'No agent CLIs detected on this machine — install one, then hit Rescan below, or add a custom agent in Settings → Agents.'}
            </div>
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
                    <span className="asm-card-name-row">
                      <span className="asm-card-name">{preset.name}</span>
                      {renderStateBadge(
                        detectedByCommand.get(preset.command),
                        preset.id.startsWith('custom:'),
                        preset.name
                      )}
                      {shouldOfferSignIn(detectedByCommand.get(preset.command)) && (
                        // Stop the keydown from bubbling to the card's own
                        // Enter/Space handler, which would swallow this
                        // button's click and toggle the row's selection.
                        <button
                          type="button"
                          className="asm-signin-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            void openSignIn(preset.command, preset.name);
                          }}
                          onKeyDown={(e) => e.stopPropagation()}
                          title={`Run \`${preset.command}\` in a new terminal to sign in, then hit Rescan.`}
                        >
                          <svg
                            width="9"
                            height="9"
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
                    </span>
                    <span className="asm-card-cmd">{preset.command}</span>
                  </div>
                  <div
                    className={`asm-stepper${selected ? ' active' : ''}`}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      className="asm-btn asm-btn-decrement"
                      onClick={() => decrementSpawn(preset.command)}
                      onKeyDown={(e) => e.stopPropagation()}
                      disabled={count === 0}
                      aria-label={`Decrease count for ${preset.name}`}
                    >
                      −
                    </button>
                    <span className="asm-count-value">{count}</span>
                    <button
                      className="asm-btn asm-btn-increment"
                      onClick={() => incrementSpawn(preset.command)}
                      onKeyDown={(e) => e.stopPropagation()}
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
            {/* What the CLI is about to be launched with. The spawn picker is
                the last point before a permission decision takes effect, so the
                mode belongs here and not only three panels away in Settings. */}
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
                <path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5z" />
                {yolo ? <path d="m4 3 16 18" /> : <path d="m9 12 2 2 4-4" />}
              </svg>
              <span className="asm-perm-label">
                {yolo ? 'Yolo — permission prompts bypassed' : 'Manual — agents ask first'}
              </span>
              {somePinned && <span className="asm-perm-note">· some pinned</span>}
            </span>
            {/* The list only shows installed agents once the detection scan has
                run, so a CLI installed *after* the modal opened needs a way to
                be picked up without leaving. `force` bypasses the probe memo
                and re-reads PATH. */}
            {isTauriRuntime() && (
              // If a background tick is mid-flight, refreshUsage dedupes and
              // this click joins the non-forced scan (no fresh probe).
              <button
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

/** While the picker is open, re-scan on this cadence so installs and
 * uninstalls show up without a manual Rescan — Rust caches sign-in probes for
 * 60s and `refreshUsage` dedupes in-flight calls, so this is cheap. */
const SPAWN_MODAL_POLL_MS = 20 * 1000;

/**
 * The small pill under an agent's name. Answers the two questions a row's
 * presence raises — "why is this here?" (it's installed, or it's yours) and
 * "will it just work?" (are you signed in). Mirrors the Agents pane's badge
 * semantics exactly so the picker and the settings tab tell the same story:
 * green = ready to go, amber = installed but sign-in unknown/missing, violet =
 * a custom agent (always shown, nothing to detect).
 */
function renderStateBadge(
  det: DetectedAgent | undefined,
  isCustom: boolean,
  name: string
) {
  if (isCustom) {
    return (
      <span
        className="asm-badge custom"
        title="Custom agent — added by you in Settings → Agents. Spacron can't auto-detect it, so it's always shown here."
      >
        Custom
      </span>
    );
  }
  if (det?.signedIn) {
    return (
      <span
        className="asm-badge"
        data-tone="ready"
        title={`${name} is signed in — ready to spawn.`}
      >
        Signed in
      </span>
    );
  }
  if (det?.installed && !det.detectsSignIn) {
    // Keychain CLIs: `signedIn: false` means "unknown", not "signed out".
    return (
      <span
        className="asm-badge"
        data-tone="partial"
        title="Installed. This CLI keeps its credentials in your system keychain or environment (API keys), so Spacron can't tell whether you're signed in."
      >
        Installed
      </span>
    );
  }
  if (det?.installed) {
    return (
      <span
        className="asm-badge"
        data-tone="partial"
        title={`Installed but no sign-in detected — run \`${det.command}\` once to sign in, then hit Rescan if you already did.`}
      >
        Installed
      </span>
    );
  }
  // Pre-scan / browser: the list is unfiltered and there is no data yet.
  return null;
}
