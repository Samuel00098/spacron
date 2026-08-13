/**
 * "Share" on the Stats pane — previews the usage card and copies it as a PNG.
 *
 * The preview is not decoration. This card is the one thing in the app a user
 * might post publicly, and it carries their project names and spend, so it has
 * to be *seen* before it lands on the clipboard. A button that silently copied
 * an image would be asking them to paste something they had never looked at.
 *
 * Card composition and drawing live in `services/share-usage-card.ts`.
 */

import { useEffect, useRef, useState } from 'react';
import { copyPngToClipboard } from '$lib/utils/clipboard';
import {
  CARD_WIDTH,
  shareCardDataUrl,
  shareCardPngBytes,
  type ShareCardData,
} from '$lib/services/share-usage-card';
import './ShareUsageButton.css';

const ICON_SHARE =
  'M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7 M16 6l-4-4-4 4 M12 2v14';

type CopyState = 'idle' | 'copied' | 'failed';

export default function ShareUsageButton({ data }: { data: ShareCardData }) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const [error, setError] = useState<string | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  // Draw only while open. The canvas work is trivial, but redrawing it on
  // every stats poll for a popover nobody opened is pure waste.
  useEffect(() => {
    if (!open) return;
    try {
      setPreview(shareCardDataUrl(data));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [open, data]);

  // Escape and outside-pointerdown, the same contract as UsagePanel. The
  // toggle carries `data-share-toggle` so the outside handler can skip it —
  // without that the two handlers cancel into a no-op and the popover never
  // opens.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    const onDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('[data-share-toggle]')) return;
      if (popoverRef.current && !popoverRef.current.contains(target)) setOpen(false);
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onDown);
    };
  }, [open]);

  useEffect(() => {
    if (copyState === 'idle') return;
    const timer = setTimeout(() => setCopyState('idle'), 2200);
    return () => clearTimeout(timer);
  }, [copyState]);

  async function copy() {
    try {
      await copyPngToClipboard(await shareCardPngBytes(data));
      setCopyState('copied');
      setError(null);
    } catch (e) {
      setCopyState('failed');
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="share-usage">
      <button
        type="button"
        className="stats-icon-btn"
        data-share-toggle
        onClick={() => setOpen((v) => !v)}
        title="Share usage card"
        aria-label="Share usage card"
        aria-expanded={open}
      >
        <svg viewBox="0 0 24 24" width={14} height={14} aria-hidden="true">
          <path
            d={ICON_SHARE}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open && (
        <div className="share-usage-pop" ref={popoverRef} role="dialog" aria-label="Usage card">
          {preview ? (
            <img
              className="share-usage-preview"
              src={preview}
              alt="Usage summary card"
              width={CARD_WIDTH}
            />
          ) : (
            <p className="shell-hint" style={{ margin: 0 }}>
              Drawing card…
            </p>
          )}

          <div className="share-usage-foot">
            <p className="share-usage-note">
              Includes your totals — check it before posting.
            </p>
            <button type="button" className="stats-action-btn" onClick={() => void copy()}>
              {copyState === 'copied'
                ? 'Copied'
                : copyState === 'failed'
                  ? 'Try again'
                  : 'Copy PNG'}
            </button>
          </div>
          {error && <p className="stats-error-note share-usage-error">{error}</p>}
        </div>
      )}
    </div>
  );
}
