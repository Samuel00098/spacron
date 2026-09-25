import { useEffect, useMemo, useState } from 'react';
import { useStore } from '$lib/react/useStore';
import { AgentBrandMark } from '$lib/components/shared/useAgentBrand';
import { usageState, refreshUsage, PANEL_POLL_INTERVAL_MS, type DetectedAgent } from '$lib/stores/usage';
import { activeProject } from '$lib/stores/workspace';
import { closeSettings } from '$lib/stores/layout';
import { layoutSnapshot } from '$lib/stores/layoutControl';
import { showToast } from '$lib/stores/notification';
import { runAgentSignIn, shouldOfferSignIn } from '$lib/services/agent-signin';
import { installDocsFor, openAgentInstallDocs } from '$lib/services/agent-install';
import { getAgentPresetCatalog } from '$lib/stores/runs';
import {
  customAgents,
  removedPresetAgents,
  restorePresetAgent,
  removePresetAgent,
} from '$lib/stores/customAgents';
import {
  agentPermissionMode,
  agentCmdOverrides,
  agentDefaultArgs,
  agentDefaultEnv,
  type AgentPermissionMode,
} from '$lib/stores/settings';
import {
  resolveAgentLaunchArgs,
  resolveAgentLaunchEnv,
  resolveAgentLaunchCommand,
  effectiveAgentMode,
  setAgentPermissionMode,
  hasCustomizedYoloAgents,
  isYoloCapable,
  yoloArgsFor,
  yoloEnvFor,
} from '$lib/services/agent-permissions';
import { agentReadsRulesFile } from '$lib/services/orchestrator/agent-rules-file';
import LiveTicker from '$lib/components/shared/LiveTicker';
import AgentUpdateButton, { useAgentUpdating } from '$lib/components/shared/AgentUpdateButton';
import { refreshAgentUpdatesIfStale } from '$lib/stores/agentUpdates';
import './AgentsPane.css';

type AgentRow = {
  command: string;
  name: string;
  /** Preset from the built-in catalog (as opposed to a user-added agent). */
  isBuiltin: boolean;
  hidden: boolean;
  /** Why this preset launches a non-obvious command or brief channel. */
  note?: string;
  detected?: DetectedAgent;
};

/**
 * Settings → Agents. The whole tab in one place:
 *
 *  - **Permission mode** — the Orca-style global Yolo / Manual control, plus a
 *    per-agent Yolo / Manual toggle on every row for pinning one CLI away from
 *    the global default.
 *  - **Roster** — every known agent (detected or not) and every custom agent,
 *    each showing install/sign-in state, a hide/show switch, and an expandable
 *    launch editor for per-agent command / args / env.
 *
 * Detection state comes from `usageState.detected` (the Rust side scans PATH and
 * credential files, exactly like the old "Detected on this machine" table).
 * Rate-limit meters deliberately do *not* appear here: the usage dock in the
 * workspace corner and its panel already answer "how much have I got left", and
 * settings is where agents are configured, not monitored. Duplicating the meters
 * made this pane a second, worse copy of that panel.
 */
