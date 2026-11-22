import { useEffect, useRef, useState } from 'react';
import type { MobilePhone3DProps } from './MobilePhone3D';
import { createPhoneViewer, type PhoneViewer } from './t3/phoneViewer';
import { createDuoViewer, type DuoViewer } from './t3/duoViewer';
import { phoneWheelNavigation } from './t3/phoneInteraction';
import { resolveDeviceShape, type DeviceShapeProfile } from './t3/shapeProfile';
import { resolveDeviceModelId, type DeviceModelSource } from './t3/model';
import type { DeviceScreenSize } from './t3/stream';
import { createRendererSurface } from './rendererSurface';
import { meshScreenMappers } from './meshScreen';
import './T3DeviceView.css';

type Camera = DeviceShapeProfile['camera'];
type Family = Partial<Omit<DeviceShapeProfile, 'id' | 'camera'>> & { camera?: Camera };
const LENS = .056;

/**
 * Original Spacron chassis families. Each one evokes a brand's proportions and camera
 * arrangement with Spacron geometry only: no logos, wordmarks or manufacturer assets.
 */
function chassisFamily(profile: MobilePhone3DProps['profile']): Family {
  const tablet = profile?.kind === 'tablet', fold = profile?.kind === 'foldable';
  if (tablet) return profile?.brand === 'apple'
    ? { frameColor: 0xb8b1a5, frameRoughness: .34, backColor: 0x8a9692, backRoughness: .5 } // champagne rails, sea-glass back
    : { frameColor: 0x7f8a94, frameRoughness: .42, backColor: 0x3f4f5c, backRoughness: .55 }; // steel rails, harbour-blue back
  // Foldables get their own Spacron palette on top of the family's camera layout.
  const foldTone: Family = !fold ? {} : profile?.brand === 'samsung' ? { frameColor: 0x8a8378, backColor: 0x3d2f4a, backRoughness: .5 }
    : profile?.brand === 'google' ? { frameColor: 0xa9a196, backColor: 0x3f5650, backRoughness: .55 }
    : { frameColor: 0x9a8a7a, backColor: 0x4a3b33, backRoughness: .5 };
  return { ...phoneFamily(profile, fold), ...foldTone };
}

function phoneFamily(profile: MobilePhone3DProps['profile'], fold: boolean): Family {
  switch (profile?.rear) {
    case 'apple-pro': return { // flat titanium-tone rails, square plateau, three-lens triangle
      bodyRadius: .15, frameColor: 0x7d7a74, frameRoughness: .38, backColor: 0x2f3a3a, backRoughness: .62, cameraStyle: 'plateau',
      camera: { width: .42, height: .44, insetX: .26, insetY: .29, lensRadius: .07, lenses: [[-.085,.1],[-.085,-.1],[.095,0]], flash: [.1,.13] } };
    case 'apple-dual': return { // brushed aluminium, tall pill plateau, stacked pair
      bodyRadius: .15, frameColor: 0xd2cbc0, frameRoughness: .3, backColor: 0x6b5f74, backRoughness: .22, cameraStyle: 'plateau',
      camera: { width: .2, height: .42, insetX: .17, insetY: .28, lensRadius: .062, lenses: [[0,.1],[0,-.1]], flash: null } };
    case 'pixel-bar': return { // soft matte rails, full-width visor
      bodyRadius: .14, frameColor: 0x8fa39a, frameRoughness: .5, backColor: 0x4f6b62, backRoughness: .55, cameraStyle: 'visor',
      camera: { width: .78, height: .22, insetX: .49, insetY: .27, lensRadius: LENS, lenses: [[-.22,0],[0,0],[.2,0]], flash: [.33,.04] } };
    case 'pixel-a': return { // shorter visor that stays inside the rails
      bodyRadius: .14, frameColor: 0xb0a89a, frameRoughness: .55, backColor: 0x8a7f6e, backRoughness: .6, cameraStyle: 'plateau',
      camera: { width: .48, height: .19, insetX: .32, insetY: .23, lensRadius: LENS, lenses: [[-.1,0],[.06,0]], flash: [.18,0] } };
    case 'samsung': return { // squarer flat body, floating vertical lenses
      bodyRadius: fold ? undefined : /ultra/i.test(profile?.id ?? '') ? .055 : .1, frameColor: 0x5d6470, frameRoughness: .32, backColor: 0x2e3d55, backRoughness: .4, cameraStyle: fold ? 'plateau' : 'floating',
      camera: { width: .22, height: .56, insetX: .17, insetY: .34, lensRadius: LENS, lenses: [[0,.17],[0,0],[0,-.17]], flash: [.14,.05] } };
    case 'xiaomi': return { // large square deck with a four-lens grid
      bodyRadius: .13, frameColor: 0x9a8f86, frameRoughness: .4, backColor: 0x6b4a3e, backRoughness: .5, cameraStyle: 'plateau',
      camera: { width: .52, height: .52, insetX: .33, insetY: .33, lensRadius: .062, lenses: [[-.12,.12],[.12,.12],[-.12,-.12],[.12,-.12]], flash: [0,0] } };
    default: return { // neutral Spacron body for unrecognised hardware
      frameColor: 0x8c95a0, frameRoughness: .4, backColor: 0x33404d, backRoughness: .45, cameraStyle: 'plateau',
      camera: { width: .24, height: .42, insetX: .18, insetY: .28, lensRadius: LENS, lenses: [[0,.1],[0,-.1]], flash: [.09,0] } };
  }
}

