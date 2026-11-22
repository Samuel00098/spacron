import { describe, expect, it } from 'vitest';
import { deviceAppearance, deviceBrand } from './deviceAppearance';
describe('detected device appearance', () => {
  it('uses hardware metadata even with a custom AVD name', () => {
    expect(deviceAppearance('android', 'Pixel_10_Pro', 'Orca_phone')).toBe('pixel');
    expect(deviceAppearance('android', 'SM-S901B', 'Work phone')).toBe('samsung');
  });
  it('recognizes foldables and Xiaomi', () => {
    expect(deviceAppearance('android', 'SM-F966B')).toBe('fold');
    expect(deviceAppearance('android', 'sdk_gphone64', 'Pixel_Fold')).toBe('fold');
    expect(deviceAppearance('android', 'Xiaomi 17 Ultra')).toBe('xiaomi');
  });
  it('does not claim a generic emulator is a Pixel', () => {
    expect(deviceAppearance('android', 'sdk_gphone64_x86_64', 'Orca_phone')).toBe('generic');
  });
  it('matches the selected iOS simulator', () => {
    expect(deviceAppearance('ios', 'iPhone 18 Pro')).toBe('iphone18');
    expect(deviceAppearance('ios', 'iPhone Duo')).toBe('duo');
  });
});

it('keeps foldable brand identity separate from the chassis form factor', () => {
  expect(deviceBrand('android', 'sdk_gphone64', 'Pixel_Fold')).toBe('google');
  expect(deviceBrand('android', 'SM-F966B')).toBe('samsung');
  expect(deviceBrand('ios', 'iPhone Duo')).toBe('apple');
  expect(deviceBrand('android', 'sdk_gphone64', 'Work_phone')).toBe('generic');
});
