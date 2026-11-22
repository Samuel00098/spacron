import { expect, it, vi } from 'vitest';
import { createRendererSurface } from './rendererSurface';
const gpu = vi.hoisted(() => ({ lost: new WeakSet<object>() }));
vi.mock('three', async () => {
  const actual = await vi.importActual<typeof import('three')>('three');
  return { ...actual, WebGLRenderer: class {
    outputColorSpace = '';
    canvas: object;
    constructor({canvas}: {canvas: object}) { if(gpu.lost.has(canvas)) throw new Error('Context is lost'); this.canvas=canvas; }
    setDrawingBufferSize() {}
    render() { if(gpu.lost.has(this.canvas)) throw new Error('Context is lost'); }
    dispose() {}
    forceContextLoss() { gpu.lost.add(this.canvas); }
  }};
});
import { createPhoneViewer } from './t3/phoneViewer';
it('survives Strict Mode mount/dispose/remount without reusing a lost context', () => {
  const scheduled: FrameRequestCallback[]=[];
  vi.stubGlobal('requestAnimationFrame',(callback: FrameRequestCallback)=>{scheduled.push(callback);return scheduled.length;});
  vi.stubGlobal('cancelAnimationFrame',()=>{});
  const host={replaceChildren:vi.fn()} as unknown as HTMLElement;
  const owner={createElement:()=>Object.assign(new EventTarget(),{width:100,height:200})} as unknown as Document;
  const first=createRendererSurface(host,owner);
  const unavailable=vi.fn();
  const one=createPhoneViewer({canvas:first,source:first,onUnavailable:unavailable});
  one.dispose();
  expect(gpu.lost.has(first)).toBe(true);
  const second=createRendererSurface(host,owner);
  expect(second).not.toBe(first);
  const two=createPhoneViewer({canvas:second,source:second,onUnavailable:unavailable});
  two.resize(400,700,1);two.frameUpdated();
  for(const render of scheduled.splice(0)) render(0);
  expect(unavailable).not.toHaveBeenCalled();
  two.dispose();vi.unstubAllGlobals();
});
