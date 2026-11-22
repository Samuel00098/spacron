import { describe, expect, it } from 'vitest';
import { unproject3dPoint } from './unproject3d';

describe('unproject3dPoint', () => {
  const stageRect = { left: 0, top: 0, width: 800, height: 600 };
  const screenRect = { left: 250, top: 100, width: 300, height: 600 };
  const dims = { width: 1080, height: 2400 };

  it('maps center point identically when flat (0 deg)', () => {
    // Stage center is (400, 300). Screen center is (250 + 150, 100 + 300) = (400, 400).
    const pt = unproject3dPoint({
      clientX: 400,
      clientY: 400,
      stageRect,
      screenRect,
      rotXDeg: 0,
      rotYDeg: 0,
      dims,
    });

    expect(pt).not.toBeNull();
    expect(pt?.x).toBe(540);
    expect(pt?.y).toBe(1200);
  });

  it('maps top-left and bottom-right corners when flat', () => {
    const topLeft = unproject3dPoint({
      clientX: 250,
      clientY: 100,
      stageRect,
      screenRect,
      rotXDeg: 0,
      rotYDeg: 0,
      dims,
    });
    expect(topLeft?.x).toBe(0);
    expect(topLeft?.y).toBe(0);

    const bottomRight = unproject3dPoint({
      clientX: 550,
      clientY: 700,
      stageRect,
      screenRect,
      rotXDeg: 0,
      rotYDeg: 0,
      dims,
    });
    expect(bottomRight?.x).toBe(1079);
    expect(bottomRight?.y).toBe(2399);
  });

  it('correctly maps center point even when tilted at 3D angles', () => {
    // When phone is centered at stage origin, center of phone is (400, 300)
    const centeredScreenRect = { left: 250, top: 0, width: 300, height: 600 };
    // Screen center = (400, 300) = stage center
    const pt = unproject3dPoint({
      clientX: 400,
      clientY: 300,
      stageRect,
      screenRect: centeredScreenRect,
      rotXDeg: 20,
      rotYDeg: -30,
      dims,
    });

    expect(pt).not.toBeNull();
    // Center point (0, 0, 0) rotated around origin is still (0, 0, 0)
    expect(pt?.x).toBe(540);
    expect(pt?.y).toBe(1200);
  });

  it('discards points outside the phone boundary', () => {
    const pt = unproject3dPoint({
      clientX: 50,
      clientY: 50,
      stageRect,
      screenRect,
      rotXDeg: 15,
      rotYDeg: 15,
      dims,
    });
    expect(pt).toBeNull();
  });
});
