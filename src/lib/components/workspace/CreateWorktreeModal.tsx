import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { get } from '$lib/stores/storeCompat';
import { remoteConnections, activeRemoteId, connectionStatus, connectRemote, disconnectRemote } from '$lib/stores/remoteWorkspace';
import { useStore } from '$lib/react/useStore';
import { useModalFocus } from '$lib/react/useModalFocus';
import { showToast } from '$lib/stores/notification';
import { activeProjectId, projects } from '$lib/stores/workspace';
import { allProjectSettings, projectConfigFor, projectIconFor, autoDetectProjectIcon } from '$lib/stores/projectSettings';
import { getPresetRuns, filterInstalledAgents } from '$lib/stores/runs';
import { customAgents } from '$lib/stores/customAgents';
import { usageState, installedAgentCommands, haveAgentDetection } from '$lib/stores/usage';
import Dropdown from '$lib/components/shared/Dropdown';
import { ProjectIconBadge } from '$lib/components/shared/ProjectIcons';
import { AgentBrandMark } from '$lib/components/shared/useAgentBrand';
import {
  createProjectWorktree,
  getWorktreeBases,
  orderWorktreeTree,
  type WorktreeBases,
} from '$lib/services/project-worktrees';
import {
  closeCreateWorktree,
  openCreateWorktree,
  createWorktreeRequest,
  refreshProjectWorktrees,
  setActiveWorktree,
  worktreesByProject,
  type WorktreeIssue,
} from '$lib/stores/projectWorktrees';
import { linearIssueReference } from '$lib/services/linear';
import './CreateWorktreeModal.css';

/**
 * Orca's "Create worktree" dialog: name it, pick what to branch from,
 * optionally start an agent in it. Advanced holds the branch name, the sidebar
 * parent, a note and the checkout mode. Ctrl+Enter creates; "Create more" keeps
 * the dialog open for the next one.
 */

const NO_AGENT = '';
const NO_PARENT = '';

/** How the Create From box reads what you type. */
type SourceMode = 'smart' | 'branch' | 'name';

/** Mirrors the backend's slug so the branch placeholder shows what you'll get. */
function branchFromName(name: string): string {
  return name
    .trim()
    .replace(/[^A-Za-z0-9._/-]+/g, '-')
    .replace(/-+/g, '-')
    .split('/')
    .map((part) => part.replace(/^[-._]+|[-._]+$/g, ''))
    .filter(Boolean)
    .join('/')
    .slice(0, 60);
}

