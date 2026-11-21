import { describe, expect, it } from 'vitest';
import { DEFAULT_CHAT_APPEARANCE, normalizeChatAppearance } from './chatViewSettings';

describe('chat view appearance settings', () => {
  it('falls back to defaults for missing or malformed saved values', () => {
    expect(normalizeChatAppearance(undefined)).toEqual(DEFAULT_CHAT_APPEARANCE);
    expect(normalizeChatAppearance('nonsense')).toEqual(DEFAULT_CHAT_APPEARANCE);
    expect(normalizeChatAppearance({ font: 42, width: 'huge', codeFontSize: 'big' })).toEqual(DEFAULT_CHAT_APPEARANCE);
    // Any installed family is a valid choice; characters that could break CSS are dropped.
    expect(normalizeChatAppearance({ font: 'Cascadia Code' }).font).toBe('Cascadia Code');
    expect(normalizeChatAppearance({ font: 'Evil"; } body {' }).font).toBe('Evil  body');
  });

  it('keeps valid choices and clamps sizes into range', () => {
    expect(normalizeChatAppearance({ font: 'terminal', fontSize: 99, codeFontSize: 2, width: 'full' })).toEqual({
      font: 'terminal',
      fontSize: 20,
      codeFontSize: 10,
      width: 'full',
      matchTerminal: false,
      contrast: 100,
    });
    expect(normalizeChatAppearance({ contrast: 400, matchTerminal: true })).toMatchObject({ contrast: 130, matchTerminal: true });
    expect(normalizeChatAppearance({ fontSize: 15.4 }).fontSize).toBe(15);
  });
});
