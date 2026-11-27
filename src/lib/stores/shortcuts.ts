export interface KeyboardShortcut {
  id: string;
  label: string;
  keys: string;
  action?: string; // For custom shortcuts: id of the app action (see shortcutActions) this key triggers
}

export interface ShortcutAction {
  id: string;
  label: string;
  category: ShortcutCategory;
}

export const SHORTCUT_CATEGORY_ORDER = [
  'General',
  'Project',
  'Layout',
  'Rooms',
  'Sidebar Tools',
  'Terminal',
  'Editor',
  'Voice',
  'Window',
  'Custom Shortcuts',
] as const;

export type ShortcutCategory = (typeof SHORTCUT_CATEGORY_ORDER)[number];

/**
 * Built-in shortcut ids whose actions have been deleted or retired. Listed so
 * a persisted `userShortcuts` from an older build is cleaned up rather than
 * carrying dead entries in Settings or holding keys hostage.
 */
export const RETIRED_SHORTCUT_IDS = new Set([
  'canvasZoomIn',
  'canvasZoomOut',
  'canvasResetZoom',
  'goToOrchestrator',
  'goToYoutube',
  'openDailyNote',
  'toggleSketch',
  'launchVoiceMode',
  'toggleProjectHUD',
  'startProxy',
  'stopProxy',
  'quickCapture',
]);

export const shortcutActions: ShortcutAction[] = [
  { id: 'commandPalette', label: 'Command Palette', category: 'General' },
  { id: 'openSettings', label: 'Open Settings', category: 'General' },
  { id: 'openSearch', label: 'Search in Files', category: 'General' },
  { id: 'spawnAgent', label: 'Spawn Agent', category: 'General' },

  { id: 'openFolder', label: 'Open Project', category: 'Project' },
  { id: 'newWorkspace', label: 'Create Project', category: 'Project' },

  { id: 'toggleSidebar', label: 'Toggle Left Sidebar', category: 'Layout' },
  { id: 'toggleRightSidebar', label: 'Toggle Right Sidebar', category: 'Layout' },
  { id: 'cycleAmbientLayout', label: 'Toggle Split / Focus Layout', category: 'Layout' },

  { id: 'goToTerminal', label: 'Go to Terminal', category: 'Rooms' },
  { id: 'goToEditor', label: 'Go to Editor', category: 'Rooms' },
  { id: 'goToPreview', label: 'Toggle Browser', category: 'Rooms' },
  { id: 'goToTasks', label: 'Toggle Tasks', category: 'Rooms' },
  { id: 'goToSketch', label: 'Toggle Sketch', category: 'Rooms' },
  { id: 'goToLibrary', label: 'Toggle Library', category: 'Rooms' },

  { id: 'goToReview', label: 'Code Review (Diff)', category: 'Sidebar Tools' },
  { id: 'goToFleet', label: 'Sessions', category: 'Sidebar Tools' },
  { id: 'goToHttp', label: 'HTTP Client', category: 'Sidebar Tools' },
  { id: 'goToDb', label: 'Database Explorer', category: 'Sidebar Tools' },
  { id: 'goToContainers', label: 'Containers', category: 'Sidebar Tools' },
  { id: 'goToToolbox', label: 'Dev Toolbox', category: 'Sidebar Tools' },
  { id: 'openEnvManager', label: 'Environment Manager', category: 'Sidebar Tools' },

  { id: 'newTerminal', label: 'New Terminal Tab', category: 'Terminal' },
  { id: 'toggleInteractionMode', label: 'Toggle Terminal / Chat View', category: 'Terminal' },

  { id: 'saveFile', label: 'Save File', category: 'Editor' },
  { id: 'formatDocument', label: 'Format Document', category: 'Editor' },

  { id: 'transcribeToTerminal', label: 'Dictate (speech to text)', category: 'Voice' },

  { id: 'zoomIn', label: 'Zoom In', category: 'Window' },
  { id: 'zoomOut', label: 'Zoom Out', category: 'Window' },
  { id: 'resetZoom', label: 'Reset Zoom', category: 'Window' },
];

