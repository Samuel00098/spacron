import { describe, expect, it } from 'vitest';
import {
  defaultShortcuts,
  matchShortcut,
  parseShortcutString,
  shortcutActions,
} from './settings';

/**
 * The characters a US layout produces when Shift is held. `KeyboardEvent.key`
 * reports the produced character, so this is what a handler actually sees — and
 * synthesizing events any other way would let a broken binding pass.
 */
const SHIFTED: Record<string, string> = {
  '`': '~', '1': '!', '2': '@', '3': '#', '4': '$', '5': '%', '6': '^',
  '7': '&', '8': '*', '9': '(', '0': ')', '-': '_', '=': '+',
  '[': '{', ']': '}', ';': ':', ',': '<', '.': '>', '/': '?',
};

const MODIFIERS = ['ctrl', 'shift', 'alt', 'meta'];

const CODE_FOR: Record<string, string> = {
  '`': 'Backquote', '-': 'Minus', '=': 'Equal', '[': 'BracketLeft',
  ']': 'BracketRight', ';': 'Semicolon', "'": 'Quote', ',': 'Comma',
  '.': 'Period', '/': 'Slash', ' ': 'Space',
};

function codeFor(primary: string): string {
  if (primary.length === 1 && /[a-z]/i.test(primary)) return `Key${primary.toUpperCase()}`;
  if (/^\d$/.test(primary)) return `Digit${primary}`;
  if (primary.toLowerCase() === 'space') return 'Space';
  return CODE_FOR[primary] ?? '';
}

/** The keydown a US-layout keyboard really delivers for a binding string. */
function keyEventFor(keys: string, overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  const parts = parseShortcutString(keys);
  const ctrlKey = parts.some((p) => p.toLowerCase() === 'ctrl');
  const shiftKey = parts.some((p) => p.toLowerCase() === 'shift');
  const altKey = parts.some((p) => p.toLowerCase() === 'alt');
  const metaKey = parts.some((p) => p.toLowerCase() === 'meta');
  const primary = parts.find((p) => !MODIFIERS.includes(p.toLowerCase())) ?? '';

  let key = primary;
  if (primary.toLowerCase() === 'space') {
    key = ' ';
  } else if (primary.length === 1) {
    if (shiftKey) key = /[a-z]/i.test(primary) ? primary.toUpperCase() : (SHIFTED[primary] ?? primary);
    else if (/[a-z]/i.test(primary)) key = primary.toLowerCase();
  }

  return { key, code: codeFor(primary), ctrlKey, shiftKey, altKey, metaKey, ...overrides } as KeyboardEvent;
}

describe('matchShortcut', () => {
  it('matches every default binding against the keydown it really produces', () => {
    const unreachable = defaultShortcuts
      .filter((shortcut) => !matchShortcut(keyEventFor(shortcut.keys), shortcut.keys))
      .map((shortcut) => `${shortcut.id} (${shortcut.keys})`);
    expect(unreachable).toEqual([]);
  });

  it('matches a shifted punctuation key by its unshifted key cap', () => {
    // `Ctrl+Shift+\`` arrives as `~`. Comparing raw characters made New Terminal
    // Tab — and every other shifted-punctuation binding — impossible to press.
    const event = { key: '~', code: 'Backquote', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false } as KeyboardEvent;
    expect(matchShortcut(event, 'Ctrl+Shift+`')).toBe(true);
    expect(matchShortcut(event, 'Ctrl+`')).toBe(false);
  });

  it('falls back to the physical key when a modifier mangles the character', () => {
    // macOS Option+Shift+F produces `Ï`; the binding must still resolve.
    const event = { key: 'Ï', code: 'KeyF', ctrlKey: false, shiftKey: true, altKey: true, metaKey: false } as KeyboardEvent;
    expect(matchShortcut(event, 'Alt+Shift+F')).toBe(true);
  });

  it('does not let the physical key override a layout that produced ASCII', () => {
    // On AZERTY, pressing A reports key `a` with code `KeyQ`. Matching on code
    // would fire the Ctrl+Q binding instead.
    const event = { key: 'a', code: 'KeyQ', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false } as KeyboardEvent;
    expect(matchShortcut(event, 'Ctrl+Q')).toBe(false);
    expect(matchShortcut(event, 'Ctrl+A')).toBe(true);
  });

  it('treats Cmd as Ctrl, but honours an explicit Meta binding', () => {
    const cmd = { key: 'k', code: 'KeyK', ctrlKey: false, shiftKey: false, altKey: false, metaKey: true } as KeyboardEvent;
    const ctrl = { key: 'k', code: 'KeyK', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false } as KeyboardEvent;
    expect(matchShortcut(cmd, 'Ctrl+K')).toBe(true);
    expect(matchShortcut(ctrl, 'Ctrl+K')).toBe(true);
    expect(matchShortcut(cmd, 'Meta+K')).toBe(true);
    expect(matchShortcut(ctrl, 'Meta+K')).toBe(false);
  });

  it('accepts either spelling of the zoom-in key', () => {
    const equals = keyEventFor('Ctrl+=');
    expect(matchShortcut(equals, 'Ctrl+=')).toBe(true);
    expect(matchShortcut(equals, 'Ctrl++')).toBe(true);
  });

  it('requires the exact modifier set', () => {
    const event = keyEventFor('Ctrl+Shift+F');
    expect(matchShortcut(event, 'Ctrl+F')).toBe(false);
    expect(matchShortcut(event, 'Ctrl+Alt+Shift+F')).toBe(false);
    expect(matchShortcut(event, '')).toBe(false);
    expect(matchShortcut(event, 'Ctrl+Shift')).toBe(false);
  });
});

describe('defaultShortcuts', () => {
  it('binds each key combination exactly once', () => {
    const byKeys = new Map<string, string[]>();
    for (const shortcut of defaultShortcuts) {
      const key = shortcut.keys.toLowerCase();
      byKeys.set(key, [...(byKeys.get(key) ?? []), shortcut.id]);
    }
    const clashes = [...byKeys.entries()]
      .filter(([, ids]) => ids.length > 1)
      .map(([keys, ids]) => `${keys}: ${ids.join(', ')}`);
    expect(clashes).toEqual([]);
  });

  it('never lets one binding also answer another binding’s keys', () => {
    const overlaps: string[] = [];
    for (const pressed of defaultShortcuts) {
      const event = keyEventFor(pressed.keys);
      for (const other of defaultShortcuts) {
        if (other.id === pressed.id) continue;
        if (matchShortcut(event, other.keys)) {
          overlaps.push(`${pressed.keys} (${pressed.id}) also fires ${other.id}`);
        }
      }
    }
    expect(overlaps).toEqual([]);
  });

  it('stays in step with the action list the shortcut editor offers', () => {
    const actionIds = new Set(shortcutActions.map((action) => action.id));
    const defaultIds = new Set(defaultShortcuts.map((shortcut) => shortcut.id));
    expect([...defaultIds].filter((id) => !actionIds.has(id))).toEqual([]);
    expect([...actionIds].filter((id) => !defaultIds.has(id))).toEqual([]);
  });
});
