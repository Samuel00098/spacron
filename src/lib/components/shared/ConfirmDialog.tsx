import { useRef } from 'react';
import { useModalFocus } from '$lib/react/useModalFocus';
import './ConfirmDialog.css';

export interface ConfirmDialogProps {
  title: string;
  /** The consequence, in the user's terms. Shown under the title. */
  body: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** Styles the confirm button as destructive. */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * A small yes/no dialog for an action that cannot be undone.
 *
 * Render it CONDITIONALLY (`{pending && <ConfirmDialog … />}`) — never mounted
 * with an `isOpen` prop returning null. `useModalFocus` bumps the app-wide
 * `modalOpenCount` on mount, and a host that stays mounted pins that count and
 * silently kills every keyboard shortcut in the app (see
 * `.spacron/memory/modal-open-count-gate.md`).
 */
export default function ConfirmDialog({
  title,
  body,
  confirmLabel,
  cancelLabel = 'Cancel',
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const backdropRef = useRef<HTMLDivElement | null>(null);
  useModalFocus(backdropRef, onCancel);

  return (
    <div
      className="confirm-backdrop"
      ref={backdropRef}
      onMouseDown={(e) => {
        // Escape and an outside click both mean "no" — the safe answer is the
        // one that is easiest to give.
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="confirm-modal" role="alertdialog" aria-modal="true" aria-label={title}>
        <div className="confirm-body">
          <h2 className="confirm-title">{title}</h2>
          <div className="confirm-text">{body}</div>
        </div>
        <div className="confirm-actions">
          <button type="button" className="confirm-btn ghost" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`confirm-btn${danger ? ' danger' : ' primary'}`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
