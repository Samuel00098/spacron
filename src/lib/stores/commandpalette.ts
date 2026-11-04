import { writable, get } from '$lib/stores/storeCompat';
import { useCommandPaletteStore } from './zustand/commandpalette';
import { flushSync } from 'react-dom';
import { viewTransitionsReliable } from '$lib/utils/tauri';

function withTransition(fn: () => void) {
  const startViewTransition = (document as any).startViewTransition;
  if (
    startViewTransition &&
    viewTransitionsReliable() &&
    !window.matchMedia('(prefers-reduced-motion: reduce)').matches &&
    !(window as any).__spacron_transitioning
  ) {
    (window as any).__spacron_transitioning = true;
    try {
      const transition = startViewTransition.call(document, () => {
        flushSync(fn);
      });
      transition.finished?.finally(() => {
        (window as any).__spacron_transitioning = false;
      }).catch(() => {
        (window as any).__spacron_transitioning = false;
      });
      setTimeout(() => {
        (window as any).__spacron_transitioning = false;
      }, 1000);
    } catch (e) {
      (window as any).__spacron_transitioning = false;
      fn();
    }
  } else {
    fn();
  }
}

export type { Command } from './zustand/commandpalette';

function syncWritable<T>(key: string, defaultValue: T): import('$lib/stores/storeCompat').Writable<T> {
  const zustandVal = (useCommandPaletteStore.getState() as any)[key];
  const initial = zustandVal !== undefined ? zustandVal as T : defaultValue;
  const store = writable<T>(initial);
  void useCommandPaletteStore.subscribe((state) => {
    const next = (state as any)[key] as T | undefined;
    if (next !== undefined) store.set(next);
  });
  return {
    subscribe: store.subscribe,
    set(value: T) { (useCommandPaletteStore.getState() as any).__set(key, value); },
    update(fn: (val: T) => T) {
      const current = (useCommandPaletteStore.getState() as any)[key] as T;
      (useCommandPaletteStore.getState() as any).__set(key, fn(current));
    },
  };
}

export const isOpen = syncWritable<boolean>('isOpen', false);
export const search = syncWritable<string>('search', '');
export const commands = syncWritable<any[]>('commands', []);

export function toggleCommandPalette() {
  withTransition(() => {
    isOpen.update((v) => !v);
    if (get(isOpen)) {
      search.set('');
    }
  });
}

import { newFolderPromptOpen, openProject, openProjectByPath, activeProject } from './workspace';
import { saveActiveFile, formatActiveFile } from './editor';
import { setActiveView, toggleSidebar, toggleEditorSplitPreview, toggleSidebarTab, openEnvManager, openSettings } from './layout';
import { createTerminalSession } from './terminal';
import { startProxy, stopProxy } from './preview';
import { toggleFloatingSearch } from './projectsearch';
import { chatThreadState, getProjectThreads, selectChatThread } from './chatThreads';

