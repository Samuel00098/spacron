/**
 * Problems panel — every diagnostic the running language servers report, in one
 * list, grouped by file.
 *
 * Diagnostics arrive from `stores/diagnostics`, which taps `publishDiagnostics`
 * on the shared LSP clients. Note the consequence of that plumbing: a server only
 * reports on documents it has been told about, so this lists problems for files
 * the editor has opened this session, not a cold whole-project analysis. The
 * empty state says so rather than implying the project is clean.
 */
import { useEffect, useMemo, useState } from 'react';
import { activeProject, activeProjectId } from '$lib/stores/workspace';
import { openFile, jumpToLine } from '$lib/stores/editor';
import { enableLsp } from '$lib/stores/settings';
import { useStore } from '$lib/react/useStore';
import {
  diagnosticsByFile,
  groupForProject,
  emptyCounts,
  type Diagnostic,
  type DiagnosticSeverity,
  type SeverityCounts,
} from '$lib/stores/diagnostics';
import { lspStatus, installServer, type LspStatusEntry } from '$lib/services/lsp/client';
import FileIcon from '$lib/components/explorer/FileIcon.tsx';
import './ProblemsPanel.css';

const SEVERITY_ORDER: DiagnosticSeverity[] = ['error', 'warning', 'info', 'hint'];

const SEVERITY_LABEL: Record<DiagnosticSeverity, string> = {
  error: 'Errors',
  warning: 'Warnings',
  info: 'Info',
  hint: 'Hints',
};

function basename(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1];
}

/** Path relative to the project root, for the dimmed directory line. */
function relativeDir(path: string, root: string | null | undefined): string {
  if (!root) return '';
  const normalizedPath = path.replace(/\\/g, '/');
  const normalizedRoot = root.replace(/\\/g, '/').replace(/\/+$/, '');
  const rel = normalizedPath.toLowerCase().startsWith(`${normalizedRoot.toLowerCase()}/`)
    ? normalizedPath.slice(normalizedRoot.length + 1)
    : normalizedPath;
  const lastSlash = rel.lastIndexOf('/');
  return lastSlash === -1 ? '' : rel.slice(0, lastSlash);
}

function SeverityIcon({ severity }: { severity: DiagnosticSeverity }) {
  if (severity === 'error') {
    return (
      <svg className="pp-icon pp-icon-error" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
        <circle cx="12" cy="12" r="9" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" />
      </svg>
    );
  }
  if (severity === 'warning') {
    return (
      <svg className="pp-icon pp-icon-warning" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
        <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
    );
  }
  return (
    <svg className={`pp-icon pp-icon-${severity}`} width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
      <circle cx="12" cy="12" r="9" /><line x1="12" y1="11" x2="12" y2="16" /><line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  );
}

/**
 * The worst thing the LSP layer is currently reporting for this project, or null
 * when everything it tried is fine.
 *
 * An empty problem list has two very different meanings — "analysed, nothing
 * wrong" and "no language server ever started" — and the panel used to render
 * both as the reassuring one. This picks the entry worth showing so the empty
 * state can tell the truth.
 */
function worstStatus(
  status: Map<string, LspStatusEntry>,
  root: string | null,
): LspStatusEntry | null {
  if (!root) return null;
  const prefix = `${root}::`;
  const mine = [...status.entries()]
    .filter(([key]) => key.startsWith(prefix))
    .map(([, entry]) => entry);
  return (
    mine.find((e) => e.state === 'error') ??
    mine.find((e) => e.state === 'missing') ??
    mine.find((e) => e.state === 'starting') ??
    null
  );
}

