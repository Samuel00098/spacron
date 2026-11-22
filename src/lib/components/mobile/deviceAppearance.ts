/** Match reported hardware metadata, never a persisted user-selected skin. */
export function deviceAppearance(platform: 'android' | 'ios', model: string, label = ''): string {
  const name = `${model} ${label}`.toLowerCase().replace(/[_-]/g, ' ');
  if (platform === 'ios') {
    if (/ipad/.test(name)) return 'ipad';
    if (/duo|fold/.test(name)) return 'duo';
    if (/iphone\s*18/.test(name)) return 'iphone18';
    return 'iphone17';
  }
  if (/\bfold(?:able)?\b|sm f9/.test(name)) return 'fold';
  if (/samsung|galaxy|sm s\d|sm g\d/.test(name)) return 'samsung';
  if (/xiaomi|redmi|poco/.test(name)) return 'xiaomi';
  if (/pixel/.test(name)) return 'pixel';
  return 'generic';
}

/** Brand identity is separate from form factor (for example Pixel Fold). */
export function deviceBrand(platform: 'android' | 'ios', model: string, label = ''): string {
  if (platform === 'ios') return 'apple';
  const name = `${model} ${label}`.toLowerCase().replace(/[_-]/g, ' ');
  if (/pixel|google/.test(name)) return 'google';
  if (/samsung|galaxy|sm [sfg]\d/.test(name)) return 'samsung';
  if (/xiaomi|redmi|poco/.test(name)) return 'xiaomi';
  return 'generic';
}