export const defaultShortcuts: KeyboardShortcut[] = [
  { id: 'commandPalette', label: 'Command Palette', keys: 'Ctrl+Shift+P' },
  { id: 'openSettings', label: 'Open Settings', keys: 'Ctrl+,' },
  { id: 'openSearch', label: 'Search in Files', keys: 'Ctrl+Shift+F' },
  { id: 'spawnAgent', label: 'Spawn Agent', keys: 'Ctrl+Shift+A' },

  { id: 'openFolder', label: 'Open Project', keys: 'Ctrl+O' },
  { id: 'newWorkspace', label: 'Create Project', keys: 'Ctrl+N' },

  { id: 'toggleSidebar', label: 'Toggle Left Sidebar', keys: 'Ctrl+B' },
  { id: 'toggleRightSidebar', label: 'Toggle Right Sidebar', keys: 'Ctrl+Shift+B' },
  { id: 'cycleAmbientLayout', label: 'Toggle Split / Focus Layout', keys: 'Alt+Shift+L' },

  { id: 'goToTerminal', label: 'Go to Terminal', keys: 'Ctrl+`' },
  { id: 'goToEditor', label: 'Go to Editor', keys: 'Ctrl+E' },
  { id: 'goToPreview', label: 'Toggle Browser', keys: 'Ctrl+Shift+V' },
  { id: 'goToTasks', label: 'Toggle Tasks', keys: 'Ctrl+Shift+T' },
  { id: 'goToSketch', label: 'Toggle Sketch', keys: 'Alt+Shift+S' },
  { id: 'goToLibrary', label: 'Toggle Library', keys: 'Alt+Shift+I' },

  { id: 'goToReview', label: 'Code Review (Diff)', keys: 'Ctrl+Shift+R' },
  { id: 'goToFleet', label: 'Sessions', keys: 'Ctrl+Shift+G' },
  { id: 'goToHttp', label: 'HTTP Client', keys: 'Ctrl+Shift+H' },
  { id: 'goToDb', label: 'Database Explorer', keys: 'Ctrl+Shift+D' },
  { id: 'goToContainers', label: 'Containers', keys: 'Ctrl+Shift+C' },
  { id: 'goToToolbox', label: 'Dev Toolbox', keys: 'Ctrl+Shift+X' },
  { id: 'openEnvManager', label: 'Environment Manager', keys: 'Ctrl+Shift+E' },

  { id: 'newTerminal', label: 'New Terminal Tab', keys: 'Ctrl+Shift+`' },
  { id: 'toggleInteractionMode', label: 'Toggle Terminal / Chat View', keys: 'Ctrl+Shift+J' },

  { id: 'saveFile', label: 'Save File', keys: 'Ctrl+S' },
  { id: 'formatDocument', label: 'Format Document', keys: 'Alt+Shift+F' },

  { id: 'transcribeToTerminal', label: 'Dictate (speech to text)', keys: 'Ctrl+Shift+M' },

  { id: 'zoomIn', label: 'Zoom In', keys: 'Ctrl+=' },
  { id: 'zoomOut', label: 'Zoom Out', keys: 'Ctrl+-' },
  { id: 'resetZoom', label: 'Reset Zoom', keys: 'Ctrl+0' },
];

export function parseShortcutString(str: string): string[] {
  const trimmed = str.trim();
  if (trimmed.endsWith('+') && trimmed.length > 1) {
    const lastPlus = trimmed.slice(0, -1).lastIndexOf('+');
    if (lastPlus !== -1) {
      const modifiersStr = trimmed.slice(0, lastPlus);
      const parts = modifiersStr.split('+').map((p) => p.trim());
      parts.push('+');
      return parts;
    }
  }
  return trimmed.split('+').map((p) => p.trim());
}

