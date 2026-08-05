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

import { newWorkspacePromptOpen, newFolderPromptOpen, cloneRepoPromptOpen, openProject, openProjectByPath } from './workspace';
import { knowledgeGraphOpen } from '$lib/services/orchestrator/knowledge';
import { saveActiveFile, formatActiveFile } from './editor';
import { setActiveView, toggleSidebar, toggleEditorSplitPreview, toggleSidebarTab, openEnvManager } from './layout';
import { createTerminalSession } from './terminal';
import { startProxy, stopProxy } from './preview';
import { toggleFloatingSearch } from './projectsearch';

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
      id: 'workspace.new',
      name: 'New Workspace',
      category: 'Workspace',
      shortcut: 'Ctrl+N',
      action: () => newWorkspacePromptOpen.set(true),
    },
    {
      id: 'workspace.open',
      name: 'Open Folder...',
      category: 'Workspace',
      shortcut: 'Ctrl+O',
      action: () => openProject(),
    },
    {
      id: 'workspace.new_folder',
      name: 'New Folder...',
      category: 'Workspace',
      action: () => newFolderPromptOpen.set(true),
    },
    {
      id: 'workspace.clone_repo',
      name: 'Clone Repository...',
      category: 'Workspace',
      action: () => cloneRepoPromptOpen.set(true),
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
      id: 'workspace.env',
      name: 'Environment Manager',
      category: 'Workspace',
      shortcut: 'Ctrl+Shift+E',
      action: () => openEnvManager(),
    },
    {
      id: 'orchestrator.memory_graph',
      name: 'Memory Graph…',
      category: 'View',
      action: () => knowledgeGraphOpen.set(true),
    },
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
      id: 'view.settings',
      name: 'Go to Settings',
      category: 'View',
      action: () => setActiveView('settings'),
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
      action: () => setActiveView('settings'),
    },
  ];

  commands.set(defaultCmds);
}

export function registerCommand(command: any) {
  commands.update((cmds) => {
    if (cmds.some((c: any) => c.id === command.id)) {
      return cmds.map((c: any) => (c.id === command.id ? command : c));
    }
    return [...cmds, command];
  });
}
