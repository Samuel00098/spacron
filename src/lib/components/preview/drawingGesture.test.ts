import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

describe('drawing gesture completion', () => {
  it.each(['arrow', 'rectangle'])('retains the %s start point when React defers its update', (activeTool) => {
    const source = readFileSync('src/lib/components/preview/PreviewAnnotationOverlay.tsx', 'utf8');
    const start = source.indexOf('  const handlePointerUp =');
    const end = source.indexOf('  const commitText =', start);
    const script = ts.transpile(source.slice(start, end) + '\nglobalThis.finish = handlePointerUp;', { target: ts.ScriptTarget.ES2022 });
    let apply: ((items: unknown[]) => any[]) | undefined;
    const point = { x: 10, y: 20 };
    const ref = { current: point as typeof point | null };
    const context: any = {
      isDrawing: true, startPointRef: ref, activeTool,
      activeColor: '#ef4444', activeStrokeWidth: 4,
      getCanvasCoords: () => ({ x: 100, y: 120 }),
      setIsDrawing() {}, setItems: (update: typeof apply) => { apply = update; },
    };
    runInNewContext(script, context);
    context.finish({ pointerId: 1, currentTarget: { hasPointerCapture: () => false } });
    expect(ref.current).toBeNull();
    const result = apply!([]);
    expect(result[0].start).toEqual(point);
    expect(result[0].end).toEqual({ x: 100, y: 120 });
    expect(result[0].type).toBe(activeTool === 'rectangle' ? 'rect' : 'arrow');
  });
});