// Shifted punctuation → the unshifted character printed on the same key.
//
// `KeyboardEvent.key` reports the *produced* character, so `Ctrl+Shift+\`` -
// which is how "New Terminal Tab" is written - arrives as `~`, not as `` ` ``.
// Comparing the raw characters made every shortcut on a shifted punctuation key
// unreachable. Canonicalising both sides through this table is what lets a
// binding be written with the key cap the user actually presses.
const UNSHIFTED_PUNCTUATION: Record<string, string> = {
  '~': '`', '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6',
  '&': '7', '*': '8', '(': '9', ')': '0', '_': '-', '+': '=',
  '{': '[', '}': ']', '|': '\\', ':': ';', '"': "'", '<': ',', '>': '.', '?': '/',
};

// `event.code` → the character that physical key prints on a US layout. Only
// consulted when `event.key` is not plain ASCII, which is the macOS case: Option
// (Alt) rewrites the produced character, so `Alt+Shift+F` arrives as `Ï` and
// nothing would ever match. Deliberately NOT the primary comparison — on a
// non-US layout `code` names the US key cap, so preferring it would fire the
// Ctrl+Q binding when an AZERTY user pressed Ctrl+A.
function keyFromCode(code: string | undefined): string | null {
  if (!code) return null;
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1].toLowerCase();
  const digit = /^Digit(\d)$/.exec(code);
  if (digit) return digit[1];
  const punctuation: Record<string, string> = {
    Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
    Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.',
    Slash: '/', Space: ' ',
  };
  return punctuation[code] ?? null;
}

function canonicalKey(key: string): string {
  const lower = key.toLowerCase();
  return UNSHIFTED_PUNCTUATION[lower] ?? lower;
}

export function matchShortcut(e: KeyboardEvent, shortcutKeys: string): boolean {
  if (!shortcutKeys) return false;
  const parts = parseShortcutString(shortcutKeys).map((p) => p.toLowerCase());

  const hasCtrl = parts.includes('ctrl');
  const hasShift = parts.includes('shift');
  const hasAlt = parts.includes('alt');
  const hasMeta = parts.includes('meta');

  const modifiers = ['ctrl', 'shift', 'alt', 'meta'];
  const primaryKeyPart = parts.find((p) => !modifiers.includes(p));
  if (!primaryKeyPart) return false;

  // A binding written with `Ctrl` matches Cmd on macOS, which is why Meta counts
  // as Ctrl here. A binding that names `Meta` explicitly is the exception: it
  // wants the Meta key specifically, so Ctrl is checked on its own.
  const isCtrlPressed = hasMeta ? e.ctrlKey : (e.ctrlKey || e.metaKey);
  const ctrlMatch = isCtrlPressed === hasCtrl;
  const shiftMatch = e.shiftKey === hasShift;
  const altMatch = e.altKey === hasAlt;
  const metaMatch = hasMeta ? e.metaKey : true;

  let keyMatch = false;
  const eventKeyLower = e.key.toLowerCase();
  const targetKeyLower = primaryKeyPart.toLowerCase();

  if (targetKeyLower === 'space') {
    keyMatch = eventKeyLower === ' ' || eventKeyLower === 'space';
  } else if (targetKeyLower === 'esc' || targetKeyLower === 'escape') {
    keyMatch = eventKeyLower === 'escape' || eventKeyLower === 'esc';
  } else {
    keyMatch = canonicalKey(eventKeyLower) === canonicalKey(targetKeyLower);
    if (!keyMatch && !/^[\x20-\x7e]$/.test(e.key)) {
      const fromCode = keyFromCode(e.code);
      keyMatch = fromCode !== null && canonicalKey(fromCode) === canonicalKey(targetKeyLower);
    }
  }

  return ctrlMatch && shiftMatch && altMatch && metaMatch && keyMatch;
}

export function getDefaultShortcutKeys(id: string): string {
  return defaultShortcuts.find((s) => s.id === id)?.keys ?? '';
}

export function findShortcutKeys(
  shortcuts: readonly KeyboardShortcut[] | null | undefined,
  actionId: string,
): string {
  const list = shortcuts ?? [];
  const binding = list.find((shortcut) => {
    if (!shortcut) return false;
    const target = shortcut.id.startsWith('custom_') ? shortcut.action : shortcut.id;
    return target === actionId && Boolean(shortcut.keys?.trim());
  });
  return binding?.keys || getDefaultShortcutKeys(actionId);
}

