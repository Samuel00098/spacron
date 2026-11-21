import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import {
  getAvailablePresets,
  type SplitPreset,
  type SplitPresetId,
} from './split-layout';
import './SplitLayoutPicker.css';

interface SplitLayoutPickerProps {
  count: number;
  activePreset: SplitPresetId;
  onSelectPreset: (presetId: SplitPresetId) => void;
}

export function PresetThumbnail({ presetId, active = false }: { presetId: SplitPresetId; active?: boolean }) {
  const stroke = active ? 'var(--accent)' : 'currentColor';
  const fill = active
    ? 'color-mix(in srgb, var(--accent) 35%, transparent)'
    : 'var(--split-preset-fill)';
  const strokeWidth = active ? 1.2 : 0.9;

  let inner = null;

  switch (presetId) {
    case '2-cols':
      inner = (
        <>
          <rect x="2" y="2" width="9.5" height="14" rx="1.5" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="12.5" y="2" width="9.5" height="14" rx="1.5" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
        </>
      );
      break;

    case '2-rows':
      inner = (
        <>
          <rect x="2" y="2" width="20" height="6.5" rx="1.5" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="2" y="9.5" width="20" height="6.5" rx="1.5" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
        </>
      );
      break;

    case '2-left-master':
      inner = (
        <>
          <rect x="2" y="2" width="13" height="14" rx="1.5" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="16" y="2" width="6" height="14" rx="1.5" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
        </>
      );
      break;

    case '2-right-master':
      inner = (
        <>
          <rect x="2" y="2" width="6" height="14" rx="1.5" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="9" y="2" width="13" height="14" rx="1.5" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
        </>
      );
      break;

    case '3-top2-bottom1':
      inner = (
        <>
          <rect x="2" y="2" width="9.5" height="6.5" rx="1.5" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="12.5" y="2" width="9.5" height="6.5" rx="1.5" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="2" y="9.5" width="20" height="6.5" rx="1.5" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
        </>
      );
      break;

    case '3-top1-bottom2':
      inner = (
        <>
          <rect x="2" y="2" width="20" height="6.5" rx="1.5" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="2" y="9.5" width="9.5" height="6.5" rx="1.5" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="12.5" y="9.5" width="9.5" height="6.5" rx="1.5" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
        </>
      );
      break;

    case '3-left-master':
      inner = (
        <>
          <rect x="2" y="2" width="10" height="14" rx="1.5" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="13" y="2" width="9" height="6.5" rx="1.5" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="13" y="9.5" width="9" height="6.5" rx="1.5" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
        </>
      );
      break;

    case '3-right-master':
      inner = (
        <>
          <rect x="2" y="2" width="9" height="6.5" rx="1.5" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="2" y="9.5" width="9" height="6.5" rx="1.5" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="12" y="2" width="10" height="14" rx="1.5" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
        </>
      );
      break;

    case '3-cols':
      inner = (
        <>
          <rect x="2" y="2" width="6" height="14" rx="1.5" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="9" y="2" width="6" height="14" rx="1.5" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="16" y="2" width="6" height="14" rx="1.5" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
        </>
      );
      break;

    case '4-grid':
      inner = (
        <>
          <rect x="2" y="2" width="9.5" height="6.5" rx="1.5" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="12.5" y="2" width="9.5" height="6.5" rx="1.5" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="2" y="9.5" width="9.5" height="6.5" rx="1.5" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="12.5" y="9.5" width="9.5" height="6.5" rx="1.5" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
        </>
      );
      break;

    case '4-left-master':
      inner = (
        <>
          <rect x="2" y="2" width="10" height="14" rx="1.5" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="13" y="2" width="9" height="4" rx="1" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="13" y="7" width="9" height="4" rx="1" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="13" y="12" width="9" height="4" rx="1" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
        </>
      );
      break;

    case '4-top1-bottom3':
      inner = (
        <>
          <rect x="2" y="2" width="20" height="6.5" rx="1.5" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="2" y="9.5" width="6" height="6.5" rx="1.5" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="9" y="9.5" width="6" height="6.5" rx="1.5" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="16" y="9.5" width="6" height="6.5" rx="1.5" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
        </>
      );
      break;

    case '4-cols':
      inner = (
        <>
          <rect x="2" y="2" width="4.5" height="14" rx="1" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="7.5" y="2" width="4.5" height="14" rx="1" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="13" y="2" width="4.5" height="14" rx="1" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="18.5" y="2" width="4.5" height="14" rx="1" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
        </>
      );
      break;

    case '5-top3-bottom2':
      inner = (
        <>
          <rect x="2" y="2" width="6" height="6.5" rx="1" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="9" y="2" width="6" height="6.5" rx="1" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="16" y="2" width="6" height="6.5" rx="1" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="2" y="9.5" width="9.5" height="6.5" rx="1" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="12.5" y="9.5" width="9.5" height="6.5" rx="1" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
        </>
      );
      break;

    case '5-top2-bottom3':
      inner = (
        <>
          <rect x="2" y="2" width="9.5" height="6.5" rx="1" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="12.5" y="2" width="9.5" height="6.5" rx="1" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="2" y="9.5" width="6" height="6.5" rx="1" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="9" y="9.5" width="6" height="6.5" rx="1" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="16" y="9.5" width="6" height="6.5" rx="1" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
        </>
      );
      break;

    case '5-left-master':
      inner = (
        <>
          <rect x="2" y="2" width="8" height="14" rx="1" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="11" y="2" width="5" height="6.5" rx="1" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="17" y="2" width="5" height="6.5" rx="1" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="11" y="9.5" width="5" height="6.5" rx="1" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="17" y="9.5" width="5" height="6.5" rx="1" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
        </>
      );
      break;

    case '5-cols':
      inner = (
        <>
          <rect x="2" y="2" width="3.2" height="14" rx="0.8" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="6.2" y="2" width="3.2" height="14" rx="0.8" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="10.4" y="2" width="3.2" height="14" rx="0.8" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="14.6" y="2" width="3.2" height="14" rx="0.8" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="18.8" y="2" width="3.2" height="14" rx="0.8" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
        </>
      );
      break;

    case '6-grid':
      inner = (
        <>
          <rect x="2" y="2" width="6" height="6.5" rx="1" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="9" y="2" width="6" height="6.5" rx="1" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="16" y="2" width="6" height="6.5" rx="1" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="2" y="9.5" width="6" height="6.5" rx="1" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="9" y="9.5" width="6" height="6.5" rx="1" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="16" y="9.5" width="6" height="6.5" rx="1" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
        </>
      );
      break;

    case '6-grid-2x3':
      inner = (
        <>
          <rect x="2" y="2" width="9.5" height="4" rx="0.8" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="12.5" y="2" width="9.5" height="4" rx="0.8" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="2" y="7" width="9.5" height="4" rx="0.8" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="12.5" y="7" width="9.5" height="4" rx="0.8" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="2" y="12" width="9.5" height="4" rx="0.8" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="12.5" y="12" width="9.5" height="4" rx="0.8" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
        </>
      );
      break;

    case '6-left-master':
      inner = (
        <>
          <rect x="2" y="2" width="8" height="14" rx="1" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="11" y="2" width="5" height="4" rx="0.8" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="17" y="2" width="5" height="6.5" rx="0.8" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="11" y="7" width="5" height="4" rx="0.8" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="17" y="9.5" width="5" height="6.5" rx="0.8" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="11" y="12" width="5" height="4" rx="0.8" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
        </>
      );
      break;

    case '6-cols':
      inner = (
        <>
          <rect x="2" y="2" width="2.6" height="14" rx="0.6" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="5.6" y="2" width="2.6" height="14" rx="0.6" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="9.2" y="2" width="2.6" height="14" rx="0.6" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="12.8" y="2" width="2.6" height="14" rx="0.6" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="16.4" y="2" width="2.6" height="14" rx="0.6" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="19.8" y="2" width="2.6" height="14" rx="0.6" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
        </>
      );
      break;

    case 'many-scroll':
      inner = (
        <>
          <rect x="2" y="2" width="5.5" height="6" rx="0.8" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="8.5" y="2" width="5.5" height="6" rx="0.8" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="15" y="2" width="5.5" height="6" rx="0.8" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="2" y="9" width="5.5" height="6" rx="0.8" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="8.5" y="9" width="5.5" height="6" rx="0.8" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="15" y="9" width="5.5" height="6" rx="0.8" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <line x1="22" y1="3" x2="22" y2="15" stroke={stroke} strokeWidth={1.5} strokeLinecap="round" strokeDasharray="4 3" />
        </>
      );
      break;

    case 'many-dense-matrix':
      inner = (
        <>
          <rect x="2" y="2" width="4.5" height="4" rx="0.6" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="7.5" y="2" width="4.5" height="4" rx="0.6" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="13" y="2" width="4.5" height="4" rx="0.6" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="18.5" y="2" width="4.5" height="4" rx="0.6" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="2" y="7" width="4.5" height="4" rx="0.6" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="7.5" y="7" width="4.5" height="4" rx="0.6" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="13" y="7" width="4.5" height="4" rx="0.6" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="18.5" y="7" width="4.5" height="4" rx="0.6" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="2" y="12" width="4.5" height="4" rx="0.6" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="7.5" y="12" width="4.5" height="4" rx="0.6" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="13" y="12" width="4.5" height="4" rx="0.6" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="18.5" y="12" width="4.5" height="4" rx="0.6" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
        </>
      );
      break;

    case 'many-4cols':
      inner = (
        <>
          <rect x="2" y="2" width="4.5" height="6.5" rx="0.8" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="7.5" y="2" width="4.5" height="6.5" rx="0.8" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="13" y="2" width="4.5" height="6.5" rx="0.8" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="18.5" y="2" width="4.5" height="6.5" rx="0.8" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="2" y="9.5" width="4.5" height="6.5" rx="0.8" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="7.5" y="9.5" width="4.5" height="6.5" rx="0.8" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="13" y="9.5" width="4.5" height="6.5" rx="0.8" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="18.5" y="9.5" width="4.5" height="6.5" rx="0.8" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
        </>
      );
      break;

    case 'many-3cols':
      inner = (
        <>
          <rect x="2" y="2" width="6" height="4" rx="0.8" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="9" y="2" width="6" height="4" rx="0.8" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="16" y="2" width="6" height="4" rx="0.8" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="2" y="7" width="6" height="4" rx="0.8" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="9" y="7" width="6" height="4" rx="0.8" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="16" y="7" width="6" height="4" rx="0.8" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="2" y="12" width="6" height="4" rx="0.8" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="9" y="12" width="6" height="4" rx="0.8" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="16" y="12" width="6" height="4" rx="0.8" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
        </>
      );
      break;

    default:
      inner = (
        <>
          <rect x="2" y="2" width="9.5" height="6.5" rx="1.5" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="12.5" y="2" width="9.5" height="6.5" rx="1.5" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="2" y="9.5" width="9.5" height="6.5" rx="1.5" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <rect x="12.5" y="9.5" width="9.5" height="6.5" rx="1.5" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
        </>
      );
      break;
  }

  return (
    <svg
      width="20"
      height="15"
      viewBox="0 0 24 18"
      fill="none"
      className="split-preset-svg"
      aria-hidden="true"
    >
      {inner}
    </svg>
  );
}

