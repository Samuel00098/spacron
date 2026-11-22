import React, { useEffect, useRef, useState } from 'react';
import type { DeviceProfile } from './deviceProfile';
import { fitDeviceFrame } from './deviceProfile';
import { T3DeviceView } from './T3DeviceView';
import './MobilePhone3D.css';

export interface MobilePhone3DProps {
  children: React.ReactNode;
  deviceModel?: string;
  profile?: DeviceProfile;
  streamSourceRef?: React.RefObject<HTMLDivElement | null>;
  onRendererFallback?: (failed: boolean) => void;
  foldAngle?: number | null;
  hingeMotion?: { angle: number; revision: number } | null;
  aspectStyle?: React.CSSProperties;
  is3D: boolean;
  rotX: number;
  rotY: number;
  onRotate: (x: number, y: number) => void;
  onResetView: () => void;
  isDraggingDevice?: boolean;
  isIos?: boolean;
  onPointerDown?: React.PointerEventHandler;
  onPointerMove?: React.PointerEventHandler;
  onPointerUp?: React.PointerEventHandler;
  onPointerCancel?: React.PointerEventHandler;
  ariaLabel?: string;
  stageRef?: React.RefObject<HTMLDivElement | null>;
  screenContainerRef?: React.RefObject<HTMLDivElement | null>;
}

export function MobilePhone3D(props: MobilePhone3DProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [rendererFailed, setRendererFailed] = useState(false);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const ratioText = String(props.aspectStyle?.aspectRatio ?? '9 / 19.5');
  useEffect(() => {
    const stage = hostRef.current?.closest<HTMLElement>('.mobile-stage');
    if (!stage) return;
    const fit = () => {
      const [w,h=1] = ratioText.split('/').map(Number);
      const ratio = w>0 && h>0 ? w/h : 9/19.5;
      const style = getComputedStyle(stage);
      const width = stage.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 8;
      const height = stage.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom) - 8;
      const next = fitDeviceFrame(ratio,width,height,props.profile?.bezel ?? 10,props.profile?.kind==='tablet' || ratio>=.65 ? Infinity:740);
      setSize((previous) => previous?.width===next.width && previous.height===next.height ? previous:next);
    };
    fit(); const observer=new ResizeObserver(fit);observer.observe(stage);
    return () => observer.disconnect();
  }, [props.is3D,ratioText,props.profile?.kind,props.profile?.bezel]);
  const flat = !props.is3D || rendererFailed;
  const [rw,rh=1] = ratioText.split('/').map(Number);
  const radius = props.profile?.kind === 'foldable' && rw/rh >= .65 ? 20 : props.profile?.radius ?? (props.isIos ? 44 : 34);
  return <div className="mobile-device-presentation">
    <div ref={(node) => {
      hostRef.current=node;
      if(flat && props.screenContainerRef) props.screenContainerRef.current=node;
      if(flat && props.stageRef) props.stageRef.current=node;
    }}
      className={`mobile-flat-frame ${props.isIos ? 'mobile-ios-shell':'mobile-device-shell'}${props.isDraggingDevice ? ' dragging':''}${flat ? ' visible':' source-only'}`}
      style={{...props.aspectStyle,...size, '--flat-radius': `${radius}px`, '--flat-bezel': `${props.profile?.bezel ?? 10}px` } as React.CSSProperties}
      onPointerDown={flat ? props.onPointerDown : undefined} onPointerMove={flat ? props.onPointerMove : undefined}
      onPointerUp={flat ? props.onPointerUp : undefined} onPointerCancel={flat ? props.onPointerCancel : undefined}
      onContextMenu={(event) => event.preventDefault()} aria-label={props.ariaLabel ?? 'Device screen'} aria-hidden={!flat}>
      {props.children}
    </div>
    {props.is3D && <T3DeviceView {...props} streamSourceRef={hostRef} onRendererFallback={setRendererFailed} />}
  </div>;
}