function Icon({ children, size = 14 }: { children: ReactNode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

const BranchGlyph = (
  <>
    <circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="8" r="2.5" />
    <path d="M6 8.5v7M18 10.5c0 4-6 3-11 5.5" />
  </>
);
const UpDownGlyph = <path d="m8 9 4-4 4 4M8 15l4 4 4-4" />;

const SOURCE_TABS: Array<{ mode: SourceMode; label: string; icon: ReactNode }> = [
  {
    mode: 'smart',
    label: 'Smart: a new name, or an existing branch',
    icon: <path d="M12 3v3M12 18v3M3 12h3M18 12h3M6.3 6.3l2 2M15.7 15.7l2 2M6.3 17.7l2-2M15.7 8.3l2-2" />,
  },
  { mode: 'branch', label: 'Open an existing branch', icon: BranchGlyph },
  { mode: 'name', label: 'Name only: always a new branch', icon: <><path d="M4 18 8.5 6 13 18M5.7 14h5.6" /><path d="M16 18v-5.5a2.5 2.5 0 0 1 5 0V18M21 15h-3" /></> },
];

const PLACEHOLDERS: Record<SourceMode, string> = {
  smart: 'Type a name or branch',
  branch: 'Search branches',
  name: 'Type a worktree name',
};

export default function CreateWorktreeModal({
  projectId,
  project: requestedProject,
  initialParent,
  issue,
}: {
  projectId: string;
  project?: { id: string; name: string; root_path: string };
  initialParent?: string | null;
  issue?: WorktreeIssue;
}) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);
  useModalFocus(cardRef, closeCreateWorktree);

  const savedRemotes = useStore(remoteConnections);
  const remoteId = useStore(activeRemoteId);
  const [switchingComputer, setSwitchingComputer] = useState(false);
  const projectMap = useStore(projects);
  const projectSettings = useStore(allProjectSettings);
  const allWorktrees = useStore(worktreesByProject);
  const $customAgents = useStore(customAgents);
  const $usage = useStore(usageState);

  const project = projectMap.get(projectId) ?? requestedProject ?? null;
  const preferredBase = project ? projectConfigFor(projectSettings, project.root_path, project.id).worktreeBase : '';
  const worktrees = allWorktrees[projectId] ?? [];
  const projectIcon = project ? projectIconFor(projectSettings, project.root_path, project.id) : null;

  useEffect(() => {
    if (project && !projectIcon) void autoDetectProjectIcon(project.id, project.root_path);
  }, [project?.id, project?.root_path, projectIcon]);

  const [bases, setBases] = useState<WorktreeBases | null>(null);
  const [baseRef, setBaseRef] = useState<string>('');
  const [basePickerOpen, setBasePickerOpen] = useState(false);
  const [baseQuery, setBaseQuery] = useState('');
  const [mode, setMode] = useState<SourceMode>(issue ? 'name' : 'smart');
  const [name, setName] = useState(() => issue ? `${issue.identifier} ${issue.title}`.slice(0, 120) : '');
  const [branch, setBranch] = useState('');
  const [reuseBranch, setReuseBranch] = useState<string | null>(null);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [agent, setAgent] = useState<string>(NO_AGENT);
  const [advancedOpen, setAdvancedOpen] = useState(Boolean(initialParent));
  const [parent, setParent] = useState<string>(initialParent ?? NO_PARENT);
  const [note, setNote] = useState('');
  const [createMore, setCreateMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void refreshProjectWorktrees(projectId);
    getWorktreeBases(projectId)
      .then((result) => {
        if (cancelled) return;
        setBases(result);
      })
      .catch(() => {
        if (!cancelled) setBases({ default_base: 'HEAD', refs: ['HEAD'], local: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const selectedBase = baseRef || (bases?.refs.includes(preferredBase) ? preferredBase : bases?.default_base) || '';

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const agentOptions = useMemo(() => {
    const all = getPresetRuns(projectId).filter((r) => r.isAgent);
    return filterInstalledAgents(all, {
      installedCommands: installedAgentCommands($usage),
      customCommands: new Set($customAgents.map((a) => a.command)),
      haveDetection: haveAgentDetection($usage),
    });
  }, [projectId, $usage, $customAgents]);

  const localBranches = bases?.local ?? [];

  const branchSuggestions = useMemo(() => {
    if (mode === 'name') return [];
    const q = name.trim().toLowerCase();
    if (!q && mode === 'smart') return [];
    const checkedOut = new Set(worktrees.map((w) => w.branch).filter(Boolean));
    return localBranches
      .filter((b) => (!q || b.toLowerCase().includes(q)) && !checkedOut.has(b))
      .slice(0, 8);
  }, [mode, name, localBranches, worktrees]);

  const filteredBases = useMemo(() => {
    const q = baseQuery.trim().toLowerCase();
    const refs = bases?.refs ?? [];
    return (q ? refs.filter((r) => r.toLowerCase().includes(q)) : refs).slice(0, 50);
  }, [bases, baseQuery]);

  const parentOptions = useMemo(
    () => [
      { value: NO_PARENT, label: 'No parent' },
      ...orderWorktreeTree(worktrees)
        .filter(({ worktree }) => !worktree.is_main && !worktree.missing)
        .map(({ worktree, depth }) => ({
          value: worktree.path,
          label: `${'  '.repeat(depth)}${worktree.name}`,
        })),
    ],
    [worktrees],
  );

  const agentLabel = agentOptions.find((a) => a.command === agent)?.name ?? null;

  function pickBranch(b: string) {
    setReuseBranch(b);
    setName(b);
    setSuggestOpen(false);
  }

  function switchMode(next: SourceMode) {
    setMode(next);
    setReuseBranch(null);
    setSuggestOpen(next === 'branch');
    nameRef.current?.focus();
  }

  async function selectComputer(id: string) {
    if (switchingComputer || busy || id === (remoteId ?? 'local')) return;
    setSwitchingComputer(true);
    setError(null);
    try {
      if (id === 'local') {
        await disconnectRemote();
      } else {
        await connectRemote(id);
        if (get(activeRemoteId) !== id || get(connectionStatus) !== 'connected') {
          throw new Error('Could not connect to the selected computer.');
        }
      }
      const targetProjectId = get(activeProjectId);
      if (!targetProjectId) throw new Error('Open a project on the selected computer first.');
      // Reload branch and parent choices for the selected computer's workspace.
      openCreateWorktree(targetProjectId, null, issue);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSwitchingComputer(false);
    }
  }

  async function submit() {
    if (submitting.current || switchingComputer) return;
    const expectedRemote = projectId.startsWith('remote:') ? projectId.slice('remote:'.length) : null;
    if (get(activeRemoteId) !== expectedRemote) {
      setError('The computer connection changed. Select Run on again before creating the worktree.');
      return;
    }
    const trimmed = name.trim();
    if (!trimmed) {
      setError(mode === 'branch' ? 'Pick a branch to open.' : 'Give the worktree a name.');
      nameRef.current?.focus();
      return;
    }
    // In Branch mode the typed text must be a branch you picked.
    const reuse = mode !== 'name' ? (reuseBranch ?? (localBranches.includes(trimmed) ? trimmed : null)) : null;
    if (mode === 'branch' && !reuse) {
      setError(`No local branch named â€œ${trimmed}â€. Pick one from the list, or switch to Name.`);
      return;
    }
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await createProjectWorktree({
        projectId,
        name: trimmed,
        branch: reuse ?? (branch.trim() || null),
        baseRef: reuse ? null : selectedBase || null,
        note: issue ? [linearIssueReference(issue), note.trim()].filter(Boolean).join('\n\n') : note,
        parent: parent || null,
      });
      if (result.warning) showToast(result.warning, 'warning', 6000);
      await refreshProjectWorktrees(projectId);
      setActiveWorktree(projectId, result.worktree.path);
      showToast(`Created worktree ${result.worktree.name} on ${result.worktree.branch ?? 'a detached HEAD'}`, 'success', 3000);

      if (agent) {
        const { quickSpawnAgent } = await import('$lib/services/quick-spawn');
        // Pass the created folder explicitly because the active selection can change.
        const launched = await quickSpawnAgent(agent, {
          projectId,
          worktreePath: result.worktree.path,
          ...(issue ? { prompt: [`Work on Linear issue ${issue.identifier}: ${issue.title}`, issue.url, issue.description]
            .filter(Boolean).join('\n\n') } : {}),
        });
        if (launched === null) showToast('Worktree created. The agent could not start. Open the worktree to try again.', 'warning');
      }

      if (createMore) {
        setName('');
        setBranch('');
        setReuseBranch(null);
        setNote('');
        nameRef.current?.focus();
      } else {
        closeCreateWorktree();
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void submit();
    }
  }

  const showSuggestions = suggestOpen && mode !== 'name' && !reuseBranch && (mode === 'branch' || name.trim().length > 0);

  const modal = (
    <div className="cwt-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) closeCreateWorktree(); }}>
      <div
        ref={cardRef}
        className="cwt-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cwt-title"
        onKeyDown={onKeyDown}
      >
        <div className="cwt-head">
          <h2 id="cwt-title">{issue ? `Create worktree for ${issue.identifier}` : 'Create worktree'}</h2>
          <button type="button" className="cwt-close" onClick={closeCreateWorktree} aria-label="Close">
            <Icon size={15}><path d="M6 6l12 12M18 6L6 18" /></Icon>
          </button>
        </div>

        <div className="cwt-body">
          <div className="cwt-grid-2">
            <div className="cwt-field">
              <div className="cwt-label-row">
                <span className="cwt-label">Project</span>
                <span className="cwt-label-icon" title={project?.root_path} aria-hidden="true">
                  <Icon size={13}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M12 11v5M9.5 13.5h5" /></Icon>
                </span>
              </div>
              <div className="cwt-select is-static" title={project?.root_path}>
                <ProjectIconBadge icon={projectIcon} size={16} />
                <span className="cwt-select-value">{project?.name ?? 'Project'}</span>
              </div>
            </div>
            <div className="cwt-field">
              <span className="cwt-label">Run on</span>
              <Dropdown
                options={[
                  { value: 'local', label: 'This computer' },
                  ...savedRemotes.map((connection) => ({ value: connection.id, label: connection.name })),
                ]}
                value={remoteId ?? 'local'}
                onChange={(value) => { void selectComputer(value); }}
                ariaLabel="Run worktree on"
                disabled={busy || switchingComputer}
              />
              {switchingComputer && <span className="cwt-help" role="status">Connecting to computer?</span>}
            </div>
          </div>

          <div className="cwt-field">
            <div className="cwt-label-row">
              <span className="cwt-label">Create From <em>[Optional]</em></span>
              <div className="cwt-base">
                <button
                  type="button"
                  className="cwt-base-pill"
                  onClick={() => { setBasePickerOpen((o) => !o); setBaseQuery(''); }}
                  disabled={Boolean(reuseBranch)}
                  title={reuseBranch ? 'Opening an existing branch: it keeps its own history' : 'Branch to start from'}
                  aria-expanded={basePickerOpen}
                >
                  <Icon size={12}>{BranchGlyph}</Icon>
                  <span>{reuseBranch ?? (selectedBase || 'â€¦')}</span>
                  <Icon size={11}>{UpDownGlyph}</Icon>
                </button>
                {basePickerOpen && !reuseBranch && (
                  <div className="cwt-popover" role="listbox" aria-label="Base branch">
                    <input
                      className="cwt-input cwt-popover-search"
                      value={baseQuery}
                      onChange={(e) => setBaseQuery(e.target.value)}
                      placeholder="Search branches"
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') { e.stopPropagation(); setBasePickerOpen(false); }
                        if (e.key === 'Enter' && filteredBases[0]) {
                          e.preventDefault();
                          setBaseRef(filteredBases[0]);
                          setBasePickerOpen(false);
                        }
                      }}
                    />
                    <div className="cwt-popover-list">
                      {filteredBases.length === 0 && <div className="cwt-empty">No matching branches.</div>}
                      {filteredBases.map((ref) => (
                        <button
                          key={ref}
                          type="button"
                          role="option"
                          aria-selected={ref === selectedBase}
                          className={`cwt-option${ref === selectedBase ? ' selected' : ''}`}
                          onClick={() => { setBaseRef(ref); setBasePickerOpen(false); }}
                        >
                          {ref}
                          {ref === bases?.default_base && <span className="cwt-option-tag">default</span>}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="cwt-tabs" role="tablist" aria-label="Create from">
              {SOURCE_TABS.map((tab) => (
                <button
                  key={tab.mode}
                  type="button"
                  role="tab"
                  aria-selected={mode === tab.mode}
                  className={`cwt-tab${mode === tab.mode ? ' active' : ''}`}
                  onClick={() => switchMode(tab.mode)}
                  title={tab.label}
                  aria-label={tab.label}
                >
                  <Icon size={14}>{tab.icon}</Icon>
                </button>
              ))}
            </div>

            <div className="cwt-name-wrap">
              <span className="cwt-name-icon" aria-hidden="true">
                <Icon size={15}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></Icon>
              </span>
              <input
                ref={nameRef}
                className="cwt-input cwt-name"
                value={name}
                onChange={(e) => { setName(e.target.value); setReuseBranch(null); setSuggestOpen(true); setError(null); }}
                onFocus={() => setSuggestOpen(true)}
                onBlur={() => window.setTimeout(() => setSuggestOpen(false), 120)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); void submit(); }
                }}
                placeholder={PLACEHOLDERS[mode]}
                aria-label="Worktree name"
                spellCheck={false}
              />
              {showSuggestions && (
                <div className="cwt-suggest" role="listbox">
                  {mode === 'smart' && (
                    <button
                      type="button"
                      className="cwt-option"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => setSuggestOpen(false)}
                    >
                      <Icon size={13}><path d="M12 5v14M5 12h14" /></Icon>
                      Create new branch <strong>{branch.trim() || branchFromName(name) || name.trim()}</strong>
                    </button>
                  )}
                  {branchSuggestions.map((b) => (
                    <button
                      key={b}
                      type="button"
                      className="cwt-option"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => pickBranch(b)}
                    >
                      <Icon size={13}>{BranchGlyph}</Icon>
                      <strong>{b}</strong>
                    </button>
                  ))}
                  {mode === 'branch' && branchSuggestions.length === 0 && (
                    <div className="cwt-empty">No matching branches.</div>
                  )}
                </div>
              )}
            </div>
            {reuseBranch && (
              <div className="cwt-hint">
                Opens the existing branch <strong>{reuseBranch}</strong> in a new worktree.{' '}
                <button type="button" className="cwt-link" onClick={() => { setReuseBranch(null); setMode('smart'); }}>
                  Create a new branch instead
                </button>
              </div>
            )}
          </div>

          <div className="cwt-field">
            <span className="cwt-label">Agent <em>[Optional]</em></span>
            {(
              <div className={`cwt-agent-row${agent ? ' has-agent' : ''}`}>
                {agent && (
                  <span className="cwt-agent-mark">
                    <AgentBrandMark command={agent} name={agentLabel ?? agent} />
                  </span>
                )}
                <Dropdown
                  options={[
                    { value: NO_AGENT, label: 'No agent' },
                    ...agentOptions.map((a) => ({ value: a.command, label: a.name })),
                  ]}
                  value={agent}
                  onChange={setAgent}
                  ariaLabel="Agent to start in the new worktree"
                />
              </div>
            )}
          </div>

          <div className="cwt-advanced-block">
            <button
              type="button"
              className={`cwt-advanced-toggle${advancedOpen ? ' open' : ''}`}
              onClick={() => setAdvancedOpen((o) => !o)}
              aria-expanded={advancedOpen}
            >
              Advanced
              <Icon size={12}><path d="m6 15 6-6 6 6" /></Icon>
            </button>

            {advancedOpen && (
              <div className="cwt-advanced">
                <label className="cwt-field">
                  <span className="cwt-label">Branch name</span>
                  <input
                    className="cwt-input"
                    value={reuseBranch ?? branch}
                    onChange={(e) => { setBranch(e.target.value); setReuseBranch(null); }}
                    placeholder={branchFromName(name) || 'feature/my-branch'}
                    spellCheck={false}
                    disabled={Boolean(reuseBranch)}
                  />
                </label>
                <div className="cwt-field">
                  <span className="cwt-label">Parent worktree</span>
                  <div className="cwt-updown-select">
                    <Dropdown options={parentOptions} value={parent} onChange={setParent} ariaLabel="Parent worktree" />
                  </div>
                  <span className="cwt-help">Nests this worktree under another in the sidebar. Does not change the base branch.</span>
                </div>
                <label className="cwt-field">
                  <span className="cwt-label">Note</span>
                  <input
                    className="cwt-input"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="Write a note"
                  />
                </label>
                <div className="cwt-field">
                  <span className="cwt-label">Sparse checkout</span>
                  <div className="cwt-select is-static" title="Every file is checked out">
                    <span className="cwt-select-value">Full checkout</span>
                  </div>
                </div>
              </div>
            )}
          </div>

          {error && <div className="cwt-error" role="alert">{error}</div>}
        </div>

        <div className="cwt-foot">
          {!issue && (
            <label className="cwt-toggle">
              <input type="checkbox" checked={createMore} onChange={(e) => setCreateMore(e.target.checked)} />
              <span className="cwt-switch" aria-hidden="true" />
              Create more
            </label>
          )}
          <button
            type="button"
            className="cwt-create"
            style={issue ? { marginLeft: 'auto' } : undefined}
            onClick={() => void submit()}
            disabled={busy || switchingComputer || !name.trim()}
          >
            {busy ? 'Creatingâ€¦' : 'Create'}
            <kbd>Ctrl â†µ</kbd>
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}

export function CreateWorktreeDialog() {
  const request = useStore(createWorktreeRequest);
  if (!request) return null;
  return (
    <CreateWorktreeModal
      key={`${request.projectId}:${request.parent ?? ''}:${request.issue?.id ?? ''}`}
      projectId={request.projectId}
      project={request.project}
      initialParent={request.parent}
      issue={request.issue}
    />
  );
}
