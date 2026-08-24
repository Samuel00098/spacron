import { useEffect, useMemo, useRef, useState } from 'react';
import { isOpen, search, commands, initDefaultCommands } from '$lib/stores/commandpalette';
import { useCommandPaletteStore } from '$lib/stores/zustand/commandpalette';
import { switchTheme } from '$lib/stores/theme';
import { isTauriRuntime } from '$lib/utils/tauri';
import { showToast } from '$lib/stores/notification';
import './CommandPalette.css';

export default function CommandPalette() {
  const open = useCommandPaletteStore((s) => s.isOpen);
  const query = useCommandPaletteStore((s) => s.search);
  const cmds = useCommandPaletteStore((s) => s.commands);

  const inputEl = useRef<HTMLInputElement | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    initDefaultCommands();
    setupThemeCommands();
  }, []);

  async function setupThemeCommands() {
    if (!isTauriRuntime()) return;
    try {
      // Dynamically load themes and register command palette entries for them.
      const { invoke } = await import('@tauri-apps/api/core');
      interface ThemeInfo {
        id: string;
        name: string;
        author: string;
      }
      const themes = await invoke<ThemeInfo[]>('theme_list');
      themes.forEach((theme) => {
        commands.update((list) => {
          const id = `theme.activate.${theme.id}`;
          if (list.some((c) => c.id === id)) return list;
          return [
            ...list,
            {
              id,
              name: `Use Theme: ${theme.name}`,
              category: 'Preferences',
              action: async () => {
                await switchTheme(theme.id);
              },
            },
          ];
        });
      });
    } catch (err) {
      console.error('Failed to register theme commands:', err);
    }
  }

  // Focus input when palette opens.
  useEffect(() => {
    if (!open) return;
    setSelectedIndex(0);
    const t = setTimeout(() => inputEl.current?.focus(), 50);
    return () => clearTimeout(t);
  }, [open]);

  const filteredCommands = useMemo(
    () =>
      cmds.filter(
        (cmd) =>
          cmd.name.toLowerCase().includes(query.toLowerCase()) ||
          cmd.category.toLowerCase().includes(query.toLowerCase()),
      ),
    [cmds, query],
  );

  // Typing shrinks the list; keep the selection inside it.
  const resultCount = filteredCommands.length;
  useEffect(() => {
    setSelectedIndex((i) => Math.min(i, Math.max(0, resultCount - 1)));
  }, [resultCount]);

  function executeCommand(cmd: (typeof filteredCommands)[number]) {
    // Close FIRST, then run. The overlay sits above the surfaces commands open
    // (the settings modal is z-index 9000, this overlay 9999), so the palette
    // must be gone before the thing it launched becomes visible — and a
    // throwing action below must never leave the palette stuck on screen.
    isOpen.set(false);
    const fail = (err: unknown) => {
      console.error(`Command '${cmd.id}' failed:`, err);
      showToast(`${cmd.name} failed — see the console for details`, 'error', 8000, true);
    };
    try {
      Promise.resolve(cmd.action()).catch(fail);
    } catch (err) {
      fail(err);
    }
  }

  // Keep the highlighted row visible as the selection moves with the arrow
  // keys. Done by adjusting the container's scrollTop directly —
  // scrollIntoView() also scrolls every other scrollable ancestor and can be
  // suppressed by CSS scroll behavior, which made it unreliable here.
  const resultsEl = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const box = resultsEl.current;
    if (!box) return;
    const el = box.querySelector<HTMLElement>('.command-item.selected');
    if (!el) return;
    const er = el.getBoundingClientRect();
    const br = box.getBoundingClientRect();
    const pad = 4;
    if (er.top < br.top + pad) {
      box.scrollTop += er.top - br.top - pad;
    } else if (er.bottom > br.bottom - pad) {
      box.scrollTop += er.bottom - br.bottom + pad;
    }
  }, [selectedIndex, filteredCommands]);

  // Hovering a row selects it — but only when the pointer actually moved.
  // Without this guard, scrolling the list with the arrow keys slides rows
  // under the stationary cursor, each firing mouseenter and yanking the
  // selection back: the classic "arrow keys don't work" palette bug.
  const pointerMovedRef = useRef(false);
  useEffect(() => {
    if (!open) return;
    const onMove = () => { pointerMovedRef.current = true; };
    window.addEventListener('pointermove', onMove);
    return () => window.removeEventListener('pointermove', onMove);
  }, [open]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (!open) return;
      if (filteredCommands.length === 0) {
        if (e.key === 'Escape') { e.preventDefault(); isOpen.set(false); }
        return;
      }

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        pointerMovedRef.current = false;
        setSelectedIndex((i) => (i + 1) % filteredCommands.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        pointerMovedRef.current = false;
        setSelectedIndex((i) => (i - 1 + filteredCommands.length) % filteredCommands.length);
      } else if (e.key === 'PageDown') {
        e.preventDefault();
        pointerMovedRef.current = false;
        setSelectedIndex((i) => Math.min(filteredCommands.length - 1, i + 5));
      } else if (e.key === 'PageUp') {
        e.preventDefault();
        pointerMovedRef.current = false;
        setSelectedIndex((i) => Math.max(0, i - 5));
      } else if (e.key === 'Home') {
        e.preventDefault();
        pointerMovedRef.current = false;
        setSelectedIndex(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        pointerMovedRef.current = false;
        setSelectedIndex(filteredCommands.length - 1);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (filteredCommands[selectedIndex]) {
          executeCommand(filteredCommands[selectedIndex]);
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        isOpen.set(false);
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, filteredCommands, selectedIndex]);

  if (!open) return null;

  return (
    <div className="command-palette-overlay" onClick={() => isOpen.set(false)}>
      <div className="command-palette" onClick={(e) => e.stopPropagation()}>
        <div className="search-container">
          <svg className="search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref={inputEl}
            type="text"
            placeholder="Type a command to execute..."
            value={query}
            onChange={(e) => search.set(e.target.value)}
            className="palette-input"
          />
        </div>

        <div className="results-container" ref={resultsEl}>
          {filteredCommands.length === 0 ? (
            <div className="no-results">No commands found matching "{query}"</div>
          ) : (
            filteredCommands.map((cmd, i) => (
              <div
                key={cmd.id}
                className={`command-item${i === selectedIndex ? ' selected' : ''}`}
                onClick={() => executeCommand(cmd)}
                onMouseEnter={() => { if (pointerMovedRef.current) setSelectedIndex(i); }}
              >
                <div className="command-details">
                  <span className="command-category">{cmd.category}</span>
                  <span className="command-name">{cmd.name}</span>
                </div>
                {cmd.shortcut && <span className="command-shortcut">{cmd.shortcut}</span>}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
