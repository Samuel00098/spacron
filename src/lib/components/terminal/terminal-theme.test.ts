import { describe, expect, it } from 'vitest';
import {
  buildTerminalThemePalette,
  resolveTerminalBackground,
  resolveTerminalMinimumContrastRatio,
} from './terminal-theme';

function relativeLuminance(hex: string): number {
  const clean = hex.replace(/^#/, '');
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  const linearize = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

function contrastRatio(hexA: string, hexB: string): number {
  const lumA = relativeLuminance(hexA);
  const lumB = relativeLuminance(hexB);
  const bright = Math.max(lumA, lumB);
  const dark = Math.min(lumA, lumB);
  return (bright + 0.05) / (dark + 0.05);
}

describe('terminal-theme', () => {
  describe('resolveTerminalMinimumContrastRatio', () => {
    it('enforces 4.5 contrast ratio in light mode and 1 in dark mode', () => {
      expect(resolveTerminalMinimumContrastRatio(true)).toBe(4.5);
      expect(resolveTerminalMinimumContrastRatio(false)).toBe(1);
    });
  });

  describe('resolveTerminalBackground', () => {
    it('returns transparent rgba using light default RGB for canvas and dom renderers', () => {
      expect(resolveTerminalBackground(true, 'canvas')).toBe('rgba(239, 239, 239, 0)');
      expect(resolveTerminalBackground(true, 'dom')).toBe('rgba(239, 239, 239, 0)');
    });

    it('returns opaque rgb using light default RGB for webgl renderer', () => {
      expect(resolveTerminalBackground(true, 'webgl')).toBe('rgb(239, 239, 239)');
    });

    it('returns transparent rgba using dark default RGB for canvas and dom renderers', () => {
      expect(resolveTerminalBackground(false, 'canvas')).toBe('rgba(16, 16, 16, 0)');
      expect(resolveTerminalBackground(false, 'dom')).toBe('rgba(16, 16, 16, 0)');
    });

    it('returns opaque rgb using dark default RGB for webgl renderer', () => {
      expect(resolveTerminalBackground(false, 'webgl')).toBe('rgb(16, 16, 16)');
    });

    it('uses the provided CSS RGB string when its luminance matches the active mode', () => {
      expect(resolveTerminalBackground(true, 'canvas', ' 245, 240, 235 ')).toBe('rgba(245, 240, 235, 0)');
      expect(resolveTerminalBackground(false, 'webgl', '30, 32, 40')).toBe('rgb(30, 32, 40)');
    });

    it('rejects mismatched-luminance CSS RGB values during theme transitions', () => {
      expect(resolveTerminalBackground(true, 'canvas', '16, 16, 16')).toBe('rgba(239, 239, 239, 0)');
      expect(resolveTerminalBackground(false, 'canvas', '239, 239, 239')).toBe('rgba(16, 16, 16, 0)');
    });
  });

  describe('buildTerminalThemePalette', () => {
    it('builds high-contrast dark ink palette for light theme', () => {
      const theme = buildTerminalThemePalette(true, 'rgba(239, 239, 239, 0)');
      expect(theme).toMatchObject({
        background: 'rgba(239, 239, 239, 0)',
        foreground: '#171717',
        cursor: '#171717',
        cursorAccent: '#efefef',
        selectionBackground: 'rgba(0, 0, 0, 0.18)',
        selectionInactiveBackground: 'rgba(0, 0, 0, 0.10)',
        red: '#c42b2b',
        green: '#007a00',
        yellow: '#855c00',
        blue: '#0451a5',
        magenta: '#a800a8',
        cyan: '#00758a',
        white: '#4a4a4a',
        brightBlack: '#595959',
        brightWhite: '#595959',
      });
    });

    it('ensures every light palette foreground and ANSI color meets >= 4.5 contrast on #efefef', () => {
      const theme = buildTerminalThemePalette(true, 'rgba(239, 239, 239, 0)');
      const colorKeys = [
        'foreground',
        'cursor',
        'black',
        'red',
        'green',
        'yellow',
        'blue',
        'magenta',
        'cyan',
        'white',
        'brightBlack',
        'brightRed',
        'brightGreen',
        'brightYellow',
        'brightBlue',
        'brightMagenta',
        'brightCyan',
        'brightWhite',
      ] as const;

      for (const key of colorKeys) {
        const value = theme[key];
        expect(value).toBeTruthy();
        expect(contrastRatio('#efefef', value as string)).toBeGreaterThanOrEqual(4.5);
      }
    });

    it('builds light ink palette for dark theme', () => {
      const theme = buildTerminalThemePalette(false, 'rgba(16, 16, 16, 0)');
      expect(theme).toMatchObject({
        background: 'rgba(16, 16, 16, 0)',
        foreground: '#ffffff',
        cursor: '#ffffff',
        cursorAccent: '#000000',
        selectionBackground: 'rgba(255, 255, 255, 0.3)',
        blue: '#2472c8',
        green: '#0dbc79',
        yellow: '#e5e510',
      });
    });
  });
});
