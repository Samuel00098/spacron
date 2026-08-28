import { describe, expect, it } from 'vitest';
import { formatShortcutLabel, isMacPlatform } from './shortcut-label';

describe('shortcut labels', () => {
  it('uses Apple modifier symbols on macOS', () => {
    expect(formatShortcutLabel('Ctrl+Shift+P', 'MacIntel')).toBe('⌘+⇧+P');
    expect(formatShortcutLabel('Ctrl+Alt+M', 'MacIntel')).toBe('⌘+⌥+M');
  });

  it('keeps canonical labels on non-Apple platforms', () => {
    expect(formatShortcutLabel('Ctrl+Shift+P', 'Win32')).toBe('Ctrl+Shift+P');
    expect(formatShortcutLabel('Ctrl+K', 'Linux x86_64')).toBe('Ctrl+K');
  });

  it('recognizes Mac user agents when platform is unavailable', () => {
    expect(isMacPlatform('', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)')).toBe(true);
    expect(isMacPlatform('', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe(false);
  });
});
