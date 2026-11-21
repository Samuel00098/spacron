import { describe, expect, it } from 'vitest';
import { convertLegacySketch, type LegacySketchState } from './legacySketchToScene';

/**
 * The migration is the one irreversible step of the Excalidraw swap: it decides
 * what survives from a v4 sketch. These cases pin the mappings that are easy to
 * lose silently (bound arrows, group membership, stacking order) and the ones
 * that are deliberately approximate (polygons become rectangles).
 */

const legacy: LegacySketchState = {
  version: '4',
  backgroundStyle: 'blueprint',
  strokes: [
    {
      points: [
        { x: 10, y: 10 },
        { x: 60, y: 30 },
      ],
      color: '#f43f5e',
      width: 4,
      opacity: 1,
      isEraser: false,
    },
    // An eraser stroke is a render-time effect; it must not become ink.
    {
      points: [
        { x: 0, y: 0 },
        { x: 5, y: 5 },
      ],
      color: '#fff',
      width: 10,
      opacity: 1,
      isEraser: true,
    },
  ],
  shapes: [
    {
      id: 'shape-a',
      type: 'rectangle',
      x: 100,
      y: 100,
      width: 200,
      height: 100,
      color: '#10b981',
      fillColor: '#10b981',
      borderStyle: 'solid',
      borderRadius: 8,
      opacity: 1,
      text: 'API',
      fillStyle: 'hachure',
      strokeWidth: 2,
      roughness: 1.5,
    },
    {
      id: 'shape-b',
      type: 'hexagon',
      x: 400,
      y: 100,
      width: 120,
      height: 80,
      color: '#06b6d4',
      fillColor: 'transparent',
      borderStyle: 'dashed',
      borderRadius: 0,
      opacity: 0.8,
      text: '',
      fillStyle: 'transparent',
    },
    {
      id: 'shape-img',
      type: 'image',
      imageUrl: 'data:image/png;base64,iVBORw0KGgo=',
      x: 0,
      y: 300,
      width: 40,
      height: 40,
      color: '#fff',
      fillColor: 'transparent',
      borderStyle: 'none',
      borderRadius: 0,
      opacity: 1,
      text: '',
    },
  ],
  texts: [
    {
      id: 'text-1',
      layer: 3,
      x: 100,
      y: 240,
      value: 'Request flow',
      color: '#e2e2eb',
      fontSize: 18,
      opacity: 1,
      fontFamily: 'caveat',
    },
  ],
  arrows: [
    {
      id: 'arrow-1',
      fromShapeId: 'shape-a',
      toShapeId: 'shape-b',
      color: '#f59e0b',
      opacity: 1,
      type: 'arrow',
    },
    {
      id: 'arrow-free',
      fromPoint: { x: 0, y: 0 },
      toPoint: { x: 30, y: 40 },
      color: '#fff',
      opacity: 1,
      type: 'line',
    },
  ],
  groups: [{ id: 'group-1', elementIds: ['shape-a', 'text-1'] }],
};

describe('legacy sketch conversion', () => {
  const scene = convertLegacySketch(legacy);

  it('converts every drawable element and drops only the eraser stroke', () => {
    expect(scene.counts).toEqual({ strokes: 1, texts: 1, shapes: 3, arrows: 2, dropped: 0 });
    // 1 stroke + 3 shapes + 1 shape label + 1 standalone text + 2 connectors
    expect(scene.elements).toHaveLength(8);
  });

  it('keeps the legacy paint order: ink, connectors, shapes, text', () => {
    const types = scene.elements.map((element) => element.type);
    expect(types[0]).toBe('freedraw');
    expect(types.filter((type) => type === 'text')).toHaveLength(2); // standalone + shape label
    expect(scene.elements[scene.elements.length - 1].type).toBe('text');
  });

  it('maps shapes onto the nearest Excalidraw primitive', () => {
    const hexagon = scene.elements.find((element) => element.id === 'shape-b');
    expect(hexagon?.type).toBe('rectangle');
    expect(hexagon?.strokeStyle).toBe('dashed');
    expect(hexagon?.opacity).toBe(0.8);
  });

  it('carries images across as Excalidraw files', () => {
    const image = scene.elements.find((element) => element.type === 'image');
    expect(image?.fileId).toBe('legacy-image-shape-img');
    const file = scene.files[String(image?.fileId)];
    expect(file?.mimeType).toBe('image/png');
    expect(file?.dataURL.startsWith('data:image/png')).toBe(true);
  });

  it('binds arrows to their shapes so they stay attached', () => {
    const arrow = scene.elements.find((element) => element.id === 'arrow-1');
    expect(arrow?.type).toBe('arrow');
    expect(arrow?.startBinding).toEqual({ elementId: 'shape-a', focus: 0, gap: 4 });
    expect(arrow?.endBinding).toEqual({ elementId: 'shape-b', focus: 0, gap: 4 });

    const shape = scene.elements.find((element) => element.id === 'shape-a');
    expect(shape?.boundElements).toEqual([{ id: 'arrow-1', type: 'arrow' }]);
  });

  it('keeps free connectors as lines with their colour and direction', () => {
    const line = scene.elements.find((element) => element.id === 'arrow-free');
    expect(line?.type).toBe('line');
    expect(line?.points).toEqual([
      [0, 0],
      [30, 40],
    ]);
    expect(line?.endArrowhead).toBeNull();
    expect(line?.seed).toBeTypeOf('number');
  });

  it('keeps group membership and the saved canvas colour', () => {
    const shape = scene.elements.find((element) => element.id === 'shape-a');
    expect(shape?.groupIds).toEqual(['group-1']);
    expect(scene.canvasBackground).toBe('#0f2c59');
  });

  it('is empty, not broken, for a missing or empty document', () => {
    expect(convertLegacySketch(null).elements).toEqual([]);
    expect(convertLegacySketch({}).elements).toEqual([]);
  });
});
