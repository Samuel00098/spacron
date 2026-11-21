import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import './Dropdown.css';

// Premium custom dropdown matching the app's picker language (see
// FloatingPromptBar target-picker): frosted popover, rounded items, accent
// active state. Replaces native <select> so menus feel consistent.
export type DropdownOption = {
  value: string;
  label: string;
  sublabel?: string;
  /** Hover text explaining the option (shown on the item and on the trigger while selected). */
  tooltip?: string;
  color?: string;
  icon?: React.ReactNode;
  disabled?: boolean;
};

interface DropdownProps {
  options: DropdownOption[];
  value: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
  /** CSS selector for a container element to bound the dropdown within.
   *  When set, the menu will not extend past this element's edges. */
  boundarySelector?: string;
  /** Force the menu to open down or up, or let available space decide. */
  direction?: 'down' | 'up' | 'auto';
  /** Optional cap for compact contextual menus. */
  menuMaxHeight?: number;
  /** Extra class for a menu that needs context-specific styling. */
  menuClassName?: string;
}

// Menu max-height (keep in sync with .dd-menu max-height in CSS).
const MENU_MAX = 260;

/** Widest a content-sized menu may grow. Past this a long option ellipsizes
 *  rather than the menu spanning half the window. */
const MENU_MAX_WIDTH = 420;

/** Gap kept between a menu and the window edge when it has to be nudged back
 *  inside. */
const EDGE_MARGIN = 16;

