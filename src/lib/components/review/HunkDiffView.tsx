/**
 * A file's diff with per-hunk and per-line staging controls.
 *
 * Deliberately takes a `repoPath` rather than assuming the active project: the
 * Fleet Dashboard points this at an agent's worktree so one diff surface serves
 * both "review my changes" and "review what that agent produced".
 *
 * Staging works by synthesising a patch containing only the chosen parts and
 * feeding it to `git apply --cached` — see `services/git/patch.ts`, where the
 * hunk-header arithmetic lives and is tested.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { showToast } from '$lib/stores/notification';
import {
  parseUnifiedDiff,
  buildHunkPatch,
  buildLinePatch,
  hunkStats,
  findFile,
  type PatchFile,
  type PatchHunk,
} from '$lib/services/git/patch';
import './HunkDiffView.css';

export interface HunkDiffViewProps {
  projectId: string;
  /** Repo to act on. Omit for the open project; pass a worktree for agent review. */
  repoPath?: string | null;
  /** Repo-relative path. */
  filePath: string;
  /**
   * Which side to show. `unstaged` (index → worktree) offers Stage; `staged`
   * (HEAD → index) offers Unstage. The direction decides both the diff we ask
   * for and whether the patch is applied forward or reversed. Ignored when
   * `baseRef` is set — that mode has no staged/unstaged split of its own.
   */
  side: 'staged' | 'unstaged';
  /**
   * Review an agent worktree against the commit it branched from, rather than
   * against its own index. Covers committed *and* uncommitted work in one
   * diff, which is what "has the main checkout seen this yet?" actually asks.
   * Implies `readOnly` — merge/discard are the actions here, not partial
   * staging of someone else's finished work.
   */
  baseRef?: string;
  /** Hide staging affordances and line selection; just render the diff. */
  readOnly?: boolean;
  /** Called after the index changes so the parent can refresh its file lists. */
  onIndexChanged?: () => void;
}

type Loaded = {
  file: PatchFile | null;
  untracked: boolean;
  empty: boolean;
};