export function shapeFor(props: MobilePhone3DProps, aspect: number): DeviceShapeProfile {
  const base = resolveDeviceShape({ platform: props.isIos ? 'ios' : 'android', name: props.deviceModel, portraitAspect: Math.min(aspect, 1 / aspect) });
  const family = chassisFamily(props.profile);
  const defined = Object.fromEntries(Object.entries(family).filter(([, value]) => value !== undefined));
  const shape = { ...base, brand: props.profile?.brand, ...defined };
  // Spacron: a hairline border with screen corners that follow the body, so the live
  // screen flows into the chassis instead of sitting inside a thick black frame.
  const bezel = props.profile?.kind === 'tablet' ? .03 : .016;
  return { ...shape, bezel, screenRadius: Math.max(.02, shape.bodyRadius - bezel - .004) };
}

export function T3DeviceView(props: MobilePhone3DProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const sourceRef = useRef<HTMLDivElement | null>(null);
  const latest = useRef(props); latest.current = props;
  const viewerRef = useRef<PhoneViewer | DuoViewer | null>(null);
  const [failed, setFailed] = useState(false);
  const [failureMessage, setFailureMessage] = useState('');
  const [ready, setReady] = useState(false);
  useEffect(() => { props.onRendererFallback?.(failed); }, [failed, props.onRendererFallback]);
  const lastReset = useRef(`${props.rotX}:${props.rotY}`);

  useEffect(() => {
    const host = hostRef.current, surface = surfaceRef.current;
    if (!host || !surface || failed) return;
    // T3 dispose() force-loses its WebGL context. Strict Mode replays effects
    // on the same React DOM nodes, so the output canvas must be mount-owned.
    const canvas = createRendererSurface(surface);
    canvas.className = 'mobile-t3-canvas mobile-device-screen';
    canvas.setAttribute('aria-label', props.ariaLabel ?? '3D device');
    let disposed = false, raf = 0, viewer: PhoneViewer | DuoViewer | null = null;
    let active: { id: number; mode: 'touch' | 'orbit'; x: number; y: number } | null = null;
    let hover: { x: number; y: number } | null = null;
    let settleTimer = 0;
    let orbitActive = false;
    let dimensions = '';
    let lastImage = '';
    let painted = false;
    const texture = document.createElement('canvas');
    texture.width = 900; texture.height = 1950;
    const context = texture.getContext('2d', { alpha: false });
    if (!context) { setFailureMessage('The browser could not create a canvas context.'); setFailed(true); return; }
    context.fillStyle = '#090c10'; context.fillRect(0,0,texture.width,texture.height);
    const id = resolveDeviceModelId(props.isIos ? 'ios' : 'android', props.deviceModel ?? '');
    const model: DeviceModelSource | null = id ? { id, url: `/device-models/t3/${id}.glb` } : null;
    const duo = id === 'iphone-duo';
    const sources = { 1: texture, 3: texture };
    const fail = (cause?: unknown) => { if (!disposed) {
      const message = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : 'The graphics context was lost or unavailable.';
      console.error('Device 3D renderer failed:', cause ?? message);
      setFailureMessage(message); meshScreenMappers.delete(host); setFailed(true);
    } };
    try {
      viewer = duo && model ? createDuoViewer({ canvas, sources, model, onUnavailable: fail, onModelError: fail })
        : createPhoneViewer({ canvas, source: texture, profile: shapeFor(props, 9/19.5), model, foldAngle: props.profile?.kind === 'foldable' ? props.foldAngle ?? props.hingeMotion?.angle ?? 180 : null, onUnavailable: fail, onModelError: (error) => console.warn('Device model unavailable; using procedural geometry', error) });
    } catch (cause) { fail(cause); return; }
    viewerRef.current = viewer;
    const point = (x: number, y: number, captured = false) => {
      const r = canvas.getBoundingClientRect();
      return viewer?.screenPoint((x-r.left)/r.width, (y-r.top)/r.height, captured) ?? null;
    };
    meshScreenMappers.set(host, (x,y) => point(x,y, active?.mode === 'touch'));
    const markOrbit = (dx: number, dy: number) => {
      if (!orbitActive) { viewer?.setInteractionActive(true, 'orbit'); orbitActive=true; }
      viewer?.orbit(dx,dy);
      latest.current.onRotate(1,1); // A custom-pose marker; raycasting uses the mesh itself.
      window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(() => { orbitActive=false; viewer?.setInteractionActive(false,'orbit'); }, 180);
    };
    const touch = (phase: 'down' | 'move' | 'up' | 'cancel', event: PointerEvent) => {
      const callback = phase === 'down' ? latest.current.onPointerDown : phase === 'move' ? latest.current.onPointerMove : phase === 'cancel' ? latest.current.onPointerCancel : latest.current.onPointerUp;
      callback?.(event as unknown as React.PointerEvent);
    };
    const down = (event: PointerEvent) => {
      if (active) return;
      if (event.button !== 0) { if (point(event.clientX,event.clientY)) touch('down',event); return; }
      const hit = !event.altKey && point(event.clientX,event.clientY);
      active = { id:event.pointerId, mode:hit ? 'touch':'orbit', x:event.clientX,y:event.clientY };
      host.setPointerCapture(event.pointerId); viewer?.setInteractionActive(true,active.mode);
      if (active.mode==='orbit') orbitActive=true;
      if (hit) touch('down',event);
      event.preventDefault();
    };
    const move = (event: PointerEvent) => {
      const r = host.getBoundingClientRect();
      if (active?.id === event.pointerId) {
        if (active.mode === 'touch') touch('move',event);
        else markOrbit((event.clientX-active.x)/r.width,(event.clientY-active.y)/r.height);
        active.x=event.clientX; active.y=event.clientY;
      } else if (!event.buttons && event.pointerType !== 'touch') {
        if (point(event.clientX,event.clientY)) { hover=null; viewer?.resetPose(); return; }
        if (hover) markOrbit((event.clientX-hover.x)/r.width,(event.clientY-hover.y)/r.height);
        hover={x:event.clientX,y:event.clientY};
      }
    };
    const up = (event: PointerEvent) => {
      if (active?.id !== event.pointerId) return;
      if (active.mode==='touch') touch(event.type==='pointercancel' ? 'cancel':'up',event);
      viewer?.setInteractionActive(false,active.mode); orbitActive=false; active=null;
      if (host.hasPointerCapture(event.pointerId)) host.releasePointerCapture(event.pointerId);
    };
    const wheel = (event: WheelEvent) => {
      if (point(event.clientX,event.clientY) || active?.mode==='touch') return;
      const r=host.getBoundingClientRect();
      const nav=phoneWheelNavigation({deltaX:event.deltaX,deltaY:event.deltaY,deltaMode:event.deltaMode,ctrlKey:event.ctrlKey,width:r.width,height:r.height});
      if (nav?.type==='orbit') { event.preventDefault(); event.stopPropagation(); markOrbit(nav.x,nav.y); }
    };
    const leave = () => { hover=null; if (!active) viewer?.setInteractionActive(false,'orbit'); };
    host.addEventListener('pointerdown',down); host.addEventListener('pointermove',move);
    host.addEventListener('pointerup',up); host.addEventListener('pointercancel',up); host.addEventListener('pointerleave',leave);
    host.addEventListener('wheel',wheel,{passive:false});
    const resize = () => { const r=host.getBoundingClientRect(); viewer?.resize(r.width,r.height,window.devicePixelRatio || 1); };
    const observer=new ResizeObserver(resize); observer.observe(host); resize();
    const paint = () => {
      if (disposed) return;
      const source=(latest.current.streamSourceRef?.current ?? sourceRef.current)?.querySelector('canvas, img') as HTMLCanvasElement | HTMLImageElement | null;
      const w=source instanceof HTMLImageElement ? source.naturalWidth : source?.width ?? 0;
      const h=source instanceof HTMLImageElement ? source.naturalHeight : source?.height ?? 0;
      if (!document.hidden && source && w>1 && h>1) {
        try {
          if (texture.width!==w || texture.height!==h) { texture.width=w;texture.height=h; }
          const angle=latest.current.foldAngle ?? latest.current.hingeMotion?.angle ?? (w/h>=.75 ? 180:0);
          const key=`${w}:${h}:${angle}`;
          const screen: DeviceScreenSize={width:w,height:h,orientation:duo ? 'portrait' : w>h ? 'landscape_right':'portrait',screenId:duo ? angle===0 ? 1:3:undefined,hingeAngle:angle};
          if (key!==dimensions) {
            if (duo) (viewer as DuoViewer).setScreen(screen);
            else { (viewer as PhoneViewer).setScreen(screen,shapeFor(latest.current,w/h)); (viewer as PhoneViewer).setFoldAngle(latest.current.profile?.kind==='foldable' ? angle:null); }
            dimensions=key;
          }
          if (!(source instanceof HTMLImageElement) || lastImage!==source.src) { context.drawImage(source,0,0,w,h); lastImage=source instanceof HTMLImageElement ? source.src:''; }
          if (duo) (viewer as DuoViewer).frameUpdated(angle===0 ? 1:3,texture); else (viewer as PhoneViewer).frameUpdated();
          if (!painted) { painted=true; setReady(true); }
        } catch { /* A source can be between frames during a display handoff. */ }
      }
      raf=requestAnimationFrame(paint);
    };
    paint();
    return () => {
      if (active?.mode==='touch') host.dispatchEvent(new PointerEvent('pointercancel', {pointerId:active.id,clientX:active.x,clientY:active.y,bubbles:false}));
      disposed=true; cancelAnimationFrame(raf);window.clearTimeout(settleTimer);observer.disconnect();
      host.removeEventListener('pointerdown',down);host.removeEventListener('pointermove',move);host.removeEventListener('pointerup',up);host.removeEventListener('pointercancel',up);host.removeEventListener('pointerleave',leave);host.removeEventListener('wheel',wheel);
      meshScreenMappers.delete(host); viewer?.dispose();viewerRef.current=null;
      canvas.remove();
    };
  }, [props.profile?.id,failed]);

  useEffect(() => {
    const token=`${props.rotX}:${props.rotY}`;
    if (token!==lastReset.current && props.rotX===0 && props.rotY===0) viewerRef.current?.resetPose();
    lastReset.current=token;
  }, [props.rotX,props.rotY]);
  if (failed) return <div className={`mobile-t3-fallback mobile-3d-screen-wrap${props.streamSourceRef ? ' external-source':''}`} ref={(node) => {
    if(props.stageRef) props.stageRef.current=node;
    if(props.screenContainerRef) props.screenContainerRef.current=node;
  }} onPointerDown={props.onPointerDown} onPointerMove={props.onPointerMove} onPointerUp={props.onPointerUp} onPointerCancel={props.onPointerCancel}>
    <div className="mobile-t3-error" role="alert" onPointerDown={(event) => event.stopPropagation()} onPointerUp={(event) => event.stopPropagation()}>
      <span>3D view could not start: {failureMessage}</span>
      <button type="button" onClick={() => { setReady(false); setFailed(false); }}>Retry 3D</button>
    </div>
    {!props.streamSourceRef && props.children}
  </div>;
  return <div className={`mobile-t3-view${failed ? ' failed':''}`} ref={(node) => { hostRef.current=node;if(props.stageRef) props.stageRef.current=node;if(props.screenContainerRef) props.screenContainerRef.current=node; }} onContextMenu={(event) => event.preventDefault()} onDoubleClick={() => { viewerRef.current?.resetPose(); props.onResetView(); }}>
    <div ref={surfaceRef} className="mobile-t3-surface" />
    <div ref={sourceRef} className="mobile-t3-source" aria-hidden={!failed}>{!props.streamSourceRef && props.children}</div>
    {!ready && !failed && <span className="mobile-t3-loading">Preparing device...</span>}
  </div>;
}
