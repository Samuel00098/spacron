/**
 * One-way conversion of the retired Sketch canvas document
 * (`soryq_sketch_state_v4_<projectId>` and the unscoped v3/v2 documents) into
 * Excalidraw elements.
 *
 * Deliberately pure: no React, no Excalidraw import, no DOM. The elements it
 * emits are PARTIAL — Excalidraw's own `restore` fills every field it does not
 * receive (version, versionNonce, index, boundElements, angle, ...) when the
 * scene is handed to `<Excalidraw initialData>`. Keeping the converter free of
 * the package is what lets the room shell stay small and the package stay in
 * its own lazy chunk.
 *
 * The legacy document is left untouched on disk; the caller writes the
 * converted scene under a new key, so a conversion can always be re-run.
 */

export interface LegacyPoint {
  x: number;
  y: number;
}

interface LegacyStroke {
  points: LegacyPoint[];
  color: string;
  width: number;
  opacity: number;
  isEraser: boolean;
}

interface LegacyText {
  id: string;
  layer?: number;
  x: number;
  y: number;
  value: string;
  color: string;
  fontSize: number;
  opacity: number;
  fontFamily?: string;
}

interface LegacyShape {
  id: string;
  layer?: number;
  type: string;
  imageUrl?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  fillColor: string;
  borderStyle: 'solid' | 'dashed' | 'dotted' | 'none';
  borderRadius: number;
  opacity: number;
  text: string;
  strokeWidth?: number;
  roughness?: number;
  fontFamily?: string;
  fillStyle?: 'transparent' | 'hachure' | 'cross-hatch' | 'solid';
}

interface LegacyArrow {
  id: string;
  fromTextId?: string;
  fromShapeId?: string;
  toTextId?: string;
  toShapeId?: string;
  fromPoint?: LegacyPoint;
  toPoint?: LegacyPoint;
  color: string;
  opacity: number;
  type?: 'arrow' | 'line';
  offsetX?: number;
  offsetY?: number;
}

export interface LegacySketchState {
  version?: string;
  backgroundStyle?: string;
  strokes?: LegacyStroke[];
  texts?: LegacyText[];
  arrows?: LegacyArrow[];
  shapes?: LegacyShape[];
  groups?: { id: string; elementIds: string[] }[];
}

/** A partial Excalidraw element; `restore` completes it on load. */
export type PartialExcalidrawElement = Record<string, unknown> & {
  type: string;
  x: number;
  y: number;
};
export type PartialExcalidrawFile = {
  id: string;
  mimeType: string;
  dataURL: string;
  created: number;
};

export interface ConvertedSketchScene {
  elements: PartialExcalidrawElement[];
  files: Record<string, PartialExcalidrawFile>;
  canvasBackground?: string;
  /** How much was converted, and how much had no Excalidraw equivalent. */
  counts: { strokes: number; texts: number; shapes: number; arrows: number; dropped: number };
}

/** The shape the room persists, and the only thing the canvas reports back. */
export interface PersistedSketchScene {
  version: 1;
  elements: PartialExcalidrawElement[];
  files: Record<string, PartialExcalidrawFile>;
  /** A canvas colour the user chose. Absent means "follow the app theme". */
  canvasBackground?: string;
  /** Epoch ms of the write, so the file and the cache can be ordered. */
  savedAt?: number;
  /** Set once, on the write that came from a legacy conversion. */
  migratedFrom?: 'v4' | 'v3' | 'v2';
}

/**
 * Legacy paint order, preserved: freehand first, then connectors, shapes, and
 * text on top. An explicit `layer` wins over the default for its type, which is
 * how the old panel let a shape sit above or below text.
 */
const DEFAULT_LAYER: Record<'stroke' | 'arrow' | 'shape' | 'text', number> = {
  stroke: 0,
  arrow: 0.5,
  shape: 0,
  text: 1,
};
const TYPE_RANK: Record<'stroke' | 'arrow' | 'shape' | 'text', number> = {
  stroke: 0,
  arrow: 1,
  shape: 2,
  text: 3,
};