export function initDefaultCommands() {
  const defaultCmds: any[] = [
    {
      id: 'file.save',
      name: 'Save Active File',
      category: 'File',
      shortcut: 'Ctrl+S',
      action: () => saveActiveFile(),
    },
    {
      id: 'project.open',
      name: 'Open Project...',
      category: 'Project',
      shortcut: 'Ctrl+O',
      action: () => openProject(),
    },
    {
      id: 'project.new_folder',
      name: 'Create Project...',
      category: 'Project',
      shortcut: 'Ctrl+N',
      action: () => newFolderPromptOpen.set(true),
    },
    {
      id: 'sidebar.toggle',
      name: 'Toggle Sidebar',
      category: 'View',
      shortcut: 'Ctrl+B',
      action: () => toggleSidebar(),
    },
    {
      id: 'search.project',
      name: 'Search in Files',
      category: 'View',
      shortcut: 'Ctrl+Shift+F',
      action: () => toggleFloatingSearch(),
    },
    {
      id: 'project.env',
      name: 'Environment Manager',
      category: 'Project',
      shortcut: 'Ctrl+Shift+E',
      action: () => openEnvManager(),
    },
    // ('Memory Graph' needs no entry here — it is a Tools-menu room now, so the
    // AppShell bridge registers it under Rooms automatically.)
    {
      id: 'view.editor',
      name: 'Go to Editor',
      category: 'View',
      shortcut: 'Ctrl+E',
      action: () => setActiveView('editor'),
    },
    {
      id: 'view.terminal',
      name: 'Go to Terminal',
      category: 'View',
      shortcut: 'Ctrl+`',
      action: () => setActiveView('terminal'),
    },
    {
      id: 'view.preview',
      name: 'Go to Preview',
      category: 'View',
      action: () => setActiveView('preview'),
    },
    {
      id: 'view.mobile',
      name: 'Go to Mobile Emulator',
      category: 'View',
      action: () => setActiveView('mobile'),
    },
    {
      id: 'view.settings',
      name: 'Go to Settings',
      category: 'View',
      // Settings is a modal, not a view. `setActiveView('settings')` set a field
      // nothing reads, so this command silently did nothing.
      action: () => openSettings(),
    },
    {
      id: 'terminal.new',
      name: 'New Terminal',
      category: 'Terminal',
      action: async () => {
        setActiveView('terminal');
        await createTerminalSession();
      },
    },
    {
      id: 'editor.split_preview',
      name: 'Toggle Editor + Preview Split',
      category: 'Editor',
      action: () => toggleEditorSplitPreview(),
    },
    {
      id: 'editor.format',
      name: 'Format Document (Prettier)',
      category: 'Editor',
      shortcut: 'Alt+Shift+F',
      action: () => formatActiveFile(),
    },
    {
      id: 'preview.start',
      name: 'Start Dev Proxy Server',
      category: 'Preview',
      action: () => startProxy(),
    },
    {
      id: 'preview.stop',
      name: 'Stop Dev Proxy Server',
      category: 'Preview',
      action: () => stopProxy(),
    },
    {
      id: 'theme.customize',
      name: 'Customize Theme...',
      category: 'Preferences',
      // Deep-links the section that actually holds the theme picker, rather than
      // dropping the user on General to go find it.
      action: () => openSettings('appearance'),
    },
  ];

  // Merge rather than replace: commands registered elsewhere (Tools-menu items
  // from AppShell, dynamically discovered themes) must survive a palette
  // remount, which re-runs this function. Defaults win on id collisions.
  commands.update((existing) => {
    const defaults = new Set(defaultCmds.map((c: any) => c.id));
    const extras = existing.filter((c: any) => !defaults.has(c.id));
    return [...defaultCmds, ...extras];
  });

  registerThreadCommands();
}

/** Register every chat thread as a palette command so threads are findable by
 *  title (T3's "palette thread search with snippets"). Called on init and
 *  whenever the thread store changes. */
export function registerThreadCommands(): void {
  const project = get(activeProject);
  if (!project) return;
  const threads = get(getProjectThreads(project.id));
  commands.update((existing) => {
    // Remove any previously registered thread commands.
    const others = existing.filter((c: any) => !c.id.startsWith('thread.switch.'));
    const threadCmds = threads.map((thread) => ({
      id: `thread.switch.${thread.id}`,
      name: thread.title,
      category: 'Threads',
      shortcut: undefined,
      action: () => {
        selectChatThread(project.id, thread.id);
      },
    }));
    return [...others, ...threadCmds];
  });
}

// Re-register thread commands whenever threads change, so new threads appear
// in the palette immediately.
chatThreadState.subscribe(() => {
  registerThreadCommands();
});

export function registerCommand(command: any) {
  commands.update((cmds) => {
    if (cmds.some((c: any) => c.id === command.id)) {
      return cmds.map((c: any) => (c.id === command.id ? command : c));
    }
    return [...cmds, command];
  });
}
