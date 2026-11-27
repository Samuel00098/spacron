import type { ITheme } from '@xterm/xterm';

/**
 * Enforce WCAG AA contrast in light mode so Windows ConPTY/PowerShell/agent CLI
 * white and pale truecolor output stays legible against `#efefef`, while keeping
 * dark-mode ANSI/truecolor colors untouched.
 */
export function resolveTerminalMinimumContrastRatio(isLightTheme: boolean): number {
  return isLightTheme ? 4.5 : 1;
}

/**
 * Resolve the xterm theme background value for the active appearance and renderer.
 * Canvas/DOM stay transparent (`rgba(..., 0)`) so the panel/frosted surface shows
 * through while still carrying the real RGB for OSC 11 queries; WebGL stays opaque
 * to prevent attributed glyph-atlas black boxes.
 */
export function resolveTerminalBackground(
  isLightTheme: boolean,
  renderer: string,
  cssSurfaceRgb?: string,
): string {
  const fallback = isLightTheme ? '239, 239, 239' : '16, 16, 16';
  let rgb = fallback;
  const match = cssSurfaceRgb?.match(/^\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*$/);
  if (match) {
    const r = Number(match[1]);
    const g = Number(match[2]);
    const b = Number(match[3]);
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (isLightTheme ? luminance >= 128 : luminance < 128) {
      rgb = `${r}, ${g}, ${b}`;
    }
  }
  return renderer === 'webgl' ? `rgb(${rgb})` : `rgba(${rgb}, 0)`;
}

/**
 * Build the xterm color palette matching either the light or dark application surface.
 */
export function buildTerminalThemePalette(isLightTheme: boolean, background: string): ITheme {
  if (isLightTheme) {
    return {
      background,
      foreground: '#171717',
      cursor: '#171717',
      cursorAccent: '#efefef',
      selectionBackground: 'rgba(0, 0, 0, 0.18)',
      selectionInactiveBackground: 'rgba(0, 0, 0, 0.10)',
      black: '#000000',
      red: '#c42b2b',
      green: '#007a00',
      yellow: '#855c00',
      blue: '#0451a5',
      magenta: '#a800a8',
      cyan: '#00758a',
      white: '#4a4a4a',
      brightBlack: '#595959',
      brightRed: '#c42b2b',
      brightGreen: '#007a00',
      brightYellow: '#855c00',
      brightBlue: '#0451a5',
      brightMagenta: '#a800a8',
      brightCyan: '#00758a',
      brightWhite: '#595959',
    };
  }

  return {
    background,
    foreground: '#ffffff',
    cursor: '#ffffff',
    cursorAccent: '#000000',
    selectionBackground: 'rgba(255, 255, 255, 0.3)',
    black: '#000000',
    red: '#cd3131',
    green: '#0dbc79',
    yellow: '#e5e510',
    blue: '#2472c8',
    magenta: '#bc3fbc',
    cyan: '#11a8cd',
    white: '#e5e5e5',
    brightBlack: '#666666',
    brightRed: '#f14c4c',
    brightGreen: '#23d18b',
    brightYellow: '#f5f543',
    brightBlue: '#3b8eea',
    brightMagenta: '#d670d6',
    brightCyan: '#29b8db',
    brightWhite: '#e5e5e5',
  };
}
