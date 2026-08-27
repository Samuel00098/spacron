import { describe, expect, it } from 'vitest';
import {
  getAvailablePresets,
  getDefaultPreset,
  getSplitPaneStyle,
  getSplitStageStyle,
  isSafePresetId,
  resolvePreset,
  splitColumnCount,
  splitPaneSpansRow,
  splitUsesTwoRows,
} from './split-layout';

describe('splitColumnCount', () => {
  it('is a single column for an empty or solo stage', () => {
    expect(splitColumnCount(0)).toBe(1);
    expect(splitColumnCount(1)).toBe(1);
  });

  it('uses two columns for 2–4 panes (side-by-side, 2+1, 2×2)', () => {
    expect(splitColumnCount(2)).toBe(2);
    expect(splitColumnCount(3)).toBe(2);
    expect(splitColumnCount(4)).toBe(2);
  });

  it('wraps at three columns past four panes', () => {
    expect(splitColumnCount(5)).toBe(3);
    expect(splitColumnCount(6)).toBe(3);
    expect(splitColumnCount(12)).toBe(3);
  });
});

describe('splitUsesTwoRows', () => {
  it('is true only for the 3-pane 2+1 and the 4-pane 2×2', () => {
    expect(splitUsesTwoRows(2)).toBe(false);
    expect(splitUsesTwoRows(3)).toBe(true);
    expect(splitUsesTwoRows(4)).toBe(true);
    expect(splitUsesTwoRows(5)).toBe(false);
  });
});

describe('splitPaneSpansRow', () => {
  it('spans only the last pane of a 3-pane stage', () => {
    expect(splitPaneSpansRow(0, 3)).toBe(false);
    expect(splitPaneSpansRow(1, 3)).toBe(false);
    expect(splitPaneSpansRow(2, 3)).toBe(true);
  });

  it('never spans on 2- or 4-pane stages', () => {
    expect(splitPaneSpansRow(1, 2)).toBe(false);
    expect(splitPaneSpansRow(3, 4)).toBe(false);
  });
});

describe('preset layout resolution and presets', () => {
  it('returns appropriate presets for 2, 3, 4, 5, 6, and 7-12 panes', () => {
    const presets2 = getAvailablePresets(2);
    expect(presets2.map((p) => p.id)).toEqual(['2-cols', '2-rows', '2-left-master', '2-right-master']);

    const presets3 = getAvailablePresets(3);
    expect(presets3.map((p) => p.id)).toEqual([
      '3-top2-bottom1',
      '3-top1-bottom2',
      '3-left-master',
      '3-right-master',
      '3-cols',
    ]);

    const presets4 = getAvailablePresets(4);
    expect(presets4.map((p) => p.id)).toEqual([
      '4-grid',
      '4-left-master',
      '4-top1-bottom3',
      '4-cols',
    ]);

    const presets5 = getAvailablePresets(5);
    expect(presets5.map((p) => p.id)).toEqual([
      '5-top3-bottom2',
      '5-top2-bottom3',
      '5-left-master',
      '5-cols',
    ]);

    const presets6 = getAvailablePresets(6);
    expect(presets6.map((p) => p.id)).toEqual([
      '6-grid',
      '6-grid-2x3',
      '6-left-master',
      '6-cols',
    ]);

    const presetsMany = getAvailablePresets(8);
    expect(presetsMany.map((p) => p.id)).toEqual([
      'many-scroll',
      'many-dense-matrix',
      'many-4cols',
      'many-3cols',
    ]);

    expect(getAvailablePresets(1)).toEqual([]);
    expect(getAvailablePresets(13)).toEqual([]);
  });

  it('resolves valid and fallback presets', () => {
    expect(getDefaultPreset(2)).toBe('2-cols');
    expect(getDefaultPreset(3)).toBe('3-top2-bottom1');
    expect(getDefaultPreset(4)).toBe('4-grid');
    expect(getDefaultPreset(5)).toBe('5-top3-bottom2');
    expect(getDefaultPreset(6)).toBe('6-grid');
    expect(getDefaultPreset(9)).toBe('many-scroll');

    expect(resolvePreset('2-rows', 2)).toBe('2-rows');
    expect(resolvePreset('invalid-preset', 2)).toBe('2-cols');
    expect(resolvePreset(null, 3)).toBe('3-top2-bottom1');
    expect(resolvePreset('5-left-master', 5)).toBe('5-left-master');
    expect(resolvePreset('many-dense-matrix', 10)).toBe('many-dense-matrix');
  });

  it('validates safe preset IDs', () => {
    expect(isSafePresetId('3-left-master')).toBe(true);
    expect(isSafePresetId('5-top3-bottom2')).toBe(true);
    expect(isSafePresetId('6-grid-2x3')).toBe(true);
    expect(isSafePresetId('many-scroll')).toBe(true);
    expect(isSafePresetId('some-dangerous-script')).toBe(false);
    expect(isSafePresetId(null)).toBe(false);
  });
});