const GAP = 8;
const EDGE_MARGIN = 8;

export default function SplitLayoutPicker({
  count,
  activePreset,
  onSelectPreset,
}: SplitLayoutPickerProps) {
  const [open, setOpen] = useState(false);
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties>({});
  const triggerEl = useRef<HTMLButtonElement | null>(null);
  const popoverEl = useRef<HTMLDivElement | null>(null);

  const presets = getAvailablePresets(count);

  const updatePlacement = useCallback(() => {
    if (!triggerEl.current) return;
    const r = triggerEl.current.getBoundingClientRect();
    const width = popoverEl.current?.offsetWidth ?? 220;
    const height = popoverEl.current?.offsetHeight ?? 360;

    // The trigger sits near the bottom right. Align the right edge of the popover
    // to the trigger's right edge so it opens inward rather than spilling off-screen
    // or under a right sidebar.
    let left = r.right - width;
    if (left < EDGE_MARGIN) {
      left = Math.max(EDGE_MARGIN, Math.min(r.left, window.innerWidth - width - EDGE_MARGIN));
    } else if (left + width > window.innerWidth - EDGE_MARGIN) {
      left = window.innerWidth - width - EDGE_MARGIN;
    }

    const openBelow = r.top < height && window.innerHeight - r.bottom >= height;
    setPopoverStyle({
      position: 'fixed',
      left: `${left}px`,
      ...(openBelow
        ? { top: `${Math.min(window.innerHeight - height - EDGE_MARGIN, r.bottom + GAP)}px` }
        : { bottom: `${Math.max(EDGE_MARGIN, window.innerHeight - r.top + GAP)}px` }),
      zIndex: 12000,
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    updatePlacement();
    const id = requestAnimationFrame(updatePlacement);
    return () => cancelAnimationFrame(id);
  }, [open, updatePlacement]);

  // Click outside & Escape listener
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node | null;
      if (
        triggerEl.current?.contains(target) ||
        popoverEl.current?.contains(target)
      ) {
        return;
      }
      setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
        triggerEl.current?.focus();
      }
    }
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  if (presets.length <= 1) {
    return null;
  }

  const activePresetObj = presets.find((p) => p.id === activePreset) ?? presets[0];

  return (
    <div className="split-layout-picker">
      <button
        ref={triggerEl}
        type="button"
        className={`split-layout-btn${open ? ' open' : ''}`}
        onClick={() => setOpen((prev) => !prev)}
        title={`Change Split Layout (Currently: ${activePresetObj?.name ?? 'Default'})`}
        aria-label="Change Split Layout"
        aria-haspopup="true"
        aria-expanded={open}
      >
        <PresetThumbnail presetId={activePreset} active={open} />
        <span className="split-layout-label">{activePresetObj?.name ?? 'Layout'}</span>
        <svg
          className="split-layout-chevron"
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open &&
        createPortal(
          <div
            ref={popoverEl}
            className="split-layout-popover"
            style={popoverStyle}
            role="menu"
            aria-label="Split layout options"
          >
            <div className="split-layout-popover-header">
              <span className="split-layout-popover-title">Split Layout</span>
              <span className="split-layout-popover-count">{count} Panes</span>
            </div>
            <div className="split-layout-options">
              {presets.map((preset) => {
                const isSelected = preset.id === activePreset;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    className={`split-preset-item${isSelected ? ' selected' : ''}`}
                    onClick={() => {
                      onSelectPreset(preset.id);
                      setOpen(false);
                    }}
                    role="menuitem"
                  >
                    <div className="split-preset-icon-box">
                      <PresetThumbnail presetId={preset.id} active={isSelected} />
                    </div>
                    <div className="split-preset-info">
                      <span className="split-preset-name">{preset.name}</span>
                      <span className="split-preset-desc">{preset.description}</span>
                    </div>
                    {isSelected && (
                      <svg
                        className="split-preset-check"
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    )}
                  </button>
                );
              })}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
