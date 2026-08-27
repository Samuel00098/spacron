import type React from 'react';

/**
 * Split stage tiling and preset layouts.
 *
 * Supports selectable preset arrangements from 2 up to 12 panes,
 * with responsive wrapping for large agent fleets.
 */

export type SplitPresetId =
  | 'single'
  // 2 panes
  | '2-cols'
  | '2-rows'
  | '2-left-master'
  | '2-right-master'
  // 3 panes
  | '3-top2-bottom1'
  | '3-top1-bottom2'
  | '3-left-master'
  | '3-right-master'
  | '3-cols'
  // 4 panes
  | '4-grid'
  | '4-left-master'
  | '4-top1-bottom3'
  | '4-cols'
  // 5 panes
  | '5-top3-bottom2'
  | '5-top2-bottom3'
  | '5-left-master'
  | '5-cols'
  // 6 panes
  | '6-grid'
  | '6-grid-2x3'
  | '6-left-master'
  | '6-cols'
  // 7-12 panes (Fleet & Swarms)
  | 'many-scroll'
  | 'many-dense-matrix'
  | 'many-4cols'
  | 'many-3cols'
  // fallback
  | 'auto-grid';

export interface SplitPreset {
  id: SplitPresetId;
  name: string;
  paneCount: number;
  description: string;
}

export const SPLIT_PRESETS_2: SplitPreset[] = [
  { id: '2-cols', name: 'Side by Side', paneCount: 2, description: 'Two vertical columns' },
  { id: '2-rows', name: 'Top & Bottom', paneCount: 2, description: 'Two horizontal rows' },
  { id: '2-left-master', name: 'Master Left', paneCount: 2, description: 'Wide left pane, narrow right pane' },
  { id: '2-right-master', name: 'Master Right', paneCount: 2, description: 'Narrow left pane, wide right pane' },
];

export const SPLIT_PRESETS_3: SplitPreset[] = [
  { id: '3-top2-bottom1', name: '2 Top, 1 Bottom', paneCount: 3, description: 'Two on top, full-width bottom' },
  { id: '3-top1-bottom2', name: '1 Top, 2 Bottom', paneCount: 3, description: 'Full-width top, two on bottom' },
  { id: '3-left-master', name: 'Master Left', paneCount: 3, description: 'Full-height left, two stacked right' },
  { id: '3-right-master', name: 'Master Right', paneCount: 3, description: 'Two stacked left, full-height right' },
  { id: '3-cols', name: '3 Columns', paneCount: 3, description: 'Three equal vertical columns' },
];

export const SPLIT_PRESETS_4: SplitPreset[] = [
  { id: '4-grid', name: '2×2 Grid', paneCount: 4, description: 'Equal two-by-two grid' },
  { id: '4-left-master', name: 'Master Left', paneCount: 4, description: 'Full-height left, three stacked right' },
  { id: '4-top1-bottom3', name: '1 Top, 3 Bottom', paneCount: 4, description: 'Full-width top, three columns below' },
  { id: '4-cols', name: '4 Columns', paneCount: 4, description: 'Four equal vertical columns' },
];

export const SPLIT_PRESETS_5: SplitPreset[] = [
  { id: '5-top3-bottom2', name: '3 Top, 2 Bottom', paneCount: 5, description: 'Three top, two wide bottom' },
  { id: '5-top2-bottom3', name: '2 Top, 3 Bottom', paneCount: 5, description: 'Two wide top, three bottom' },
  { id: '5-left-master', name: 'Master Left + 2×2', paneCount: 5, description: 'Master left, 2×2 grid right' },
  { id: '5-cols', name: '5 Columns', paneCount: 5, description: 'Five equal vertical columns' },
];

