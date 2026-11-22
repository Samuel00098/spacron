/** A WebGL renderer may force-lose its context on disposal. Its canvas must
 * not be reused by Strict Mode effect replay, a retry, or a profile change. */
export function createRendererSurface(host: HTMLElement, owner: Pick<Document, 'createElement'> = document) {
  const canvas = owner.createElement('canvas');
  host.replaceChildren(canvas);
  return canvas;
}