export default function HunkDiffView({
  projectId,
  repoPath,
  filePath,
  side,
  baseRef,
  readOnly,
  onIndexChanged,
}: HunkDiffViewProps) {
  const effectiveReadOnly = readOnly || Boolean(baseRef);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Selected line indices, keyed by hunk position within the file. */
  const [selection, setSelection] = useState<Map<number, Set<number>>>(new Map());

  const load = useCallback(async () => {
    setError(null);
    try {
      const result = await invoke<{ staged: string; unstaged: string; untracked: boolean }>(
        'workspace_git_diff_split',
        { projectId, filePath, repoPath: repoPath ?? null, baseRef: baseRef ?? null },
      );
      const text = baseRef ? result.unstaged : side === 'staged' ? result.staged : result.unstaged;
      const files = parseUnifiedDiff(text);
      setLoaded({
        file: findFile(files, filePath) ?? files[0] ?? null,
        untracked: result.untracked,
        empty: !text.trim(),
      });
      setSelection(new Map());
    } catch (err) {
      setError(String(err));
      setLoaded(null);
    }
  }, [projectId, repoPath, filePath, side, baseRef]);

  useEffect(() => {
    void load();
  }, [load]);

  const file = loaded?.file ?? null;

  const totals = useMemo(() => {
    if (!file) return { additions: 0, deletions: 0 };
    return file.hunks.reduce(
      (acc, hunk) => {
        const stats = hunkStats(hunk);
        return {
          additions: acc.additions + stats.additions,
          deletions: acc.deletions + stats.deletions,
        };
      },
      { additions: 0, deletions: 0 },
    );
  }, [file]);

  async function applyPatch(patch: string) {
    if (effectiveReadOnly) return;
    setBusy(true);
    try {
      await invoke('workspace_git_apply_patch', {
        projectId,
        patch,
        // A staged hunk is removed from the index by reversing the HEAD→index
        // patch that put it there.
        reverse: side === 'staged',
        repoPath: repoPath ?? null,
      });
      onIndexChanged?.();
      await load();
    } catch (err) {
      showToast(String(err), 'error', 8000);
    } finally {
      setBusy(false);
    }
  }

  function toggleLine(hunkIndex: number, lineIndex: number) {
    setSelection((current) => {
      const next = new Map(current);
      const set = new Set(next.get(hunkIndex) ?? []);
      if (set.has(lineIndex)) set.delete(lineIndex);
      else set.add(lineIndex);
      if (set.size === 0) next.delete(hunkIndex);
      else next.set(hunkIndex, set);
      return next;
    });
  }

  if (error) {
    return <div className="hdv-message hdv-error">{error}</div>;
  }
  if (!loaded) {
    return <div className="hdv-message">Loading diff…</div>;
  }
  if (loaded.empty || !file) {
    return (
      <div className="hdv-message">
        {baseRef
          ? 'No difference from the base commit.'
          : side === 'staged'
            ? 'Nothing staged for this file.'
            : 'No unstaged changes in this file.'}
      </div>
    );
  }
  if (file.binary) {
    return (
      <div className="hdv-message">
        {effectiveReadOnly ? 'Binary file changed.' : 'Binary file — stage or unstage it whole.'}
      </div>
    );
  }

  const actionLabel = side === 'staged' ? 'Unstage' : 'Stage';

  return (
    <div className="hdv-root">
      <div className="hdv-summary">
        <span className="hdv-add">+{totals.additions}</span>
        <span className="hdv-del">&minus;{totals.deletions}</span>
        {loaded.untracked && <span className="hdv-note">untracked — new file</span>}
      </div>

      {file.hunks.map((hunk, hunkIndex) => {
        const selected = selection.get(hunkIndex) ?? new Set<number>();
        const stats = hunkStats(hunk);
        return (
          <div className="hdv-hunk" key={`${hunk.oldStart}:${hunk.newStart}:${hunkIndex}`}>
            <div className="hdv-hunk-head">
              <span className="hdv-hunk-range">
                @@ &minus;{hunk.oldStart},{hunk.oldCount} +{hunk.newStart},{hunk.newCount} @@
              </span>
              <span className="hdv-hunk-stats">
                +{stats.additions} &minus;{stats.deletions}
              </span>
              {!effectiveReadOnly && (
                <>
                  <button
                    className="hdv-hunk-action"
                    disabled={busy}
                    onClick={() => void applyPatch(buildHunkPatch(file, hunk))}
                    title={`${actionLabel} this whole hunk`}
                  >
                    {actionLabel} hunk
                  </button>
                  <button
                    className="hdv-hunk-action"
                    disabled={busy || selected.size === 0}
                    onClick={() => {
                      const patch = buildLinePatch(file, hunk, selected);
                      if (!patch) {
                        showToast('Select at least one changed line.', 'warning');
                        return;
                      }
                      void applyPatch(patch);
                    }}
                    title={`${actionLabel} only the ticked lines`}
                  >
                    {actionLabel} selection{selected.size > 0 ? ` (${selected.size})` : ''}
                  </button>
                </>
              )}
            </div>

            <div className="hdv-lines">
              {hunk.lines.map((line) => {
                const selectable = !effectiveReadOnly && line.kind !== 'context';
                const isSelected = selected.has(line.index);
                return (
                  <div
                    key={line.index}
                    className={`hdv-line hdv-${line.kind}${isSelected ? ' selected' : ''}`}
                    onClick={selectable ? () => toggleLine(hunkIndex, line.index) : undefined}
                    role={selectable ? 'button' : undefined}
                    tabIndex={selectable ? 0 : undefined}
                    onKeyDown={
                      selectable
                        ? (event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              toggleLine(hunkIndex, line.index);
                            }
                          }
                        : undefined
                    }
                  >
                    <span className="hdv-gutter hdv-old">{line.oldLine ?? ''}</span>
                    <span className="hdv-gutter hdv-new">{line.newLine ?? ''}</span>
                    <span className="hdv-marker">
                      {line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}
                    </span>
                    <span className="hdv-text">{line.text || ' '}</span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