export const SPLIT_PRESETS_6: SplitPreset[] = [
  { id: '6-grid', name: '3×2 Grid', paneCount: 6, description: 'Three columns, two rows' },
  { id: '6-grid-2x3', name: '2×3 Grid', paneCount: 6, description: 'Two columns, three rows' },
  { id: '6-left-master', name: 'Master Left + 5 Panes', paneCount: 6, description: 'Master left, 5 panes right' },
  { id: '6-cols', name: '6 Columns', paneCount: 6, description: 'Six equal vertical columns' },
];

export const SPLIT_PRESETS_MANY: SplitPreset[] = [
  { id: 'many-scroll', name: 'Scrolling Wall', paneCount: 12, description: 'Auto-fill cards with vertical scroll' },
  { id: 'many-dense-matrix', name: 'Dense Matrix', paneCount: 12, description: 'Fit all panes without scrolling' },
  { id: 'many-4cols', name: '4 Columns', paneCount: 12, description: 'Four column wrapping grid' },
  { id: 'many-3cols', name: '3 Columns', paneCount: 12, description: 'Three column wrapping grid' },
];

export const ALL_SPLIT_PRESET_IDS: Set<string> = new Set([
  'single',
  '2-cols',
  '2-rows',
  '2-left-master',
  '2-right-master',
  '3-top2-bottom1',
  '3-top1-bottom2',
  '3-left-master',
  '3-right-master',
  '3-cols',
  '4-grid',
  '4-left-master',
  '4-top1-bottom3',
  '4-cols',
  '5-top3-bottom2',
  '5-top2-bottom3',
  '5-left-master',
  '5-cols',
  '6-grid',
  '6-grid-2x3',
  '6-left-master',
  '6-cols',
  'many-scroll',
  'many-dense-matrix',
  'many-4cols',
  'many-3cols',
  'auto-grid',
]);

export function isSafePresetId(id: unknown): id is SplitPresetId {
  return typeof id === 'string' && ALL_SPLIT_PRESET_IDS.has(id);
}

export function getAvailablePresets(count: number): SplitPreset[] {
  if (count === 2) return SPLIT_PRESETS_2;
  if (count === 3) return SPLIT_PRESETS_3;
  if (count === 4) return SPLIT_PRESETS_4;
  if (count === 5) return SPLIT_PRESETS_5;
  if (count === 6) return SPLIT_PRESETS_6;
  if (count >= 7 && count <= 12) return SPLIT_PRESETS_MANY;
  return [];
}

export function getDefaultPreset(count: number): SplitPresetId {
  if (count <= 1) return 'single';
  if (count === 2) return '2-cols';
  if (count === 3) return '3-top2-bottom1';
  if (count === 4) return '4-grid';
  if (count === 5) return '5-top3-bottom2';
  if (count === 6) return '6-grid';
  if (count >= 7) return 'many-scroll';
  return 'auto-grid';
}

export function resolvePreset(presetId: string | undefined | null, count: number): SplitPresetId {
  const available = getAvailablePresets(count);
  if (presetId && available.some((p) => p.id === presetId)) {
    return presetId as SplitPresetId;
  }
  return getDefaultPreset(count);
}