export default function Dropdown({
  options,
  value,
  onChange,
  placeholder = 'Select…',
  ariaLabel = 'Select an option',
  disabled = false,
  boundarySelector,
  direction = 'auto',
  menuMaxHeight = MENU_MAX,
  menuClassName,
}: DropdownProps) {
  const [open, setOpen] = useState(false);
  const [dropUp, setDropUp] = useState(false);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const rootEl = useRef<HTMLDivElement | null>(null);
  const menuEl = useRef<HTMLDivElement | null>(null);

  const selected = options.find((o) => o.value === value) ?? null;

  /**
   * Position the menu. It is portaled to <body> with `position: fixed` so it can
   * never be clipped by an ancestor's `overflow` (the room panels that host this
   * dropdown clip their content), and the available space decides whether it
   * opens up or down and how tall it can grow before it scrolls.
   * When `boundarySelector` is provided, the menu stays inside that element's
   * bounds instead of extending past it (useful inside modals).
   */
  const updatePlacement = useCallback(() => {
    if (!rootEl.current) return;
    const r = rootEl.current.getBoundingClientRect();

    // Determine the bounding rect that constrains the menu.
    const edge = 16;
    const bottomEdge = 32;
    let boundTop = edge;
    let boundBottom = window.innerHeight - bottomEdge;
    if (boundarySelector) {
      const boundary = document.querySelector(boundarySelector);
      if (boundary) {
        const br = boundary.getBoundingClientRect();
        boundTop = Math.max(edge, br.top + edge);
        boundBottom = Math.min(window.innerHeight - bottomEdge, br.bottom - bottomEdge);
      }
    }

    // Anchored to the selector itself, above or below it — including in the
    // chat composer, where a menu opens right at the picker that was clicked.
    const topBase = r.bottom + 6;
    const below = boundBottom - topBase;
    const topAnchor = r.top;
    const above = topAnchor - boundTop;
    const boundedMenuMaxHeight = Math.max(60, Math.min(MENU_MAX, menuMaxHeight));
    const willDropUp = direction === 'up'
      ? true
      : direction === 'down'
        ? (below < 60 && above > below)
        : (below < Math.min(boundedMenuMaxHeight, 180) && above > below);
    setDropUp(willDropUp);

    const available = willDropUp ? above : below;
    const maxHeight = Math.max(60, Math.min(boundedMenuMaxHeight, available - 8));
    const next: CSSProperties = {
      position: 'fixed',
      left: r.left,
      // The trigger's width is the menu's FLOOR, not its size. An option list is
      // routinely wider than the control that opens it — the mobile panel's
      // resolution picker is a 116px "864p" trigger whose options read
      // "Sharpest · slowest" — and pinning the menu to the trigger collapsed
      // every one of those labels to an ellipsis. Sizing to content and only
      // then clamping (see the layout effect below) keeps a wide list readable
      // without ever making a menu narrower than it used to be.
      minWidth: r.width,
      width: 'max-content',
      maxWidth: Math.max(r.width, Math.min(MENU_MAX_WIDTH, window.innerWidth - EDGE_MARGIN * 2)),
      maxHeight,
    };
    if (willDropUp) {
      next.bottom = window.innerHeight - topAnchor + 6;
    } else {
      next.top = topBase;
    }
    setMenuStyle(next);
  }, [boundarySelector, direction, menuMaxHeight]);

  /**
   * Second placement pass. The menu sizes to its content, so its real width is
   * only knowable once it has rendered — which is also the moment it can be
   * clamped back inside the window or boundary. A menu opened near the right edge
   * (a picker in the right utility drawer, say) right-aligns with its trigger and
   * grows inward instead of running off-screen.
   *
   * `useLayoutEffect`, so the corrected position is the first one painted. The
   * width guard makes this converge: the second run computes the same `left`
   * and returns the previous style object unchanged.
   */
  useLayoutEffect(() => {
    if (!open || !menuEl.current || !rootEl.current) return;
    const menu = menuEl.current.getBoundingClientRect();
    const anchor = rootEl.current.getBoundingClientRect();
    if (menu.width === 0) return;

    let minLeft = EDGE_MARGIN;
    let maxRight = window.innerWidth - EDGE_MARGIN;
    if (boundarySelector) {
      const boundary = document.querySelector(boundarySelector);
      if (boundary) {
        const br = boundary.getBoundingClientRect();
        minLeft = Math.max(minLeft, br.left + EDGE_MARGIN);
        maxRight = Math.min(maxRight, br.right - EDGE_MARGIN);
      }
    }

    let left = anchor.left;
    if (left + menu.width > maxRight) {
      left = Math.min(anchor.right - menu.width, maxRight - menu.width);
    }
    left = Math.max(minLeft, left);

    setMenuStyle((prev) =>
      typeof prev.left === 'number' && Math.abs(prev.left - left) < 0.5 ? prev : { ...prev, left },
    );
  }, [open, menuStyle, boundarySelector]);

  function toggle() {
    if (disabled) return;
    if (!open) updatePlacement();
    setOpen((o) => !o);
  }

  function choose(option: DropdownOption) {
    if (option.disabled) return;
    onChange?.(option.value);
    setOpen(false);
  }

  function onKeydown(e: React.KeyboardEvent) {
    if (e.key === 'Escape' && open) {
      e.stopPropagation();
      setOpen(false);
      return;
    }
    if ((e.key === 'Enter' || e.key === ' ') && !open) {
      e.preventDefault();
      updatePlacement();
      setOpen(true);
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) {
        updatePlacement();
        setOpen(true);
        return;
      }
      const enabled = options.filter((o) => !o.disabled);
      if (enabled.length === 0) return;
      const idx = enabled.findIndex((o) => o.value === value);
      const next =
        e.key === 'ArrowDown'
          ? enabled[Math.min(enabled.length - 1, idx + 1)]
          : enabled[Math.max(0, idx - 1)];
      if (next) onChange?.(next.value);
    }
  }

  useEffect(() => {
    if (!open) return;
    const handlePointer = (e: PointerEvent) => {
      const target = e.target as Node;
      // The menu is portaled outside `rootEl`, so it must be checked separately —
      // otherwise clicking an option would register as an outside click and close
      // the menu before the selection fires.
      if (rootEl.current?.contains(target)) return;
      if (menuEl.current?.contains(target)) return;
      setOpen(false);
    };
    const reposition = () => updatePlacement();
    document.addEventListener('pointerdown', handlePointer, true);
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      document.removeEventListener('pointerdown', handlePointer, true);
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [open, updatePlacement]);

  return (
    <div className="dropdown" ref={rootEl}>
      <button
        type="button"
        className={`dd-trigger${open ? ' open' : ''}`}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        title={selected?.tooltip}
        onClick={toggle}
        onKeyDown={onKeydown}
      >
        {selected?.color && <span className="dd-dot" style={{ background: selected.color }}></span>}
        {selected?.icon && <span className="dd-icon">{selected.icon}</span>}
        <span className={`dd-value${!selected ? ' placeholder' : ''}`}>
          {selected?.label ?? placeholder}
        </span>
        <svg
          className="dd-chevron"
          width="11"
          height="11"
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
            ref={menuEl}
            className={`dd-menu${dropUp ? ' drop-up' : ''}${menuClassName ? ` ${menuClassName}` : ''}`}
            role="listbox"
            aria-label={ariaLabel}
            style={menuStyle}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return;
              event.preventDefault();
              event.stopPropagation();
              setOpen(false);
              rootEl.current?.querySelector('button')?.focus();
            }}
          >
            {options.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`dd-item${option.value === value ? ' active' : ''}`}
                disabled={option.disabled}
                role="option"
                title={option.tooltip}
                aria-selected={option.value === value}
                onClick={() => choose(option)}
              >
                {option.color && <span className="dd-dot" style={{ background: option.color }}></span>}
                {option.icon && <span className="dd-icon">{option.icon}</span>}
                <span className="dd-item-label">{option.label}</span>
                {option.sublabel && <span className="dd-item-sub">{option.sublabel}</span>}
                {option.value === value && (
                  <svg
                    className="dd-check"
                    width="13"
                    height="13"
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
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