export default function AgentsPane() {
  const { detected, loading, lastFetchedAt } = useStore(usageState);
  const project = useStore(activeProject);
  const layout = useStore(layoutSnapshot);
  const isDev = layout.ambient === 'development';
  const $customAgents = useStore(customAgents);
  const $removedPresetAgents = useStore(removedPresetAgents);
  const $agentPermissionMode = useStore(agentPermissionMode);
  const $agentCmdOverrides = useStore(agentCmdOverrides);
  const $agentDefaultArgs = useStore(agentDefaultArgs);
  const $agentDefaultEnv = useStore(agentDefaultEnv);

  // Expandable per-agent launch editor.
  const [expandedCommand, setExpandedCommand] = useState<string | null>(null);

  // Detection only — the usage dock owns the polling schedule. Opening settings
  // is a deliberate "show me what I've got installed", so top it up once here
  // rather than starting a second timer behind a tab nobody is looking at.
  useEffect(() => {
    void refreshUsage();
  }, []);

  // Update checks need detection's installed list, so they follow each scan
  // (gated to one registry round trip per half hour inside the store).
  useEffect(() => {
    refreshAgentUpdatesIfStale();
  }, [lastFetchedAt]);

  // Detection state refreshes itself while the tab is open — no Rescan button.
  // Same 30s cadence as the usage panel; `refreshUsage` dedupes in-flight calls.
  // The usage numbers do move every tick (`CACHE_TTL` is 30s), but detection
  // does not: `PROBE_TTL` stays at 60s deliberately, because a probe shells out
  // to `<cli> auth status` and sign-in state does not change twice a minute.
  useEffect(() => {
    const id = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void refreshUsage();
    }, PANEL_POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  const overrides = {
    agentCmdOverrides: $agentCmdOverrides,
    agentDefaultArgs: $agentDefaultArgs,
    agentDefaultEnv: $agentDefaultEnv,
  };
  const customized = hasCustomizedYoloAgents($agentPermissionMode, overrides);

  // One-click sign-in, same action as the spawn picker: guard first (don't
  // close Settings over nothing), then close settings so the terminal it opens
  // is visible, then run the CLI via the shared service.
  const handleSignIn = (command: string, name: string) => {
    const cwd = project?.root_path;
    const projectId = project?.id;
    if (!cwd || !projectId) {
      showToast('Open a project first to sign in to an agent', 'warning');
      return;
    }
    closeSettings();
    void runAgentSignIn({ command, name, cwd, projectId, isDev });
  };

  const rows = useMemo<AgentRow[]>(() => {
    const map = new Map<string, AgentRow>();

    for (const preset of getAgentPresetCatalog()) {
      map.set(preset.command, {
        command: preset.command,
        name: preset.name,
        isBuiltin: true,
        hidden: $removedPresetAgents.includes(preset.command),
        note: preset.note,
      });
    }
    for (const agent of $customAgents) {
      map.set(agent.command, {
        command: agent.command,
        name: agent.name,
        isBuiltin: false,
        hidden: false,
      });
    }
    // Detection may know agents the catalog doesn't (newly added CLIs); fold
    // them in rather than dropping them from the list.
    for (const det of detected) {
      const existing = map.get(det.command);
      if (existing) {
        existing.detected = det;
        existing.name = det.name || existing.name;
      } else {
        map.set(det.command, {
          command: det.command,
          name: det.name,
          isBuiltin: true,
          hidden: false,
          detected: det,
        });
      }
    }
    const rank = (row: AgentRow) => {
      if (row.hidden) return 4;
      if (row.detected?.signedIn) return 0;
      if (row.detected?.installed) return 1;
      if (row.detected) return 2;
      return 3;
    };
    return [...map.values()].sort(
      (a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)
    );
  }, [detected, $customAgents, $removedPresetAgents]);

  const installedCount = detected.filter((agent) => agent.installed).length;

  return (
    <div className="agents-pane">
      {/* ── Permission mode ─────────────────────────────────────────────── */}
      <div className="agents-mode">
        <div className="agents-mode-copy">
          <span className="agents-mode-title">Agent permissions</span>
          <span className="agents-mode-detail">
            <strong>Yolo</strong> launches every agent with its own skip-permissions
            flag (Claude's <code>--dangerously-skip-permissions</code>, Codex's{' '}
            <code>--dangerously-bypass-approvals-and-sandbox</code>, Gemini's{' '}
            <code>--yolo</code>, …) so runs never stall on a permission prompt.
            <strong>Manual</strong> launches agents bare and they ask as usual. Use the
            toggle on each row to pin one agent to the other mode.
            {customized && (
              <em className="agents-mode-customized">
                Some agents below have custom launch arguments and won't follow this toggle.
              </em>
            )}
          </span>
        </div>
        <div className="agents-mode-control" role="radiogroup" aria-label="Agent permission mode">
          {(['yolo', 'manual'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={$agentPermissionMode === mode}
              className={`agents-mode-segment${$agentPermissionMode === mode ? ' active' : ''}`}
              onClick={() => agentPermissionMode.set(mode)}
            >
              {mode === 'yolo' ? 'Yolo' : 'Manual'}
            </button>
          ))}
        </div>
      </div>

      {/* ── Roster ──────────────────────────────────────────────────────── */}
      {/* Header and list are one block: the count is a caption for the list, so
          it sits closer to it than the pane's own section spacing allows. */}
      <div className="agents-roster-block">
        <div className="agents-roster-head">
          <p className="agents-roster-hint">
            {lastFetchedAt === 0
              ? 'Looking for agent CLIs on this machine…'
              : `${installedCount} of ${detected.length} known agent CLIs found on your PATH. ` +
                'Hide the ones you never use, or open a row to change how it launches.'}
          </p>
          <LiveTicker
            intervalMs={PANEL_POLL_INTERVAL_MS}
            lastFetchedAt={lastFetchedAt}
            refreshing={loading}
            labelOnly
          />
        </div>

        <ul className="agents-roster">
          {rows.map((row) => (
            <AgentRowView
              key={row.command}
              row={row}
              mode={$agentPermissionMode}
              overrides={overrides}
              expanded={expandedCommand === row.command}
              onToggleExpand={() =>
                setExpandedCommand((cur) => (cur === row.command ? null : row.command))
              }
              onSignIn={handleSignIn}
            />
          ))}
        </ul>
      </div>
    </div>
  );
}

function AgentRowView({
  row,
  mode,
  overrides,
  expanded,
  onToggleExpand,
  onSignIn,
}: {
  row: AgentRow;
  mode: AgentPermissionMode;
  overrides: {
    agentCmdOverrides: Record<string, string>;
    agentDefaultArgs: Record<string, string>;
    agentDefaultEnv: Record<string, Record<string, string>>;
  };
  expanded: boolean;
  onToggleExpand: () => void;
  onSignIn: (command: string, name: string) => void;
}) {
  const yoloCapable = isYoloCapable(row.command);
  const effectiveArgs = resolveAgentLaunchArgs(row.command, mode, overrides);
  const effectiveCmd = resolveAgentLaunchCommand(row.command, overrides);
  // Which side of the per-row toggle is active. Only shown for CLIs that have a
  // bypass; 'custom' (a bespoke args/env override) leaves neither side lit.
  const rowMode = effectiveAgentMode(row.command, mode, overrides);
  // "Not detected" (no entry in the detection table) and "Not installed" (an
  // entry that found nothing on PATH) are the same problem for the user, and
  // both are fixed by the same page. A hidden row is neither — it is a
  // deliberate choice, and offering to install it would be noise.
  const notInstalled = !row.hidden && !row.detected?.installed;
  const installDocs = installDocsFor(row.command, row.name);
  const updating = useAgentUpdating(row.command);

  // The clicked segment always becomes the active one — a toggle that flips to
  // the *other* mode when you click the one already lit reads as broken, which
  // is exactly what "click the active segment to unpin" used to do.
  //
  // Unpinning still happens, just without surprising anyone: choosing the mode
  // the global toggle is already on clears the per-agent override instead of
  // writing one that merely restates it. Either way the row ends up showing
  // what was clicked, and the override maps stay free of redundant entries (so
  // the "some agents customized" note stays honest, and a later flip of the
  // global toggle still moves this row).
  const setRowMode = (target: 'yolo' | 'manual') => {
    if (target === mode) {
      agentDefaultArgs.update((map) => {
        if (!(row.command in map)) return map;
        const next = { ...map };
        delete next[row.command];
        return next;
      });
      agentDefaultEnv.update((map) => {
        if (!(row.command in map)) return map;
        const next = { ...map };
        delete next[row.command];
        return next;
      });
      return;
    }
    setAgentPermissionMode(row.command, target, {
      agentDefaultArgs,
      agentDefaultEnv,
    });
  };

  return (
    <li className={`agents-row${row.hidden ? ' hidden' : ''}`} data-installed={row.detected?.installed ? 'true' : 'false'}>
      <div className={`agents-row-main${updating ? ' agent-updating' : ''}`} aria-busy={updating || undefined}>
        <span className="agents-row-mark" aria-hidden="true">
          <AgentBrandMark command={row.command} name={row.name} />
        </span>

        <div className="agents-row-meta">
          <div className="agents-row-name-row">
            <span className="agents-row-name" title={row.note}>{row.name}</span>
            {row.isBuiltin ? (
              <span className="agents-row-badge">Built-in</span>
            ) : (
              <span className="agents-row-badge custom">Custom</span>
            )}
            {!row.hidden && row.detected?.installed && (
              <AgentUpdateButton command={row.command} name={row.name} />
            )}
          </div>
          <div className="agents-row-cmd-line">
            <code className="agents-row-cmd">{row.command}</code>
          </div>
        </div>

        <div className="agents-row-state">
          {row.hidden ? (
            <button
              type="button"
              className="agents-row-restore"
              onClick={() => restorePresetAgent(row.command)}
            >
              Add back
            </button>
          ) : !row.detected ? (
            <span className="agents-row-badge" data-tone="absent">
              Not detected
            </span>
          ) : !row.detected.installed ? (
            <span className="agents-row-badge" data-tone="absent">
              Not installed
            </span>
          ) : row.detected.signedIn ? (
            <span className="agents-row-badge" data-tone="ready">
              Signed in
            </span>
          ) : !row.detected.detectsSignIn ? (
            // Keychain CLIs: `signedIn: false` means "unknown", not "signed
            // out". Saying "Installed" and explaining why on hover is the only
            // honest reading — see [[agent-usage-meters]].
            <span
              className="agents-row-badge"
              data-tone="partial"
              title="Installed. This CLI keeps its credentials in your system keychain or environment (API keys), so Spacron can't tell whether you're signed in."
            >
              Installed
            </span>
          ) : (
            <span
              className="agents-row-badge"
              data-tone="partial"
              title={`Installed but no sign-in detected. Run \`${row.command}\` once to sign in, then hit Rescan if you already did.`}
            >
              Installed
            </span>
          )}
          {/* A row for a CLI that isn't on this machine used to end at a grey
              badge naming a tool with no hint of where it comes from. The link
              says which of the two it is — the vendor's own docs, or a search
              standing in for docs we don't have a verified URL for. */}
          {notInstalled && (
            <button
              type="button"
              className="agents-install-btn"
              onClick={() => {
                // The docs open in the preview panel, which the settings modal
                // covers — same reason the sign-in handler closes it first.
                closeSettings();
                void openAgentInstallDocs(row.command, row.name);
              }}
              title={
                installDocs.known
                  ? `Open ${row.name}'s documentation to install it`
                  : `Spacron has no verified docs URL for ${row.name}, so this searches the web for its install steps`
              }
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
                <path d="M12 3v12" />
                <path d="m7 12 5 5 5-5" />
                <path d="M4 20h16" />
              </svg>
              {installDocs.known ? 'How to install' : 'Find install steps'}
            </button>
          )}
          {/* Same one-click sign-in as the spawn picker — only where detection
              knows credentials are missing (keychain CLIs excluded). */}
          {shouldOfferSignIn(row.detected) && (
            <button
              type="button"
              className="agents-signin-btn"
              onClick={() => onSignIn(row.command, row.name)}
              title={`Run \`${row.command}\` in a new terminal to sign in, then hit Rescan.`}
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
        </div>

        <div className="agents-row-actions">
          {!row.hidden && yoloCapable && (
            <div
              className="agents-row-mode"
              role="radiogroup"
              aria-label={`Permission mode for ${row.name}`}
            >
              {(['yolo', 'manual'] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={rowMode === option}
                  className={`agents-row-mode-segment${rowMode === option ? ' active' : ''}`}
                  onClick={() => setRowMode(option)}
                  title={
                    option === mode
                      ? `Let ${row.name} follow the global mode (${option})`
                      : `Pin ${row.name} to ${option} (overrides the global mode)`
                  }
                >
                  {option === 'yolo' ? 'Yolo' : 'Manual'}
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            className={`agents-expand${expanded ? ' open' : ''}`}
            onClick={onToggleExpand}
            aria-expanded={expanded}
            aria-label={`Launch options for ${row.name}`}
            title="Launch options"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
          {row.isBuiltin ? (
            <button
              type="button"
              className="agents-hide"
              onClick={() => removePresetAgent(row.command)}
              aria-label={`Hide ${row.name}`}
              title={row.hidden ? 'Show again' : 'Hide this agent'}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M3 6h18M8 6V4h8v2m-1 0v14H9V6" />
              </svg>
            </button>
          ) : null}
        </div>
      </div>

      {expanded && !row.hidden && (
        <LaunchEditor
          row={row}
          mode={mode}
          overrides={overrides}
          yoloCapable={yoloCapable}
          effectiveCmd={effectiveCmd}
          effectiveArgs={effectiveArgs}
        />
      )}
    </li>
  );
}

function LaunchEditor({
  row,
  mode,
  overrides,
  yoloCapable,
  effectiveCmd,
  effectiveArgs,
}: {
  row: AgentRow;
  mode: AgentPermissionMode;
  overrides: {
    agentCmdOverrides: Record<string, string>;
    agentDefaultArgs: Record<string, string>;
    agentDefaultEnv: Record<string, Record<string, string>>;
  };
  yoloCapable: boolean;
  effectiveCmd: string;
  effectiveArgs: string;
}) {
  // How this agent receives its standing brief — a native rules file the CLI
  // reads at startup, or the charter pasted into the terminal on spawn. Shown
  // in the editor rather than on every row: it is per-agent configuration,
  // only needed when a row is open.
  const readsRulesFile = agentReadsRulesFile(row.command);

  const [cmd, setCmd] = useState(overrides.agentCmdOverrides[row.command] ?? '');
  const [args, setArgs] = useState(overrides.agentDefaultArgs[row.command] ?? '');
  const [envText, setEnvText] = useState(
    Object.entries(overrides.agentDefaultEnv[row.command] ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join('\n')
  );

  const yoloFlag = yoloArgsFor(row.command);
  const yoloEnv = yoloEnvFor(row.command);
  const effectiveEnv = resolveAgentLaunchEnv(row.command, mode, overrides);

  // Persist immediately: clearing the store keys returns this agent to whatever
  // the global mode says, which is what "Reset to global" promises.
  const clearStoredOverrides = () => {
    agentCmdOverrides.update((map) => {
      if (!(row.command in map)) return map;
      const next = { ...map };
      delete next[row.command];
      return next;
    });
    agentDefaultArgs.update((map) => {
      if (!(row.command in map)) return map;
      const next = { ...map };
      delete next[row.command];
      return next;
    });
    agentDefaultEnv.update((map) => {
      if (!(row.command in map)) return map;
      const next = { ...map };
      delete next[row.command];
      return next;
    });
  };

  const resetToGlobal = () => {
    setCmd('');
    setArgs('');
    setEnvText('');
    clearStoredOverrides();
  };

  const save = () => {
    agentCmdOverrides.update((map) => {
      const next = { ...map };
      const trimmed = cmd.trim();
      if (trimmed) next[row.command] = trimmed;
      else delete next[row.command];
      return next;
    });
    agentDefaultArgs.update((map) => {
      const next = { ...map };
      const trimmed = args.trim();
      if (trimmed) next[row.command] = trimmed;
      else delete next[row.command];
      return next;
    });
    agentDefaultEnv.update((map) => {
      const next = { ...map };
      const parsed: Record<string, string> = {};
      for (const line of envText.split('\n')) {
        const eq = line.indexOf('=');
        if (eq <= 0) continue;
        const key = line.slice(0, eq).trim();
        const value = line.slice(eq + 1).trim();
        if (key) parsed[key] = value;
      }
      if (Object.keys(parsed).length) next[row.command] = parsed;
      else delete next[row.command];
      return next;
    });
  };

  // Rendered as JSX, not innerHTML: effectiveCmd/effectiveArgs are user-editable
  // launch overrides, and interpolating them into an HTML string would let an
  // override double as markup.
  const envEntries = Object.entries(effectiveEnv)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
  const launchNote = !yoloCapable ? (
    "This CLI doesn't expose a skip-permissions flag, so it launches bare either way."
  ) : effectiveArgs ? (
    <>
      Launches as: <code>
        {effectiveCmd} {effectiveArgs}
      </code>
    </>
  ) : envEntries ? (
    // Env-only bypasses (Goose's GOOSE_MODE=auto): there are no args to show,
    // but it isn't "bare" either — the env does the work.
    <>
      Launches with <code>{envEntries}</code> in the environment
    </>
  ) : (
    'Launches bare in manual mode.'
  );

  return (
    <div className="agents-editor">
      <p className="agents-editor-note">{launchNote}</p>
      <p className="agents-editor-brief">
        <span
          className="agents-row-brief"
          data-brief={readsRulesFile ? 'rules' : 'paste'}
          title={
            readsRulesFile
              ? 'Briefed through the instruction file(s) this CLI reads at startup. Spacron writes its standing brief there instead of pasting it into the terminal.'
              : 'Briefed by pasting the standing charter into the terminal when it spawns, because this CLI has no native rules file.'
          }
        >
          {readsRulesFile ? 'Rules file' : 'Pasted brief'}
        </span>
      </p>
      {yoloFlag && (
        <p className="agents-editor-hint">
          This CLI's native bypass: <code>{yoloFlag}</code>
          {Object.keys(yoloEnv).length > 0 &&
            ` (or ${Object.entries(yoloEnv)
              .map(([k, v]) => `${k}=${v}`)
              .join(', ')} in the env)`}
        </p>
      )}

      <div className="agents-editor-grid">
        <label className="agents-editor-field">
          <span>Command override</span>
          <input
            type="text"
            value={cmd}
            onChange={(e) => setCmd(e.target.value)}
            placeholder={row.command}
            spellCheck={false}
          />
        </label>
        <label className="agents-editor-field">
          <span>Launch arguments</span>
          <input
            type="text"
            value={args}
            onChange={(e) => setArgs(e.target.value)}
            placeholder={mode === 'yolo' && yoloFlag ? yoloFlag : 'Follow global mode'}
            spellCheck={false}
          />
        </label>
        <label className="agents-editor-field agents-editor-env">
          <span>Environment (KEY=VALUE per line)</span>
          <textarea
            value={envText}
            onChange={(e) => setEnvText(e.target.value)}
            placeholder={mode === 'yolo' && Object.keys(yoloEnv).length ? `${Object.entries(yoloEnv).map(([k, v]) => `${k}=${v}`).join('\n')}` : ''}
            rows={2}
            spellCheck={false}
          />
        </label>
      </div>

      <div className="agents-editor-actions">
        <button type="button" className="agents-editor-btn" onClick={save}>
          Save for this agent
        </button>
        <button type="button" className="agents-editor-btn ghost" onClick={resetToGlobal}>
          Reset to global
        </button>
        <span className="agents-editor-footnote">
          Empty values follow the global mode above.
        </span>
      </div>
    </div>
  );
}