export default function ProblemsPanel() {
  const byFile = useStore(diagnosticsByFile);
  const project = useStore(activeProject);
  const projectId = useStore(activeProjectId);
  const lspEnabled = useStore(enableLsp);
  const status = useStore(lspStatus);

  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [muted, setMuted] = useState<Partial<Record<DiagnosticSeverity, boolean>>>({});
  const [query, setQuery] = useState('');

  useEffect(() => {
    // These are panel controls, but they describe the current project's
    // diagnostics. Do not carry a filter or collapsed file from another one.
    setCollapsed({});
    setMuted({});
    setQuery('');
  }, [projectId]);

  const root = project?.root_path ?? null;

  const allGroups = useMemo(() => groupForProject(byFile, root), [byFile, root]);
  const health = useMemo(() => worstStatus(status, root), [status, root]);

  /** Totals BEFORE filtering, so the header chips still show what exists. */
  const totals = useMemo<SeverityCounts>(() => {
    const counts = emptyCounts();
    for (const group of allGroups) {
      for (const severity of SEVERITY_ORDER) counts[severity] += group.counts[severity];
    }
    return counts;
  }, [allGroups]);

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return allGroups
      .map((group) => ({
        ...group,
        diagnostics: group.diagnostics.filter((d) => {
          if (muted[d.severity]) return false;
          if (!needle) return true;
          return (
            d.message.toLowerCase().includes(needle) ||
            group.filePath.toLowerCase().includes(needle) ||
            (d.code ?? '').toLowerCase().includes(needle) ||
            (d.source ?? '').toLowerCase().includes(needle)
          );
        }),
      }))
      .filter((group) => group.diagnostics.length > 0);
  }, [allGroups, muted, query]);

  const shownCount = groups.reduce((sum, group) => sum + group.diagnostics.length, 0);

  async function reveal(diagnostic: Diagnostic) {
    await openFile(diagnostic.filePath);
    jumpToLine.set({ path: diagnostic.filePath, line: diagnostic.line });
  }

  function toggleFile(path: string) {
    setCollapsed((current) => ({ ...current, [path]: !current[path] }));
  }

  function toggleSeverity(severity: DiagnosticSeverity) {
    setMuted((current) => ({ ...current, [severity]: !current[severity] }));
  }

  return (
    <div className="pp-root">
      <div className="pp-header">
        <span className="pp-title">PROBLEMS</span>
        <div className="pp-chips">
          {SEVERITY_ORDER.map((severity) => (
            <button
              key={severity}
              className={`pp-chip pp-chip-${severity}${muted[severity] ? ' muted' : ''}`}
              onClick={() => toggleSeverity(severity)}
              title={`${muted[severity] ? 'Show' : 'Hide'} ${SEVERITY_LABEL[severity].toLowerCase()}`}
              aria-pressed={!muted[severity]}
            >
              <SeverityIcon severity={severity} />
              <span>{totals[severity]}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="pp-filter-row">
        <input
          className="pp-filter"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter problems…"
          spellCheck={false}
        />
      </div>

      <div className="pp-body">
        {!project ? (
          <div className="pp-empty">No project open.</div>
        ) : !lspEnabled ? (
          <div className="pp-empty">
            <strong>Language server is off.</strong>
            <span>Enable it in Settings &gt; General to collect diagnostics.</span>
          </div>
        ) : allGroups.length === 0 && health?.state === 'error' ? (
          <div className="pp-empty pp-empty-error">
            <strong>The {health.language} language server isn&rsquo;t running.</strong>
            <span>{health.detail}</span>
            <span>Until it starts, this list stays empty whatever the code says.</span>
          </div>
        ) : allGroups.length === 0 && health?.state === 'missing' ? (
          <div className="pp-empty">
            <strong>No {health.language} language server installed.</strong>
            <span>{health.detail}</span>
            <button className="pp-empty-action" onClick={() => void installServer(health.language)}>
              Install it
            </button>
          </div>
        ) : allGroups.length === 0 && health?.state === 'starting' ? (
          <div className="pp-empty">
            <strong>Starting the {health.language} language server&hellip;</strong>
            <span>Diagnostics appear once it finishes indexing.</span>
          </div>
        ) : allGroups.length === 0 ? (
          <div className="pp-empty">
            <strong>No problems reported.</strong>
            <span>
              Diagnostics come from the language servers, which only analyse files
              opened this session.
            </span>
          </div>
        ) : shownCount === 0 ? (
          <div className="pp-empty">
            <strong>Nothing matches.</strong>
            <span>{totals.error + totals.warning + totals.info + totals.hint} problem(s) hidden by the current filter.</span>
          </div>
        ) : (
          groups.map((group) => {
            const isCollapsed = collapsed[group.filePath];
            return (
              <div className="pp-file" key={group.filePath}>
                <button
                  className="pp-file-head"
                  onClick={() => toggleFile(group.filePath)}
                  aria-expanded={!isCollapsed}
                >
                  <svg
                    className={`pp-caret${isCollapsed ? ' collapsed' : ''}`}
                    width="10" height="10" viewBox="0 0 24 24"
                    fill="none" stroke="currentColor" strokeWidth="3"
                    strokeLinecap="round" strokeLinejoin="round"
                  >
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                  <FileIcon name={basename(group.filePath)} isDir={false} />
                  <span className="pp-file-name">{basename(group.filePath)}</span>
                  <span className="pp-file-dir">{relativeDir(group.filePath, root)}</span>
                  <span className="pp-file-count">{group.diagnostics.length}</span>
                </button>

                {!isCollapsed && (
                  <div className="pp-list">
                    {group.diagnostics.map((d, i) => (
                      <button
                        className="pp-item"
                        key={`${d.line}:${d.column}:${i}`}
                        onClick={() => void reveal(d)}
                        title={d.message}
                      >
                        <SeverityIcon severity={d.severity} />
                        <span className="pp-message">{d.message}</span>
                        {d.source && <span className="pp-source">{d.source}</span>}
                        {d.code && <span className="pp-code">{d.code}</span>}
                        <span className="pp-pos">
                          {d.line}:{d.column}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
