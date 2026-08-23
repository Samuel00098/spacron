import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import './ToolsMenu.css';

// The single launcher for every room / drawer tool, replacing the old
// `.room-dock` strip that used to sit above the composer. It lives inside the
// floating prompt bar, so the menu always opens upward from the bottom of the
// window and is portaled to <body> — the bar and the workspace overlays both
// clip their content, and the bar's `backdrop-filter` would otherwise become
// the containing block for a fixed child (see [[modal-containing-block-gotcha]]).

/** Structurally identical to AppShell's `ActivityItem` so its lists pass straight in. */
export type ToolMenuItem = {
  id: string;
  title: string;
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
};

export type ToolMenuGroup = {
  id: string;
  label: string;
  items: ToolMenuItem[];
};

interface ToolsMenuProps {
  groups: ToolMenuGroup[];
}

/** Gap kept between the menu and the trigger / the window edge. */
const GAP = 8;
const EDGE_MARGIN = 8;

export default function ToolsMenu({ groups }: ToolsMenuProps) {
  const [open, setOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const rootEl = useRef<HTMLDivElement | null>(null);
  const triggerEl = useRef<HTMLButtonElement | null>(null);
  const menuEl = useRef<HTMLDivElement | null>(null);

  // Flat order of the rendered items, for arrow-key roving.
  const itemEls = useRef<(HTMLButtonElement | null)[]>([]);
  const flatCount = groups.reduce((n, group) => n + group.items.length, 0);

  // Any tool currently open lights the trigger, so the collapsed menu still
  // says "something in here is on" the way the lit dock buttons used to.
  const anyActive = groups.some((group) => group.items.some((item) => item.active));

  /**
   * Anchor the menu above the trigger and clamp it back inside the window. The
   * trigger sits at the right end of the prompt bar, so the menu hangs from its
   * right edge and grows leftwards. Measured after paint so the content-sized
   * width is known before it lands.
   */
  const updatePlacement = useCallback(() => {
    if (!triggerEl.current) return;
    const r = triggerEl.current.getBoundingClientRect();
    const width = menuEl.current?.offsetWidth ?? 0;

    const left = Math.max(
      EDGE_MARGIN,
      Math.min(r.right - width, window.innerWidth - width - EDGE_MARGIN),
    );

    setMenuStyle({
      position: 'fixed',
      left: `${left}px`,
      bottom: `${Math.max(EDGE_MARGIN, window.innerHeight - r.top + GAP)}px`,
      maxHeight: `${Math.max(160, r.top - GAP - EDGE_MARGIN)}px`,
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    updatePlacement();
    // Second pass once the menu has been measured at its natural width.
    const id = requestAnimationFrame(updatePlacement);
    return () => cancelAnimationFrame(id);
  }, [open, updatePlacement, flatCount]);

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (rootEl.current?.contains(target) || menuEl.current?.contains(target)) return;
      setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
      triggerEl.current?.focus();
    }
    function reposition() {
      updatePlacement();
    }

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', reposition);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', reposition);
    };
  }, [open, updatePlacement]);

  // Focus the first item on open so the menu is usable from the keyboard.
  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => itemEls.current[0]?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  function moveFocus(from: number, delta: number) {
    const next = (from + delta + flatCount) % flatCount;
    itemEls.current[next]?.focus();
  }

  function handleItemKeyDown(event: React.KeyboardEvent, index: number) {
    // The grid is two columns wide, so Up/Down step a row and Left/Right a cell.
    if (event.key === 'ArrowDown') { event.preventDefault(); moveFocus(index, 2); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); moveFocus(index, -2); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); moveFocus(index, 1); }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); moveFocus(index, -1); }
  }

  function runItem(item: ToolMenuItem) {
    setOpen(false);
    item.onClick();
  }

  // Running index across groups — the arrow keys treat the menu as one list.
  let cursor = -1;

  return (
    <div className="tools-menu" ref={rootEl}>
      <button
        type="button"
        ref={triggerEl}
        className={`tools-trigger${open ? ' open' : ''}${anyActive ? ' has-active' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title="Tools — rooms, panels and utilities"
        aria-label="Tools"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
        </svg>
        <span className="tools-trigger-label">Tools</span>
        <svg className="tools-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="6 15 12 9 18 15" />
        </svg>
      </button>

      {open && createPortal(
        <div
          className="tools-menu-popover"
          ref={menuEl}
          style={menuStyle}
          role="menu"
          aria-label="Tools"
        >
          {groups.map((group) => (
            <div className="tools-group" key={group.id}>
              <div className="tools-group-label">{group.label}</div>
              <div className="tools-group-grid">
                {group.items.map((item) => {
                  cursor += 1;
                  const index = cursor;
                  return (
                    <button
                      type="button"
                      key={item.id}
                      ref={(el) => { itemEls.current[index] = el; }}
                      className={`tools-item${item.active ? ' active' : ''}`}
                      role="menuitem"
                      onClick={() => runItem(item)}
                      onKeyDown={(event) => handleItemKeyDown(event, index)}
                    >
                      <span className="tools-item-icon">{item.icon}</span>
                      <span className="tools-item-label">{item.title}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}
