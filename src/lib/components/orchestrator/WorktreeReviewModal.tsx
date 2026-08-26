/**
 * Per-worktree review pane — the Orca-style gate for one agent's work.
 *
 * The fleet cards can show a file list inline, but a card is a summary; this
 * modal is where an agent's work actually gets *read* before anything moves.
 * Master-detail: changed files on the left, the selected file's diff filling
 * the right, both measured against the commit the worktree forked from
 * (`baseCommit`) so committed and uncommitted work appear together — the
 * question being answered is "has the main checkout seen this yet?", not
 * "what is staged in this worktree?".
 *
 * Actions mirror the fleet cards exactly (same git semantics, same helpers):
 * Bring in stages into the main checkout, Merge folds the branch in, Discard
 * reclaims the checkout after staging anything outstanding. The diff itself is
 * read-only — partial staging of someone else's finished work has no meaning
 * here. After Merge/Discard the pane closes; Bring in leaves it open because
 * the worktree still holds the work.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { showToast } from '$lib/stores/notification';
import { useModalFocus } from '$lib/react/useModalFocus';
import { stageAgentWorktree, markWorktreeMerged } from '$lib/stores/orchestrator';
import {
  mergeTaskWorktree,
  reclaimWorktree,
  type WorktreeInfo,
} from '$lib/services/orchestrator/worktree-manager';
import { AgentBrandMark } from '$lib/components/shared/useAgentBrand.tsx';
import HunkDiffView from '$lib/components/review/HunkDiffView.tsx';
import FileIcon from '$lib/components/explorer/FileIcon.tsx';
import './WorktreeReviewModal.css';

/** How often the diff stat is refreshed while the pane is open — a live
 *  agent's worktree changes under it, and the gate should show that. */
const POLL_MS = 5000;

interface FileStat {
  path: string;
  additions: number;
  deletions: number;
  status: string;
}

interface DiffStat {
  files: FileStat[];
  total_additions: number;
  total_deletions: number;
  /** The resolved sha the numbers were measured against — the per-file diff
   *  must open against the *same* base or it would show a different change set. */
  base_commit: string;
}

interface Props {
  projectId: string;
  agentName: string;
  agentPreset: string | null;
  worktree: WorktreeInfo;
  repoPath: string;
  /** Fork point to measure against; the backend echoes the resolved sha back. */
  baseCommit: string;
  /** True while the owning agent's pane is alive — only then is the diff
   *  expected to keep changing, so only then does the pane poll. */
  live: boolean;
  onClose: () => void;
  /** Called after an action lands (or fails to move work) so the owner can refresh. */
  onResolved: () => void;
}

const STATUS_LABEL: Record<string, string> = {
  added: 'A',
  deleted: 'D',
  modified: 'M',
  untracked: 'U',
};

