import { describe, expect, it } from 'vitest';
import { fitDeviceFrame, resolveDeviceProfile } from './deviceProfile';
describe('device profiles', () => {
  it('separates Google folding hardware from Samsung', () => {
    const pixel = resolveDeviceProfile('android', 'sdk_gphone64', 'Pixel Fold');
    expect(pixel.kind).toBe('foldable'); expect(pixel.brand).toBe('google'); expect(pixel.rear).toBe('pixel-bar');
    expect(resolveDeviceProfile('android', 'SM-F966B').brand).toBe('samsung');
  });
  it('distinguishes the A-series camera and tablets', () => {
    expect(resolveDeviceProfile('android', 'Pixel_10a').rear).toBe('pixel-a');
    expect(resolveDeviceProfile('ios', '', 'iPad Pro').kind).toBe('tablet');
    expect(resolveDeviceProfile('ios', '', 'iPhone Duo').kind).toBe('foldable');
  });
  it('does not claim an exact model asset for unknown hardware', () => {
    expect(resolveDeviceProfile('android', 'sdk_gphone64', 'Custom').modelAsset).toBeNull();
    expect(resolveDeviceProfile('android', 'sdk_gphone64', 'Custom').rear).toBe('generic');
  });
});
describe('device frame fitting', () => {
  it('fits an open fold into a narrow sidebar without stretching its screen', () => {
    const frame = fitDeviceFrame(1, 320, 700, 10);
    expect(frame).toEqual({ width: 320, height: 320 });
  });
  it('lets tablets grow within both bounds', () => {
    const frame = fitDeviceFrame(.75, 1000, 900, 12);
    expect(frame.height).toBe(900); expect(frame.width).toBeLessThanOrEqual(1000);
    expect((frame.width - 24) / (frame.height - 24)).toBeCloseTo(.75);
  });
  it('caps a phone while retaining bezel-correct aspect ratio', () => {
    const frame = fitDeviceFrame(.45, 500, 1000, 10, 740);
    expect(frame.height).toBe(740); expect((frame.width - 20) / (frame.height - 20)).toBeCloseTo(.45);
  });
  it('handles hidden panels and invalid aspect', () => {
    expect(fitDeviceFrame(1, 0, 0, 10)).toEqual({ width: 0, height: 0 });
    expect(fitDeviceFrame(NaN, 500, 500, 10)).toEqual({ width: 0, height: 0 });
  });
});