export function getSplitStageStyle(
  presetId: SplitPresetId,
  count: number,
): { className: string; style?: React.CSSProperties } {
  if (count <= 1) {
    return { className: '' };
  }

  switch (presetId) {
    // 2 Panes
    case '2-cols':
      return {
        className: 'split-grid',
        style: {
          gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
          gridTemplateRows: '1fr',
        },
      };
    case '2-rows':
      return {
        className: 'split-grid',
        style: {
          gridTemplateColumns: '1fr',
          gridTemplateRows: 'repeat(2, minmax(0, 1fr))',
        },
      };
    case '2-left-master':
      return {
        className: 'split-grid',
        style: {
          gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 1fr)',
          gridTemplateRows: '1fr',
        },
      };
    case '2-right-master':
      return {
        className: 'split-grid',
        style: {
          gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.4fr)',
          gridTemplateRows: '1fr',
        },
      };

    // 3 Panes
    case '3-top2-bottom1':
      return {
        className: 'split-grid split-2row',
        style: {
          gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
          gridTemplateRows: 'minmax(180px, 1fr) minmax(180px, 1fr)',
        },
      };
    case '3-top1-bottom2':
      return {
        className: 'split-grid split-2row',
        style: {
          gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
          gridTemplateRows: 'minmax(180px, 1fr) minmax(180px, 1fr)',
        },
      };
    case '3-left-master':
      return {
        className: 'split-grid split-2row',
        style: {
          gridTemplateColumns: 'minmax(0, 1.25fr) minmax(0, 1fr)',
          gridTemplateRows: 'minmax(140px, 1fr) minmax(140px, 1fr)',
        },
      };
    case '3-right-master':
      return {
        className: 'split-grid split-2row',
        style: {
          gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.25fr)',
          gridTemplateRows: 'minmax(140px, 1fr) minmax(140px, 1fr)',
        },
      };
    case '3-cols':
      return {
        className: 'split-grid',
        style: {
          gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
          gridTemplateRows: '1fr',
        },
      };

    // 4 Panes
    case '4-grid':
      return {
        className: 'split-grid split-2row',
        style: {
          gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
          gridTemplateRows: 'minmax(180px, 1fr) minmax(180px, 1fr)',
        },
      };
    case '4-left-master':
      return {
        className: 'split-grid',
        style: {
          gridTemplateColumns: 'minmax(0, 1.3fr) minmax(0, 1fr)',
          gridTemplateRows: 'repeat(3, minmax(100px, 1fr))',
        },
      };
    case '4-top1-bottom3':
      return {
        className: 'split-grid',
        style: {
          gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
          gridTemplateRows: 'minmax(160px, 1.2fr) minmax(140px, 1fr)',
        },
      };
    case '4-cols':
      return {
        className: 'split-grid',
        style: {
          gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
          gridTemplateRows: '1fr',
        },
      };

    // 5 Panes
    case '5-top3-bottom2':
      return {
        className: 'split-grid split-2row',
        style: {
          gridTemplateColumns: 'repeat(6, minmax(0, 1fr))',
          gridTemplateRows: 'minmax(160px, 1fr) minmax(160px, 1fr)',
        },
      };
    case '5-top2-bottom3':
      return {
        className: 'split-grid split-2row',
        style: {
          gridTemplateColumns: 'repeat(6, minmax(0, 1fr))',
          gridTemplateRows: 'minmax(160px, 1fr) minmax(160px, 1fr)',
        },
      };
    case '5-left-master':
      return {
        className: 'split-grid split-2row',
        style: {
          gridTemplateColumns: 'minmax(0, 1.3fr) repeat(2, minmax(0, 1fr))',
          gridTemplateRows: 'minmax(140px, 1fr) minmax(140px, 1fr)',
        },
      };
    case '5-cols':
      return {
        className: 'split-grid',
        style: {
          gridTemplateColumns: 'repeat(5, minmax(0, 1fr))',
          gridTemplateRows: '1fr',
        },
      };

    // 6 Panes
    case '6-grid':
      return {
        className: 'split-grid split-2row',
        style: {
          gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
          gridTemplateRows: 'minmax(160px, 1fr) minmax(160px, 1fr)',
        },
      };
    case '6-grid-2x3':
      return {
        className: 'split-grid',
        style: {
          gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
          gridTemplateRows: 'repeat(3, minmax(130px, 1fr))',
        },
      };
    case '6-left-master':
      return {
        className: 'split-grid',
        style: {
          gridTemplateColumns: 'minmax(0, 1.35fr) repeat(2, minmax(0, 1fr))',
          gridTemplateRows: 'repeat(6, minmax(50px, 1fr))',
        },
      };
    case '6-cols':
      return {
        className: 'split-grid',
        style: {
          gridTemplateColumns: 'repeat(6, minmax(0, 1fr))',
          gridTemplateRows: '1fr',
        },
      };

    // 7-12 Panes (Fleet & Swarms)
    case 'many-scroll':
      return {
        className: 'split-grid split-scroll',
        style: {
          gridTemplateColumns: 'repeat(auto-fill, minmax(min(420px, 100%), 1fr))',
          gridAutoRows: 'minmax(240px, 1fr)',
          alignContent: 'start',
        },
      };
    case 'many-dense-matrix':
      return {
        className: 'split-grid',
        style: {
          gridTemplateColumns: count <= 9 ? 'repeat(3, minmax(0, 1fr))' : 'repeat(4, minmax(0, 1fr))',
          gridTemplateRows: 'repeat(3, minmax(110px, 1fr))',
        },
      };
    case 'many-4cols':
      return {
        className: 'split-grid',
        style: {
          gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
          gridAutoRows: 'minmax(150px, 1fr)',
        },
      };
    case 'many-3cols':
      return {
        className: 'split-grid',
        style: {
          gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
          gridAutoRows: 'minmax(170px, 1fr)',
        },
      };

    // Fallback
    case 'auto-grid':
    default:
      return {
        className: `split-grid${count > 6 ? ' split-scroll' : ''}`,
        style: {
          '--split-cols': splitColumnCount(count),
        } as React.CSSProperties,
      };
  }
}

