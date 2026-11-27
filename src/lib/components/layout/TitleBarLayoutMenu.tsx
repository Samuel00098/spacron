import { useEffect, useRef, useState } from 'react';

export interface LayoutMenuItem {
  id: string;
  title: string;
  active?: boolean;
  icon: React.ReactNode;
  onClick: () => void;
}

/** The layout actions and Editor / Terminal / Preview launchers, as a title bar menu. */
export default function TitleBarLayoutMenu({ items }: { items: LayoutMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className="titlebar-layout-menu" ref={rootRef}>
      <button
        type="button"
        className={`icon-btn${open ? ' active' : ''}`}
        onClick={() => setOpen((value) => !value)}
        title="Layout and panels"
        aria-label="Layout and panels"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M12 4v16M12 12h9" />
        </svg>
      </button>
      {open && (
        <div className="titlebar-layout-popover" role="menu">
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className={item.active ? 'active' : undefined}
              onClick={() => {
                setOpen(false);
                item.onClick();
              }}
            >
              <span aria-hidden="true">{item.icon}</span>
              <span>{item.title}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
