import { describe, expect, it } from 'vitest';
import { eraseStrokeAtPoint } from './SketchPanel';

const stroke = {
  points: [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 20, y: 0 },
    { x: 30, y: 0 },
    { x: 40, y: 0 },
  ],
  color: '#fff',
  width: 4,
  opacity: 1,
  isEraser: false,
};

describe('sketch eraser', () => {
  it('cuts a touched freehand stroke into durable vector fragments', () => {
    const fragments = eraseStrokeAtPoint(stroke, { x: 20, y: 0 }, 3);

    expect(fragments).toHaveLength(2);
    expect(fragments[0].points).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }]);
    expect(fragments[1].points).toEqual([{ x: 30, y: 0 }, { x: 40, y: 0 }]);
    expect(fragments.every((fragment) => fragment.isEraser === false)).toBe(true);
  });

  it('leaves an untouched stroke unchanged', () => {
    expect(eraseStrokeAtPoint(stroke, { x: 20, y: 20 }, 3)).toEqual([stroke]);
  });

  it('removes a sparse segment when the eraser crosses between its points', () => {
    const sparse = { ...stroke, points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] };
    expect(eraseStrokeAtPoint(sparse, { x: 50, y: 0 }, 5)).toEqual([]);
  });
});