/** Excalidraw's font family ids (see FONT_FAMILY in its constants). */
const FONT_FAMILY_IDS: Record<string, number> = {
  handwritten: 5, // Excalifont, the current hand-drawn default
  'sans-serif': 2, // Helvetica
  monospace: 3, // Cascadia
  serif: 2,
  playful: 7, // Comic Shanns
  marker: 1, // Virgil
  caveat: 1,
  comic: 7,
  manrope: 6, // Nunito
  typewriter: 3,
};

const SHAPE_TYPE_MAP: Record<string, 'rectangle' | 'ellipse' | 'diamond'> = {
  rectangle: 'rectangle',
  circle: 'ellipse',
  diamond: 'diamond',
  // Excalidraw has no polygon primitive. These keep their box, position and
  // style as a rectangle rather than disappearing.
  triangle: 'rectangle',
  hexagon: 'rectangle',
  pentagon: 'rectangle',
  octagon: 'rectangle',
  star: 'rectangle',
};

const BACKGROUND_TO_CANVAS_COLOR: Record<string, string | undefined> = {
  blackboard: '#182d27',
  blueprint: '#0f2c59',
  'solid-dark': '#000000',
  'solid-light': '#ffffff',
};

function hashSeed(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) || 1;
}

function uniqueId(raw: string, fallback: string, used: Set<string>): string {
  const base = raw?.trim() || fallback;
  let id = base;
  let suffix = 2;
  while (used.has(id)) {
    id = `${base}-${suffix}`;
    suffix += 1;
  }
  used.add(id);
  return id;
}

/** Legacy fills were `transparent`, `glass`, `tint`, a `#rrggbb` or one already carrying alpha. */
function backgroundColorFor(shape: LegacyShape): string {
  const fill = shape.fillColor ?? 'transparent';
  if (!fill || fill === 'transparent') return 'transparent';
  if (fill === 'glass') return `${shape.color}33`;
  if (fill === 'tint' || fill.endsWith('22')) return `${shape.color}22`;
  return fill;
}

function legacyTextBounds(text: LegacyText) {
  const lines = (text.value ?? '').split('\n');
  const longest = lines.reduce((max, line) => Math.max(max, line.length), 0);
  return {
    width: Math.max(12, longest * text.fontSize * 0.55 + 12),
    height: Math.max(text.fontSize * 1.25 + 6, lines.length * text.fontSize * 1.25 + 6),
  };
}

interface RankedElement {
  layer: number;
  rank: number;
  order: number;
  element: PartialExcalidrawElement;
}