export function getSplitPaneStyle(
  presetId: SplitPresetId,
  index: number,
  count: number,
): React.CSSProperties {
  const baseOrder: React.CSSProperties = { order: index };

  if (count <= 1) {
    return baseOrder;
  }

  switch (presetId) {
    // 2 Panes
    case '2-cols':
    case '2-rows':
    case '2-left-master':
    case '2-right-master':
      return baseOrder;

    // 3 Panes
    case '3-top2-bottom1':
      if (index === 0) return { ...baseOrder, gridColumn: '1', gridRow: '1' };
      if (index === 1) return { ...baseOrder, gridColumn: '2', gridRow: '1' };
      if (index === 2) return { ...baseOrder, gridColumn: '1 / -1', gridRow: '2' };
      return baseOrder;

    case '3-top1-bottom2':
      if (index === 0) return { ...baseOrder, gridColumn: '1 / -1', gridRow: '1' };
      if (index === 1) return { ...baseOrder, gridColumn: '1', gridRow: '2' };
      if (index === 2) return { ...baseOrder, gridColumn: '2', gridRow: '2' };
      return baseOrder;

    case '3-left-master':
      if (index === 0) return { ...baseOrder, gridColumn: '1', gridRow: '1 / span 2' };
      if (index === 1) return { ...baseOrder, gridColumn: '2', gridRow: '1' };
      if (index === 2) return { ...baseOrder, gridColumn: '2', gridRow: '2' };
      return baseOrder;

    case '3-right-master':
      if (index === 0) return { ...baseOrder, gridColumn: '1', gridRow: '1' };
      if (index === 1) return { ...baseOrder, gridColumn: '1', gridRow: '2' };
      if (index === 2) return { ...baseOrder, gridColumn: '2', gridRow: '1 / span 2' };
      return baseOrder;

    case '3-cols':
      return baseOrder;

    // 4 Panes
    case '4-grid':
      if (index === 0) return { ...baseOrder, gridColumn: '1', gridRow: '1' };
      if (index === 1) return { ...baseOrder, gridColumn: '2', gridRow: '1' };
      if (index === 2) return { ...baseOrder, gridColumn: '1', gridRow: '2' };
      if (index === 3) return { ...baseOrder, gridColumn: '2', gridRow: '2' };
      return baseOrder;

    case '4-left-master':
      if (index === 0) return { ...baseOrder, gridColumn: '1', gridRow: '1 / span 3' };
      if (index === 1) return { ...baseOrder, gridColumn: '2', gridRow: '1' };
      if (index === 2) return { ...baseOrder, gridColumn: '2', gridRow: '2' };
      if (index === 3) return { ...baseOrder, gridColumn: '2', gridRow: '3' };
      return baseOrder;

    case '4-top1-bottom3':
      if (index === 0) return { ...baseOrder, gridColumn: '1 / -1', gridRow: '1' };
      if (index === 1) return { ...baseOrder, gridColumn: '1', gridRow: '2' };
      if (index === 2) return { ...baseOrder, gridColumn: '2', gridRow: '2' };
      if (index === 3) return { ...baseOrder, gridColumn: '3', gridRow: '2' };
      return baseOrder;

    case '4-cols':
      return baseOrder;

    // 5 Panes
    case '5-top3-bottom2':
      if (index === 0) return { ...baseOrder, gridColumn: '1 / span 2', gridRow: '1' };
      if (index === 1) return { ...baseOrder, gridColumn: '3 / span 2', gridRow: '1' };
      if (index === 2) return { ...baseOrder, gridColumn: '5 / span 2', gridRow: '1' };
      if (index === 3) return { ...baseOrder, gridColumn: '1 / span 3', gridRow: '2' };
      if (index === 4) return { ...baseOrder, gridColumn: '4 / span 3', gridRow: '2' };
      return baseOrder;

    case '5-top2-bottom3':
      if (index === 0) return { ...baseOrder, gridColumn: '1 / span 3', gridRow: '1' };
      if (index === 1) return { ...baseOrder, gridColumn: '4 / span 3', gridRow: '1' };
      if (index === 2) return { ...baseOrder, gridColumn: '1 / span 2', gridRow: '2' };
      if (index === 3) return { ...baseOrder, gridColumn: '3 / span 2', gridRow: '2' };
      if (index === 4) return { ...baseOrder, gridColumn: '5 / span 2', gridRow: '2' };
      return baseOrder;

    case '5-left-master':
      if (index === 0) return { ...baseOrder, gridColumn: '1', gridRow: '1 / span 2' };
      if (index === 1) return { ...baseOrder, gridColumn: '2', gridRow: '1' };
      if (index === 2) return { ...baseOrder, gridColumn: '3', gridRow: '1' };
      if (index === 3) return { ...baseOrder, gridColumn: '2', gridRow: '2' };
      if (index === 4) return { ...baseOrder, gridColumn: '3', gridRow: '2' };
      return baseOrder;

    case '5-cols':
      return baseOrder;

    // 6 Panes
    case '6-grid':
    case '6-grid-2x3':
      return baseOrder;

    case '6-left-master':
      if (index === 0) return { ...baseOrder, gridColumn: '1', gridRow: '1 / span 6' };
      if (index === 1) return { ...baseOrder, gridColumn: '2', gridRow: '1 / span 2' };
      if (index === 2) return { ...baseOrder, gridColumn: '2', gridRow: '3 / span 2' };
      if (index === 3) return { ...baseOrder, gridColumn: '2', gridRow: '5 / span 2' };
      if (index === 4) return { ...baseOrder, gridColumn: '3', gridRow: '1 / span 3' };
      if (index === 5) return { ...baseOrder, gridColumn: '3', gridRow: '4 / span 3' };
      return baseOrder;

    case '6-cols':
      return baseOrder;

    // 7-12 Panes / Auto
    case 'many-scroll':
    case 'many-dense-matrix':
    case 'many-4cols':
    case 'many-3cols':
    case 'auto-grid':
    default:
      return baseOrder;
  }
}

/** Legacy helpers maintained for backward compatibility and testing. */

export function splitColumnCount(count: number): number {
  if (count <= 1) return 1;
  if (count <= 4) return 2;
  return 3;
}

export function splitUsesTwoRows(count: number): boolean {
  return count === 3 || count === 4;
}

export function splitPaneSpansRow(index: number, count: number): boolean {
  return count === 3 && index === 2;
}
