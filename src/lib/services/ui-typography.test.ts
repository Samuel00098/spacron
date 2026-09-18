import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_UI_FONT_SIZE,
  MAX_UI_FONT_SIZE,
  MIN_UI_FONT_SIZE,
  applyUiFontSize,
  normaliseUiFontSize,
} from './ui-typography';

describe('UI typography', () => {
  it('normalises persisted values to the supported whole-pixel range', () => {
    expect(normaliseUiFontSize('16.4')).toBe(16);
    expect(normaliseUiFontSize(2)).toBe(MIN_UI_FONT_SIZE);
    expect(normaliseUiFontSize(200)).toBe(MAX_UI_FONT_SIZE);
    expect(normaliseUiFontSize('invalid')).toBe(DEFAULT_UI_FONT_SIZE);
  });

  it('publishes the live UI font variable', () => {
    const setProperty = vi.fn();
    const applied = applyUiFontSize(18, { style: { setProperty } } as unknown as HTMLElement);

    expect(setProperty).toHaveBeenCalledOnce();
    expect(setProperty).toHaveBeenCalledWith('--ui-font-size', '18px');
    expect(applied).toBe(18);
  });
});
