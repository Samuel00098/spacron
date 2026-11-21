/**
 * Agent History: past sessions of Claude, Codex and OpenCode, read from each
 * CLI's own transcripts (Orca's "Agent Session History"). It lists, resumes and
 * hands over; it never edits or deletes the CLI's files. Lives as a tab of the
 * Fleet dashboard, whose Live tab keeps the review/merge/discard workflow.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '$lib/react/useStore';
import { activeProject, projects as projectsStore, switchToProject } from '$lib/stores/workspace';
import { worktreesByProject } from '$lib/stores/projectWorktrees';
import { accountsState, refreshAccounts, selectAccount } from '$lib/stores/agentAccounts';
import { showToast } from '$lib/stores/notification';
import { quickSpawnAgent } from '$lib/services/quick-spawn';
import HistoryBrand from './HistoryBrand.tsx';
import HandoffHistoryModal from './HandoffHistoryModal.tsx';
import {
  HISTORY_AGENTS,
  filterHistory,
  folderName,
  groupHistory,
  isInside,
  loadAgentHistory,
  resumeCommand,
  rowTitle,
  sessionAccountLabel,
  timeAgo,
  type HistoryAgent,
  type HistoryGroup,
  type HistoryProject,
  type HistoryRow,
  type HistoryScope,
  type HistorySort,
} from '$lib/services/agent-history';
import './AgentHistoryTab.css';

interface Prefs {
  scope: HistoryScope;
  group: HistoryGroup;
  sort: HistorySort;
  agents: HistoryAgent[];
  hideEmpty: boolean;
}

// Kept across tab switches within a run; the panel remounts when Fleet's tab changes.
let lastPrefs: Prefs = { scope: 'project', group: 'project', sort: 'updated', agents: HISTORY_AGENTS.map((a) => a.id), hideEmpty: true };

const rowKey = (row: HistoryRow) => `${row.agent}:${row.id}`;

const COLLAPSED_KEY = 'spacron_history_collapsed_groups';

function loadCollapsed(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(COLLAPSED_KEY) ?? '[]');
    return new Set(Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : []);
  } catch {
    return new Set();
  }
}

function saveCollapsed(keys: Set<string>) {
  try {
    window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...keys]));
  } catch {
    // Restricted storage: the groups simply open again next run.
  }
}

function copy(text: string, what: string) {
  void navigator.clipboard?.writeText(text).then(() => showToast(`Copied ${what}`, 'success')).catch(() => showToast(`Couldn't copy ${what}`, 'warning'));
}

const Check = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <path d="m2.5 6.2 2.3 2.3 4.7-5" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export default function AgentHistoryTab() {
  const project = useStore(activeProject);
  const allProjects = useStore(projectsStore);
  const worktrees = useStore(worktreesByProject);
  const accounts = useStore(accountsState);
  const [rows, setRows] = useState<HistoryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [prefs, setPrefsState] = useState<Prefs>(lastPrefs);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed);
  const [handoffRow, setHandoffRow] = useState<HistoryRow | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const setPrefs = (patch: Partial<Prefs>) => setPrefsState((current) => (lastPrefs = { ...current, ...patch }));

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(await loadAgentHistory());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    void refreshAccounts();
  }, [refresh]);

  // The view-options menu closes on an outside click or Escape.
  useEffect(() => {
    if (!menuOpen) return undefined;
    const onDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const roots = useMemo(() => {
    if (!project) return [];
    return [project.root_path, ...(worktrees[project.id] ?? []).map((w) => w.path)].filter(Boolean);
  }, [project, worktrees]);

  const projectList = useMemo<(HistoryProject & { id: string })[]>(
    () => [...allProjects.values()]
      .filter((p) => p.root_path)
      .map((p) => ({ id: p.id, name: p.name, roots: [p.root_path, ...(worktrees[p.id] ?? []).map((w) => w.path)] })),
    [allProjects, worktrees],
  );

  /** Terminals can only open inside the open project, so a session from elsewhere cannot be resumed from here. */
  const resumable = (row: HistoryRow) => isInside(row.cwd, roots);
  const owningProject = (row: HistoryRow) => projectList.find((p) => isInside(row.cwd, p.roots)) ?? null;

  const shown = useMemo(
    () => filterHistory(rows ?? [], { scope: prefs.scope, roots, agents: prefs.agents, query, hideEmpty: prefs.hideEmpty, sort: prefs.sort }),
    [rows, prefs, roots, query],
  );
  const groups = useMemo(
    () => groupHistory(shown, prefs.group, projectList, accounts.accounts),
    [shown, prefs.group, projectList, accounts.accounts],
  );
  // While searching, every group stays open so a match is never hidden inside a folded one.
  const searching = query.trim().length > 0;
  const isCollapsed = (key: string) => !searching && collapsed.has(key);

  function toggleGroup(key: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      saveCollapsed(next);
      return next;
    });
  }

  function setAllGroups(fold: boolean) {
    const next = fold ? new Set(groups.map((g) => g.key)) : new Set<string>();
    saveCollapsed(next);
    setCollapsed(next);
  }

  async function resume(row: HistoryRow, view: 'terminal' | 'chat') {
    const agent = HISTORY_AGENTS.find((a) => a.id === row.agent);
    if (!agent) return;
    if (!row.cwd) {
      showToast('This session has no folder recorded, so it cannot be resumed here.', 'warning');
      return;
    }
    if (!resumable(row)) {
      showToast("This session's folder is outside the open project. Open that project to resume it.", 'warning');
      return;
    }
    const activeAcct = accounts.accounts.find((a) => a.provider === row.agent && a.active);
    const currentActiveId = activeAcct?.id ?? 'default';
    const sessionAccountId = row.account ?? 'default';
    if ((row.agent === 'claude' || row.agent === 'codex') && sessionAccountId !== currentActiveId) {
      const sessionAcctName = sessionAccountLabel(row, accounts.accounts) ?? sessionAccountId;
      const activeAcctName = activeAcct?.label ?? currentActiveId;
      showToast(
        `This session is in account "${sessionAcctName}", but the active account is "${activeAcctName}". Switch accounts to resume it.`,
        'warning',
      );
      return;
    }
    setBusy(rowKey(row));
    try {
      // A session only exists in the home of the account that wrote it, so it resumes under that account.
      await quickSpawnAgent(agent.command, { view, resumeId: row.id, worktreePath: row.cwd, accountId: row.account ?? 'default', title: view === 'chat' ? rowTitle(row) : undefined });
    } finally {
      setBusy(null);
    }
  }

  function toggleAgent(id: HistoryAgent) {
    setPrefs({ agents: prefs.agents.includes(id) ? prefs.agents.filter((a) => a !== id) : [...prefs.agents, id] });
  }

  function renderRow(row: HistoryRow) {
    const key = rowKey(row);
    const expanded = open === key;
    const agent = HISTORY_AGENTS.find((a) => a.id === row.agent);
    const accountText = sessionAccountLabel(row, accounts.accounts);
    const activeAcct = accounts.accounts.find((a) => a.provider === row.agent && a.active);
    const currentActiveId = activeAcct?.id ?? 'default';
    const sessionAccountId = row.account ?? 'default';
    const isDifferentAccount = (row.agent === 'claude' || row.agent === 'codex') && sessionAccountId !== currentActiveId;
    const sessionAcctName = accountText ?? sessionAccountId;
    const activeAcctName = activeAcct?.label ?? currentActiveId;
    return (
      <li key={key} className={`ah-row${expanded ? ' is-open' : ''}`}>
        <div className="ah-row-main">
          <button type="button" className="ah-row-toggle" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : key)}>
            <HistoryBrand command={agent?.command ?? row.agent} name={agent?.label ?? row.agent} />
            <span className="ah-row-text">
              <span className="ah-row-title">{rowTitle(row)}</span>
              <span className="ah-row-meta">
                {[folderName(row.cwd), row.branch, row.model, accountText, row.messageCount > 0 ? `${row.messageCount} msgs` : null].filter(Boolean).join(' · ')}
              </span>
            </span>
            <span className="ah-row-time" title={new Date(row.updatedMs).toLocaleString()}>{timeAgo(row.updatedMs)}</span>
          </button>
          <button
            type="button"
            className="ah-btn ah-btn-sm"
            aria-expanded={expanded}
            onClick={() => setOpen(expanded ? null : key)}
            title={expanded ? 'Hide details' : 'Show details'}
          >
            <svg
              className={`ah-chevron${expanded ? ' open' : ''}`}
              width="8"
              height="8"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <polyline points="9 6 15 12 9 18" />
            </svg>
            <span>{expanded ? 'Hide details' : 'Show details'}</span>
          </button>
        </div>
        {expanded && (
          <div className="ah-detail">
            <dl>
              <dt>Folder</dt><dd title={row.cwd ?? ''}>{row.cwd ?? 'Unknown'}</dd>
              {row.branch && (<><dt>Branch</dt><dd>{row.branch}</dd></>)}
              {row.model && (<><dt>Model</dt><dd>{row.model}</dd></>)}
              {accountText && (<><dt>Account</dt><dd title={row.account ?? accountText}>{accountText}</dd></>)}
              <dt>Messages</dt><dd>{row.messageCount > 0 ? row.messageCount : 'unknown'}</dd>
              <dt>Created</dt><dd>{new Date(row.createdMs).toLocaleString()}</dd>
            </dl>
            {row.firstPrompt && (
              <div className="ah-prompt">
                <span className="ah-prompt-label">First prompt</span>
                <p>{row.firstPrompt}</p>
              </div>
            )}
            {!resumable(row) && (
              <div className="ah-outside" role="note">
                <span>This session ran outside the open project, so it cannot be resumed or handed off from here.</span>
                {owningProject(row) && (
                  <button type="button" className="ah-btn" onClick={() => switchToProject(owningProject(row)!.id)}>Open {owningProject(row)!.name}</button>
                )}
              </div>
            )}
            {isDifferentAccount && (
              <div className="ah-account-warning" role="note">
                <div className="ah-account-warning-text">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="12" />
                    <line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                  <span>
                    This session was recorded under account &quot;{sessionAcctName}&quot;, but the currently active account is &quot;{activeAcctName}&quot;. It will not open in chat or terminal because it is in a different account.
                  </span>
                </div>
                <button
                  type="button"
                  className="ah-btn ah-btn-sm"
                  onClick={async () => {
                    const ok = await selectAccount(row.agent, sessionAccountId);
                    if (ok) {
                      showToast(`Switched active ${agent?.label ?? row.agent} account to ${sessionAcctName}`, 'success');
                    }
                  }}
                >
                  Switch to {sessionAcctName}
                </button>
              </div>
            )}
            <div className="ah-detail-actions">
              <button
                type="button"
                className="ah-btn"
                disabled={busy === key || !resumable(row) || isDifferentAccount}
                onClick={() => void resume(row, 'terminal')}
                title={
                  isDifferentAccount
                    ? `Cannot open: this session is in account "${sessionAcctName}", but the active account is "${activeAcctName}". Switch accounts to resume.`
                    : `Continue this session in a new ${agent?.label ?? ''} terminal`
                }
              >
                Resume in terminal
              </button>
              <button
                type="button"
                className="ah-btn"
                disabled={busy === key || !resumable(row) || isDifferentAccount}
                onClick={() => void resume(row, 'chat')}
                title={
                  isDifferentAccount
                    ? `Cannot open: this session is in account "${sessionAcctName}", but the active account is "${activeAcctName}". Switch accounts to resume.`
                    : 'Continue this session in a new native chat'
                }
              >
                Resume in chat
              </button>
              <button type="button" className="ah-btn" disabled={!resumable(row)} onClick={() => setHandoffRow(row)}>Hand off to another agent</button>
            </div>
            <div className="ah-detail-actions">
              <button type="button" className="ah-btn" onClick={() => copy(resumeCommand(row), 'resume command')}>Copy resume command</button>
              <button type="button" className="ah-btn" onClick={() => copy(row.id, 'session ID')}>Copy session ID</button>
              {accountText && <button type="button" className="ah-btn" onClick={() => copy(accountText, 'account')}>Copy account</button>}
              {row.logPath && <button type="button" className="ah-btn" onClick={() => copy(row.logPath!, 'log path')}>Copy log path</button>}
              {row.firstPrompt && <button type="button" className="ah-btn" onClick={() => copy(row.firstPrompt, 'first prompt')}>Copy first prompt</button>}
            </div>
          </div>
        )}
      </li>
    );
  }

  const total = rows?.length ?? 0;
  const allSelected = prefs.agents.length === HISTORY_AGENTS.length;
  return (
    <div className="ah-root">
      <div className="ah-toolbar">
        <input
          className="ah-search"
          type="search"
          placeholder="Search sessions"
          aria-label="Search sessions"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="button" className="ah-icon-btn" onClick={() => void refresh()} disabled={loading} title="Refresh session history" aria-label="Refresh session history">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={loading ? 'ah-spin' : ''}>
            <path d="M21 12a9 9 0 1 1-2.6-6.4" /><path d="M21 4v5h-5" />
          </svg>
        </button>
        <div className="ah-menu-wrap" ref={menuRef}>
          <button type="button" className={`ah-icon-btn${menuOpen ? ' on' : ''}`} onClick={() => setMenuOpen((v) => !v)} title="View options" aria-label="View options" aria-expanded={menuOpen} aria-haspopup="menu">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" /><circle cx="16" cy="6" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="18" cy="18" r="2" />
            </svg>
          </button>
          {menuOpen && (
            <div className="ah-menu" role="menu">
              <div className="ah-menu-head">
                <span>Agents</span>
                <span className="ah-menu-links">
                  <button type="button" disabled={allSelected} onClick={() => setPrefs({ agents: HISTORY_AGENTS.map((a) => a.id) })}>Select all</button>
                  <button type="button" disabled={prefs.agents.length === 0} onClick={() => setPrefs({ agents: [] })}>Clear</button>
                </span>
              </div>
              {HISTORY_AGENTS.map((a) => (
                <button key={a.id} type="button" role="menuitemcheckbox" aria-checked={prefs.agents.includes(a.id)} className="ah-menu-item" onClick={() => toggleAgent(a.id)}>
                  <span className="ah-menu-tick">{prefs.agents.includes(a.id) && <Check />}</span>
                  <HistoryBrand command={a.command} name={a.label} />
                  <span>{a.label}</span>
                </button>
              ))}
              <div className="ah-menu-sep" />
              <div className="ah-menu-head"><span>Group</span></div>
              {([['project', 'Project'], ['folder', 'Folder'], ['agent', 'Agent'], ['account', 'Account']] as const).map(([id, label]) => (
                <button key={id} type="button" role="menuitemradio" aria-checked={prefs.group === id} className="ah-menu-item" onClick={() => setPrefs({ group: id })}>
                  <span className="ah-menu-tick">{prefs.group === id && <span className="ah-dot" />}</span>
                  <span>{label}</span>
                </button>
              ))}
              <div className="ah-menu-sep" />
              <div className="ah-menu-head"><span>Sort</span></div>
              {([['updated', 'Last updated'], ['created', 'Created']] as const).map(([id, label]) => (
                <button key={id} type="button" role="menuitemradio" aria-checked={prefs.sort === id} className="ah-menu-item" onClick={() => setPrefs({ sort: id })}>
                  <span className="ah-menu-tick">{prefs.sort === id && <span className="ah-dot" />}</span>
                  <span>{label}</span>
                </button>
              ))}
              <div className="ah-menu-sep" />
              <button type="button" role="menuitem" className="ah-menu-item" onClick={() => setAllGroups(true)}>
                <span className="ah-menu-tick" />
                <span>Collapse all groups</span>
              </button>
              <button type="button" role="menuitem" className="ah-menu-item" onClick={() => setAllGroups(false)}>
                <span className="ah-menu-tick" />
                <span>Expand all groups</span>
              </button>
              <div className="ah-menu-sep" />
              <button type="button" role="menuitemcheckbox" aria-checked={prefs.hideEmpty} className="ah-menu-item" onClick={() => setPrefs({ hideEmpty: !prefs.hideEmpty })}>
                <span className="ah-menu-tick">{prefs.hideEmpty && <Check />}</span>
                <span>Hide empty sessions</span>
              </button>
            </div>
          )}
        </div>
      </div>
      <div className="ah-filters">
        <div className="ah-seg" role="group" aria-label="Scope">
          <button type="button" className={prefs.scope === 'project' ? 'on' : ''} onClick={() => setPrefs({ scope: 'project' })} disabled={!project}>Project</button>
          <button type="button" className={prefs.scope === 'all' ? 'on' : ''} onClick={() => setPrefs({ scope: 'all', group: 'project' })}>All</button>
        </div>
        <span className="ah-count">{rows ? `${shown.length} shown · ${total} recent` : ''}</span>
      </div>

      <div className="ah-list">
        {error && <div className="ah-note ah-error">Couldn't read session history: {error}</div>}
        {!error && rows && !shown.length && (
          <div className="ah-note">
            {total === 0 ? 'No sessions found yet. Claude, Codex and OpenCode sessions appear here once they have run.' : prefs.agents.length === 0 ? 'No agents selected.' : 'No sessions match these filters.'}
          </div>
        )}
        {!rows && !error && <div className="ah-note">Scanning transcripts…</div>}
        {groups.map((group) => (
          <section key={group.key} className="ah-group">
            <h3 className="ah-group-label">
              <button type="button" className="ah-group-toggle" aria-expanded={!isCollapsed(group.key)} onClick={() => toggleGroup(group.key)} title={isCollapsed(group.key) ? 'Expand' : 'Collapse'}>
                <svg className={`ah-chevron${isCollapsed(group.key) ? '' : ' open'}`} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="9 6 15 12 9 18" /></svg>
                <span className="ah-group-name">{group.label}</span>
                <span className="ah-group-count">{group.rows.length}</span>
              </button>
            </h3>
            {!isCollapsed(group.key) && <ul className="ah-rows">{group.rows.map(renderRow)}</ul>}
          </section>
        ))}
      </div>
      {handoffRow && <HandoffHistoryModal row={handoffRow} onClose={() => setHandoffRow(null)} />}
    </div>
  );
}