export function convertLegacySketch(state: LegacySketchState | null | undefined): ConvertedSketchScene {
  const scene: ConvertedSketchScene = {
    elements: [],
    files: {},
    counts: { strokes: 0, texts: 0, shapes: 0, arrows: 0, dropped: 0 },
  };
  if (!state) return scene;

  const ranked: RankedElement[] = [];
  const usedIds = new Set<string>();
  const groupOf = new Map<string, string[]>();
  for (const group of state.groups ?? []) {
    for (const elementId of group.elementIds ?? []) {
      const groups = groupOf.get(elementId) ?? [];
      groups.push(group.id);
      groupOf.set(elementId, groups);
    }
  }
  const groupIdsFor = (legacyId: string) => groupOf.get(legacyId) ?? [];

  const push = (
    element: PartialExcalidrawElement,
    kind: 'stroke' | 'arrow' | 'shape' | 'text',
    legacyId: string,
    layer?: number,
    order = 0,
  ): PartialExcalidrawElement => {
    // Return the stored copy: it is what later passes (arrow bindings) mutate.
    const stored = { ...element, groupIds: groupIdsFor(legacyId) };
    ranked.push({
      layer: layer ?? DEFAULT_LAYER[kind],
      rank: TYPE_RANK[kind],
      order,
      element: stored,
    });
    return stored;
  };

  // --- Freehand -----------------------------------------------------------------
  (state.strokes ?? []).forEach((stroke, index) => {
    // Eraser strokes were a render-time effect; the strokes they cut are already
    // segmented in the document, so replaying the eraser would only add marks.
    if (stroke.isEraser) return;
    if (!stroke.points?.length) return;

    const xs = stroke.points.map((point) => point.x);
    const ys = stroke.points.map((point) => point.y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const maxX = Math.max(...xs);
    const maxY = Math.max(...ys);
    const points = stroke.points.map((point) => [point.x - minX, point.y - minY]);
    // A single-point stroke was drawn as a dot; give it a hair of travel so the
    // freedraw renderer draws something instead of an empty path.
    if (points.length === 1) points.push([0.01, 0.01]);

    push(
      {
        id: uniqueId(`stroke-${index}`, `stroke-${index}`, usedIds),
        type: 'freedraw',
        x: minX,
        y: minY,
        width: Math.max(1, maxX - minX),
        height: Math.max(1, maxY - minY),
        angle: 0,
        strokeColor: stroke.color,
        backgroundColor: 'transparent',
        fillStyle: 'solid',
        strokeWidth: stroke.width,
        strokeStyle: 'solid',
        roughness: 0,
        opacity: stroke.opacity ?? 1,
        points,
        pressures: [],
        simulatePressure: true,
        lastCommittedPoint: null,
        seed: hashSeed(`stroke-${index}`),
      },
      'stroke',
      `stroke-${index}`,
      0,
      index,
    );
    scene.counts.strokes += 1;
  });

  // --- Shapes -------------------------------------------------------------------
  const shapeBoxById = new Map<string, { x: number; y: number; width: number; height: number }>();
  const shapeElementsById = new Map<string, PartialExcalidrawElement>();

  (state.shapes ?? []).forEach((shape, index) => {
    const rawX = shape.x ?? 0;
    const rawY = shape.y ?? 0;
    const width = Math.abs(shape.width ?? 0);
    const height = Math.abs(shape.height ?? 0);
    if (width < 1 && height < 1 && shape.type !== 'image') {
      scene.counts.dropped += 1;
      return;
    }
    const x = (shape.width ?? 0) < 0 ? rawX + (shape.width ?? 0) : rawX;
    const y = (shape.height ?? 0) < 0 ? rawY + (shape.height ?? 0) : rawY;
    const id = uniqueId(shape.id, `shape-${index}`, usedIds);

    const base = {
      id,
      x,
      y,
      width: Math.max(1, width),
      height: Math.max(1, height),
      angle: 0,
      strokeColor: shape.borderStyle === 'none' ? 'transparent' : shape.color,
      backgroundColor: backgroundColorFor(shape),
      fillStyle: shape.fillStyle === 'transparent' ? 'solid' : (shape.fillStyle ?? 'solid'),
      strokeWidth: Math.max(1, shape.strokeWidth ?? 2),
      strokeStyle: shape.borderStyle === 'dashed' || shape.borderStyle === 'dotted' ? shape.borderStyle : 'solid',
      roughness: shape.roughness ?? 1.5,
      opacity: shape.opacity ?? 1,
      roundness: shape.borderRadius > 0 ? { type: 3 } : null,
      seed: hashSeed(id),
    };

    shapeBoxById.set(shape.id, base);

    if (shape.type === 'image') {
      if (!shape.imageUrl) {
        scene.counts.dropped += 1;
        return;
      }
      const fileId = `legacy-image-${id}`;
      const mimeType = /^data:([^;,]+)/.exec(shape.imageUrl)?.[1] ?? 'image/png';
      scene.files[fileId] = {
        id: fileId,
        mimeType,
        dataURL: shape.imageUrl,
        created: 0,
      };
      const element = push(
        {
          ...base,
          type: 'image',
          fileId,
          status: 'saved',
          scale: [1, 1],
          crop: null,
        },
        'shape',
        shape.id,
        shape.layer,
        index,
      );
      shapeElementsById.set(shape.id, element);
      scene.counts.shapes += 1;
      return;
    }

    const element = push(
      { ...base, type: SHAPE_TYPE_MAP[shape.type] ?? 'rectangle' },
      'shape',
      shape.id,
      shape.layer,
      index,
    );
    shapeElementsById.set(shape.id, element);
    scene.counts.shapes += 1;

    if (shape.text) {
      const textId = uniqueId(`${id}-label`, `${id}-label`, usedIds);
      const labelFontSize = Math.max(12, Math.min(28, height * 0.25));
      const labelSource: LegacyText = {
        id: textId,
        x: 0,
        y: 0,
        value: shape.text,
        color: shape.color,
        fontSize: labelFontSize,
        opacity: shape.opacity ?? 1,
        fontFamily: shape.fontFamily,
        layer: shape.layer,
      };
      const bounds = legacyTextBounds(labelSource);
      const elementLabel: PartialExcalidrawElement = {
        id: textId,
        type: 'text',
        x: x + (width - bounds.width) / 2,
        y: y + (height - bounds.height) / 2,
        width: bounds.width,
        height: bounds.height,
        angle: 0,
        text: shape.text,
        originalText: shape.text,
        fontSize: labelFontSize,
        fontFamily: FONT_FAMILY_IDS[shape.fontFamily ?? 'handwritten'] ?? 5,
        textAlign: 'center',
        verticalAlign: 'middle',
        containerId: null,
        lineHeight: 1.25,
        strokeColor: shape.color,
        backgroundColor: 'transparent',
        fillStyle: 'solid',
        strokeWidth: 1,
        strokeStyle: 'solid',
        roughness: 1,
        opacity: shape.opacity ?? 1,
        roundness: null,
        seed: hashSeed(textId),
        groupIds: groupIdsFor(shape.id),
      };
      // Label text inherits the shape's stacking so it stays with its box.
      ranked.push({
        layer: shape.layer ?? DEFAULT_LAYER.shape,
        rank: TYPE_RANK.text,
        order: index,
        element: elementLabel,
      });
    }
  });

  // --- Arrows and lines ---------------------------------------------------------
  const bound = new Map<string, { id: string; type: 'arrow' }[]>();
  const textById = new Map((state.texts ?? []).map((text) => [text.id, text]));

  const anchorFor = (arrow: LegacyArrow) => {
    const start = arrow.fromShapeId
      ? shapeBoxById.get(arrow.fromShapeId)
      : arrow.fromTextId
        ? (() => {
            const text = textById.get(arrow.fromTextId!);
            if (!text) return undefined;
            const bounds = legacyTextBounds(text);
            return { x: text.x, y: text.y, width: bounds.width, height: bounds.height };
          })()
        : undefined;
    const end = arrow.toShapeId
      ? shapeBoxById.get(arrow.toShapeId)
      : arrow.toTextId
        ? (() => {
            const text = textById.get(arrow.toTextId!);
            if (!text) return undefined;
            const bounds = legacyTextBounds(text);
            return { x: text.x, y: text.y, width: bounds.width, height: bounds.height };
          })()
        : undefined;
    const startPoint = start
      ? { x: start.x + start.width / 2, y: start.y + start.height / 2 }
      : arrow.fromPoint;
    const endPoint = end ? { x: end.x + end.width / 2, y: end.y + end.height / 2 } : arrow.toPoint;
    return { startPoint, endPoint };
  };

  (state.arrows ?? []).forEach((arrow, index) => {
    const { startPoint, endPoint } = anchorFor(arrow);
    if (!startPoint || !endPoint) {
      scene.counts.dropped += 1;
      return;
    }
    const id = uniqueId(arrow.id, `arrow-${index}`, usedIds);
    const dx = endPoint.x - startPoint.x;
    const dy = endPoint.y - startPoint.y;
    const isLine = arrow.type === 'line';

    const startElementId = arrow.fromShapeId ?? (arrow.fromTextId ? `text:${arrow.fromTextId}` : undefined);
    const endElementId = arrow.toShapeId ?? (arrow.toTextId ? `text:${arrow.toTextId}` : undefined);

    const element: PartialExcalidrawElement = {
      id,
      type: isLine ? 'line' : 'arrow',
      x: startPoint.x,
      y: startPoint.y,
      width: Math.abs(dx),
      height: Math.abs(dy),
      angle: 0,
      strokeColor: arrow.color,
      backgroundColor: 'transparent',
      fillStyle: 'solid',
      strokeWidth: 2,
      strokeStyle: 'solid',
      roughness: 1.3,
      opacity: arrow.opacity ?? 1,
      points: [
        [0, 0],
        [dx, dy],
      ],
      lastCommittedPoint: null,
      startBinding: startElementId && !startElementId.startsWith('text:')
        ? { elementId: startElementId, focus: 0, gap: 4 }
        : null,
      endBinding: endElementId && !endElementId.startsWith('text:')
        ? { elementId: endElementId, focus: 0, gap: 4 }
        : null,
      startArrowhead: null,
      endArrowhead: isLine ? null : 'arrow',
      roundness: null,
      seed: hashSeed(id),
    };

    for (const target of [element.startBinding, element.endBinding]) {
      const binding = target as { elementId: string } | null;
      if (!binding) continue;
      const list = bound.get(binding.elementId) ?? [];
      list.push({ id, type: 'arrow' });
      bound.set(binding.elementId, list);
    }

    push(element, 'arrow', arrow.id, undefined, index);
    scene.counts.arrows += 1;
  });

  // --- Standalone text ----------------------------------------------------------
  (state.texts ?? []).forEach((text, index) => {
    if (!text.value) return;
    const id = uniqueId(text.id, `text-${index}`, usedIds);
    const bounds = legacyTextBounds(text);
    push(
      {
        id,
        type: 'text',
        x: text.x,
        y: text.y,
        width: bounds.width,
        height: bounds.height,
        angle: 0,
        text: text.value,
        originalText: text.value,
        fontSize: text.fontSize,
        fontFamily: FONT_FAMILY_IDS[text.fontFamily ?? 'handwritten'] ?? 5,
        textAlign: 'left',
        verticalAlign: 'top',
        containerId: null,
        lineHeight: 1.25,
        strokeColor: text.color,
        backgroundColor: 'transparent',
        fillStyle: 'solid',
        strokeWidth: 1,
        strokeStyle: 'solid',
        roughness: 1,
        opacity: text.opacity ?? 1,
        roundness: null,
        seed: hashSeed(id),
      },
      'text',
      text.id,
      text.layer,
      index,
    );
    scene.counts.texts += 1;
  });

  // Attach the bindings the arrows declared. Excalidraw keeps them on both ends;
  // without this an arrow renders but cannot be re-attached by dragging.
  for (const [elementId, bindings] of bound) {
    const element = shapeElementsById.get(elementId);
    if (element) element.boundElements = bindings;
  }

  ranked.sort((a, b) => a.layer - b.layer || a.rank - b.rank || a.order - b.order);
  scene.elements = ranked.map((entry) => entry.element);
  // A legacy background preset was a deliberate choice, so it is carried over
  // as a custom canvas colour. There is no equivalent for dot/line/isometric
  // grids (Excalidraw draws those in the app theme), so those stay unset.
  const canvasColor = BACKGROUND_TO_CANVAS_COLOR[state.backgroundStyle ?? ''];
  if (canvasColor) scene.canvasBackground = canvasColor;
  return scene;
}