describe('getSplitStageStyle & getSplitPaneStyle', () => {
  it('applies grid styles for 2-pane presets', () => {
    const stage2Cols = getSplitStageStyle('2-cols', 2);
    expect(stage2Cols.className).toBe('split-grid');
    expect(stage2Cols.style?.gridTemplateColumns).toBe('repeat(2, minmax(0, 1fr))');

    const stage2Rows = getSplitStageStyle('2-rows', 2);
    expect(stage2Rows.style?.gridTemplateRows).toBe('repeat(2, minmax(0, 1fr))');

    const pane0 = getSplitPaneStyle('2-cols', 0, 2);
    expect(pane0.order).toBe(0);
  });

  it('applies grid styles and pane spans for 3-pane presets', () => {
    const stage3Default = getSplitStageStyle('3-top2-bottom1', 3);
    expect(stage3Default.className).toContain('split-grid');
    expect(stage3Default.className).toContain('split-2row');

    const pane0 = getSplitPaneStyle('3-top2-bottom1', 0, 3);
    const pane1 = getSplitPaneStyle('3-top2-bottom1', 1, 3);
    const pane2 = getSplitPaneStyle('3-top2-bottom1', 2, 3);

    expect(pane0).toMatchObject({ gridColumn: '1', gridRow: '1', order: 0 });
    expect(pane1).toMatchObject({ gridColumn: '2', gridRow: '1', order: 1 });
    expect(pane2).toMatchObject({ gridColumn: '1 / -1', gridRow: '2', order: 2 });
  });

  it('applies grid styles for 4-pane presets', () => {
    const pane0 = getSplitPaneStyle('4-grid', 0, 4);
    const pane3 = getSplitPaneStyle('4-grid', 3, 4);
    expect(pane0).toMatchObject({ gridColumn: '1', gridRow: '1', order: 0 });
    expect(pane3).toMatchObject({ gridColumn: '2', gridRow: '2', order: 3 });
  });

  it('applies grid styles and pane spans for 5-pane presets', () => {
    const pane0 = getSplitPaneStyle('5-top3-bottom2', 0, 5);
    const pane2 = getSplitPaneStyle('5-top3-bottom2', 2, 5);
    const pane3 = getSplitPaneStyle('5-top3-bottom2', 3, 5);
    const pane4 = getSplitPaneStyle('5-top3-bottom2', 4, 5);

    expect(pane0).toMatchObject({ gridColumn: '1 / span 2', gridRow: '1' });
    expect(pane2).toMatchObject({ gridColumn: '5 / span 2', gridRow: '1' });
    expect(pane3).toMatchObject({ gridColumn: '1 / span 3', gridRow: '2' });
    expect(pane4).toMatchObject({ gridColumn: '4 / span 3', gridRow: '2' });
  });

  it('applies grid styles for 6-pane and many-pane presets', () => {
    const stage6 = getSplitStageStyle('6-grid', 6);
    expect(stage6.style?.gridTemplateColumns).toBe('repeat(3, minmax(0, 1fr))');

    const stageDense = getSplitStageStyle('many-dense-matrix', 12);
    expect(stageDense.style?.gridTemplateColumns).toBe('repeat(4, minmax(0, 1fr))');

    const stageScroll = getSplitStageStyle('many-scroll', 8);
    expect(stageScroll.className).toContain('split-scroll');
  });
});