export default function WorktreeReviewModal({
  projectId,
  agentName,
  agentPreset,
  worktree,
  repoPath,
  baseCommit,
  live,
  onClose,
  onResolved,
}: Props) {
  const backdropRef = useRef<HTMLDivElement | null>(null);
  useModalFocus(backdropRef, onClose);

  const [stat, setStat] = useState<DiffStat | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Pending destructive action awaiting explicit confirmation. */
  const [confirming, setConfirming] = useState<'merge' | 'discard' | null>(null);

  // Guards against a slow read resolving after a newer one, and after unmount.
  const genRef = useRef(0);

  const loadStat = useCallback(async () => {
    const gen = ++genRef.current;
    setLoading(true);
    setError(null);
    try {
      const next = await invoke<DiffStat>('workspace_git_worktree_diff_stat', {
        projectId,
        worktreePath: repoPath,
        baseCommit,
      });
      if (gen !== genRef.current) return;
      setStat(next);
      // Keep the selection honest when the file set changed under us (agent
      // kept working): drop a vanished file, keep a valid one, start on the
      // first when there was no selection.
      setSelected((current) => {
        if (current && next.files.some((f) => f.path === current)) return current;
        return next.files[0]?.path ?? null;
      });
    } catch (err) {
      if (gen !== genRef.current) return;
      setError(String(err));
      setStat(null);
    } finally {
      if (gen === genRef.current) setLoading(false);
    }
  }, [projectId, repoPath, baseCommit]);

  useEffect(() => {
    void loadStat();
    // A finished worktree's diff is a settled fact — one read is enough. Only a
    // live agent is expected to keep changing it, so only then does the pane
    // poll.
    if (!live) return;
    const timer = setInterval(() => void loadStat(), POLL_MS);
    return () => {
      genRef.current += 1; // a poll in flight resolves against a dead modal
      clearInterval(timer);
    };
  }, [loadStat, live]);

  const files = stat?.files ?? [];
  const selectedIndex = useMemo(
    () => files.findIndex((f) => f.path === selected),
    [files, selected],
  );

  function moveSelection(delta: number) {
    if (files.length === 0) return;
    if (selectedIndex < 0) {
      setSelected(files[0].path);
      return;
    }
    const next = (selectedIndex + delta + files.length) % files.length;
    setSelected(files[next].path);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveSelection(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveSelection(-1);
    }
  }

  function handleBackdropClick(e: React.MouseEvent) {
    if (e.target === e.currentTarget) onClose();
  }

  /** Bring one agent's outstanding work into the checkout — the pane stays
   *  open because the worktree still holds it. */
  async function doBringIn() {
    setBusy(true);
    try {
      await stageAgentWorktree(projectId, worktree);
    } catch (err) {
      showToast(String(err), 'error', 10000);
    } finally {
      setBusy(false);
    }
    onResolved();
  }

  async function doMerge() {
    setConfirming(null);
    setBusy(true);
    try {
      const result = await mergeTaskWorktree(projectId, worktree, false);
      if (result.conflicted) {
        showToast(
          `${agentName}: merge hit conflicts. Resolve them in Source Control.`,
          'warning',
          14000,
          true,
        );
      } else if (result.alreadyUpToDate) {
        showToast(
          `Nothing to merge. ${worktree.branch} holds nothing ${worktree.baseBranch} doesn't already have.`,
          'info',
          6000,
        );
      } else if (result.success) {
        markWorktreeMerged(projectId, worktree, result.mergedCommit);
        showToast(`Merged ${worktree.branch} into ${worktree.baseBranch}.`, 'success', 8000);
        onResolved();
        onClose();
        return;
      } else {
        showToast(result.message || 'Merge failed.', 'error', 10000);
      }
    } catch (err) {
      showToast(String(err), 'error', 10000);
    } finally {
      setBusy(false);
    }
    onResolved();
  }

  async function doDiscard() {
    setConfirming(null);
    setBusy(true);
    try {
      const outcome = await reclaimWorktree(projectId, worktree, { deleteBranch: true });
      if (outcome.removed) {
        showToast(
          outcome.staged > 0
            ? `Discarded ${worktree.branch}. ${outcome.staged} file change${outcome.staged === 1 ? '' : 's'} were staged into Source Control first.`
            : `Discarded ${worktree.branch}.`,
          'success',
          8000,
        );
        onResolved();
        onClose();
        return;
      } else if (outcome.reason === 'conflict') {
        showToast(
          `${agentName}: can't discard. Staging its work conflicts with your edits. Resolve in Source Control, then try again.`,
          'warning',
          14000,
          true,
        );
      } else if (outcome.reason === 'pending') {
        showToast(
          `${agentName}: kept the worktree. ${outcome.pendingFiles} file change${outcome.pendingFiles === 1 ? '' : 's'} still hadn't reached your working tree.`,
          'warning',
          12000,
        );
      } else {
        showToast(outcome.message || 'Could not discard the worktree.', 'error', 10000);
      }
    } catch (err) {
      showToast(String(err), 'error', 10000);
    } finally {
      setBusy(false);
    }
    onResolved();
  }

  // Rendered through a portal: the fleet dashboard lives inside a drawer whose
  // slide animation applies a transform, which would otherwise turn this
  // `position: fixed` backdrop into a child of that drawer and clip it.
  return createPortal(
    <div
      className="wrm-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={`Review ${agentName}'s work`}
      tabIndex={-1}
      ref={backdropRef}
      onClick={handleBackdropClick}
      onKeyDown={handleKeyDown}
    >
      <div className="wrm-card">
        <header className="wrm-head">
          <span className="wrm-brand-tile">
            <AgentBrandMark command={agentPreset} name={agentName} className="wrm-brand" />
          </span>
          <div className="wrm-title">
            <span className="wrm-agent" title={agentName}>
              {agentName}
            </span>
            <span className="wrm-branch" title={`${worktree.branch}, forked from ${worktree.baseBranch}`}>
              <span className="wrm-branch-name">{worktree.branch}</span>
              <span className="wrm-branch-arrow">→</span>
              <span className="wrm-branch-base">{worktree.baseBranch}</span>
            </span>
          </div>
          {stat && (
            <span className="wrm-totals">
              <span className="wrm-add">+{stat.total_additions}</span>
              <span className="wrm-del">&minus;{stat.total_deletions}</span>
            </span>
          )}
          <button className="wrm-close-btn" onClick={onClose} aria-label="Close review">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </header>

        <div className="wrm-body">
          <aside className="wrm-files" aria-label="Changed files">
            {error ? (
              <div className="wrm-empty">
                <span>{error}</span>
              </div>
            ) : loading && !stat ? (
              <div className="wrm-empty">Reading changes…</div>
            ) : files.length === 0 ? (
              <div className="wrm-empty">Nothing to review. This branch has no changes beyond its base.</div>
            ) : (
              files.map((file, index) => {
                const isSelected = file.path === selected;
                return (
                  <button
                    key={file.path}
                    className={`wrm-file-row${isSelected ? ' selected' : ''}`}
                    onClick={() => setSelected(file.path)}
                    aria-current={isSelected ? 'true' : undefined}
                    title={file.path}
                    // Arrow navigation can walk the selection past the visible
                    // rows; keep the active file in view.
                    ref={isSelected ? (node) => node?.scrollIntoView({ block: 'nearest' }) : undefined}
                  >
                    <span className={`wrm-file-badge ${file.status}`}>
                      {STATUS_LABEL[file.status] ?? file.status.charAt(0).toUpperCase()}
                    </span>
                    <FileIcon name={file.path.split('/').pop() || ''} isDir={false} />
                    <span className="wrm-file-path">{file.path}</span>
                    <span className="wrm-file-stat">
                      <span className="wrm-add">+{file.additions}</span>
                      <span className="wrm-del">&minus;{file.deletions}</span>
                    </span>
                    <span className="wrm-file-idx">{index + 1}</span>
                  </button>
                );
              })
            )}
          </aside>

          <div className="wrm-diff">
            {error ? (
              <div className="wrm-diff-empty">
                <span>{error}</span>
              </div>
            ) : loading && !stat ? (
              <div className="wrm-diff-empty">Reading changes…</div>
            ) : !selected ? (
              <div className="wrm-diff-empty">
                <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="18" cy="18" r="3" />
                  <circle cx="6" cy="6" r="3" />
                  <path d="M13 6h3a2 2 0 0 1 2 2v7" />
                  <path d="M11 18H8a2 2 0 0 1-2-2V9" />
                </svg>
                <p>Pick a file to see its diff against {worktree.baseBranch}.</p>
              </div>
            ) : (
              <HunkDiffView
                projectId={projectId}
                repoPath={repoPath}
                filePath={selected}
                side="unstaged"
                baseRef={stat?.base_commit ?? baseCommit}
              />
            )}
          </div>
        </div>

        <footer className="wrm-foot">
          <span className="wrm-hint">
            Review the diff. Nothing moves until you bring it in, merge it, or discard it.
          </span>
          {confirming ? (
            <div className="wrm-confirm">
              <span className="wrm-confirm-text">
                {confirming === 'merge' ? (
                  <>
                    Merge <strong>{worktree.branch}</strong> into{' '}
                    <strong>{worktree.baseBranch}</strong>?
                  </>
                ) : (
                  <>
                    Delete the worktree and branch <strong>{worktree.branch}</strong>? Anything
                    not yet in your working tree is staged first.
                  </>
                )}
              </span>
              <div className="wrm-confirm-actions">
                <button
                  className={`wrm-btn ${confirming === 'discard' ? 'danger' : 'primary'}`}
                  onClick={() => (confirming === 'merge' ? void doMerge() : void doDiscard())}
                  disabled={busy}
                >
                  {confirming === 'merge' ? 'Merge' : 'Discard'}
                </button>
                <button className="wrm-btn" onClick={() => setConfirming(null)} disabled={busy}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="wrm-actions">
              <button
                className="wrm-btn"
                onClick={() => void doBringIn()}
                disabled={busy}
                title="Copy this agent's changes into your working tree so you can run and review them. Not `git add`. Nothing is committed, and this worktree is kept."
              >
                Bring in
              </button>
              <button
                className="wrm-btn primary"
                onClick={() => setConfirming('merge')}
                disabled={busy}
                title={`Merge ${worktree.branch} into ${worktree.baseBranch}`}
              >
                Merge into {worktree.baseBranch}
              </button>
              <button
                className="wrm-btn danger"
                onClick={() => setConfirming('discard')}
                disabled={busy}
                title={`Delete the worktree and branch ${worktree.branch}`}
              >
                Discard
              </button>
            </div>
          )}
        </footer>
      </div>
    </div>,
    document.body,
  );
}