const BARE_MODIFIER_KEYS = new Set([
  'control',
  'shift',
  'alt',
  'meta',
  'altgraph',
  'os',
  'dead',
  'process',
  'unidentified',
]);

const NAMED_PRIMARY_KEYS: Record<string, string> = {
  enter: 'Enter',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
};

/**
 * Convert a live KeyboardEvent from the shortcut recorder into canonical
 * `Ctrl+Alt+Shift+Key` syntax. Returns `null` for bare modifiers or plain
 * non-function keys without modifiers.
 */
export function formatEventToShortcut(
  e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>,
): string | null {
  const rawKey = e.key ?? '';
  const lower = rawKey.toLowerCase();
  if (!rawKey || BARE_MODIFIER_KEYS.has(lower)) return null;

  let primary: string | null = null;
  let isFunctionKey = false;

  if (rawKey === ' ' || lower === 'spacebar' || e.code === 'Space') {
    primary = 'Space';
  } else if (/^f([1-9]|1[0-2])$/i.test(rawKey)) {
    primary = rawKey.toUpperCase();
    isFunctionKey = true;
  } else if (NAMED_PRIMARY_KEYS[lower]) {
    primary = NAMED_PRIMARY_KEYS[lower];
  } else if (rawKey.length === 1 && /^[\x21-\x7e]$/.test(rawKey)) {
    const base = UNSHIFTED_PUNCTUATION[rawKey] ?? rawKey;
    primary = /^[a-z]$/i.test(base) ? base.toUpperCase() : base;
  } else {
    const fromCode = keyFromCode(e.code);
    if (fromCode) {
      if (fromCode === ' ') {
        primary = 'Space';
      } else {
        primary = /^[a-z]$/i.test(fromCode) ? fromCode.toUpperCase() : fromCode;
      }
    }
  }

  if (!primary) return null;

  const hasCtrl = Boolean(e.ctrlKey || e.metaKey);
  const hasAlt = Boolean(e.altKey);
  const hasShift = Boolean(e.shiftKey);

  if (!hasCtrl && !hasAlt && !hasShift && !isFunctionKey) {
    return null;
  }

  const parts: string[] = [];
  if (hasCtrl) parts.push('Ctrl');
  if (hasAlt) parts.push('Alt');
  if (hasShift) parts.push('Shift');
  parts.push(primary);
  return parts.join('+');
}

const VALID_ACTION_IDS = new Set(shortcutActions.map((a) => a.id));

/**
 * Merge persisted user shortcuts with `defaultShortcuts`:
 * - Prunes retired built-in ids and custom shortcuts targeting retired actions
 * - Syncs labels of built-in shortcuts while preserving user-chosen key bindings
 * - Appends any newly added built-in defaults
 * - Orders built-ins canonically followed by custom shortcuts
 */
export function mergeDefaultShortcuts(initial: KeyboardShortcut[]): KeyboardShortcut[] {
  if (!Array.isArray(initial)) return defaultShortcuts.map((s) => ({ ...s }));

  const builtInById = new Map<string, KeyboardShortcut>();
  const custom: KeyboardShortcut[] = [];

  for (const item of initial) {
    if (!item || typeof item.id !== 'string') continue;
    if (RETIRED_SHORTCUT_IDS.has(item.id)) continue;

    if (item.id.startsWith('custom_')) {
      if (!item.action || RETIRED_SHORTCUT_IDS.has(item.action) || !VALID_ACTION_IDS.has(item.action)) {
        continue;
      }
      custom.push({ ...item });
      continue;
    }

    if (!builtInById.has(item.id)) {
      builtInById.set(item.id, { ...item });
    }
  }

  const mergedBuiltIns = defaultShortcuts.map((def) => {
    const existing = builtInById.get(def.id);
    if (!existing) return { ...def };
    return {
      ...existing,
      label: def.label,
      keys: typeof existing.keys === 'string' && existing.keys.trim() ? existing.keys : def.keys,
    };
  });

  return [...mergedBuiltIns, ...custom];
}
