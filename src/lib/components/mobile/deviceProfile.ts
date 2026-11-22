import { deviceAppearance, deviceBrand } from './deviceAppearance';

export interface DeviceProfile {
  id: string;
  brand: string;
  kind: 'phone' | 'tablet' | 'foldable';
  appearance: string;
  radius: number;
  bezel: number;
  camera: 'punch' | 'island' | 'tablet' | 'generic';
  rear: 'pixel-bar' | 'pixel-a' | 'samsung' | 'xiaomi' | 'apple-pro' | 'apple-dual' | 'tablet' | 'generic';
  /** Asset-backed renderer can replace the procedural fallback per model. */
  modelAsset: string | null;
}

export function resolveDeviceProfile(platform: 'android' | 'ios', model: string, name = ''): DeviceProfile {
  const identity = `${model} ${name}`.toLowerCase().replace(/[_-]/g, ' ');
  const brand = deviceBrand(platform, model, name);
  const appearance = deviceAppearance(platform, model, name);
  const tablet = /ipad|tablet|pixel c|nexus (7|9|10)/.test(identity);
  const foldable = /fold|duo|sm f9/.test(identity);
  const pro = /pro|ultra/.test(identity);
  const pixelA = /pixel\s*\d+a\b/.test(identity);
  const id = identity.trim().replace(/\s+/g, '-');
  return {
    id: id || `${platform}-generic`, brand,
    kind: tablet ? 'tablet' : foldable ? 'foldable' : 'phone', appearance,
    radius: tablet ? 22 : brand === 'samsung' && !foldable ? 14 : platform === 'ios' ? 44 : 34,
    bezel: tablet ? 12 : 10,
    camera: tablet ? 'tablet' : platform === 'ios' && !foldable ? 'island' : brand === 'generic' ? 'generic' : 'punch',
    rear: tablet ? 'tablet' : brand === 'google' ? pixelA ? 'pixel-a' : 'pixel-bar' : brand === 'samsung' ? 'samsung' : brand === 'xiaomi' ? 'xiaomi' : brand === 'apple' ? pro ? 'apple-pro' : 'apple-dual' : 'generic',
    // Detection supplies identity, not a licensed 3D asset. Unknown assets use geometry.
    modelAsset: null,
  };
}

export function fitDeviceFrame(aspect: number, width: number, height: number, bezel: number, maxHeight = Infinity) {
  if (![aspect, width, height, bezel].every(Number.isFinite) || aspect <= 0 || width <= 2 * bezel || height <= 2 * bezel) return { width: 0, height: 0 };
  const screenHeight = Math.max(0, Math.min(height - 2 * bezel, maxHeight - 2 * bezel, (width - 2 * bezel) / aspect));
  return { width: screenHeight * aspect + 2 * bezel, height: screenHeight + 2 * bezel };
}
