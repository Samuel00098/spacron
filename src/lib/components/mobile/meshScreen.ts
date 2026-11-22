type Mapper = (x: number, y: number) => { x: number; y: number } | null;
export const meshScreenMappers = new WeakMap<HTMLElement, Mapper>();
export function meshScreenPoint(host: HTMLElement | null, x: number, y: number) {
  if (!host) return undefined;
  const surface = meshScreenMappers.has(host) ? host : host.querySelector<HTMLElement>('.mobile-t3-view');
  return surface ? meshScreenMappers.get(surface)?.(x, y) : undefined;
}
