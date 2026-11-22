// Minimal presentation metadata adapter; transport remains owned by Spacron.
import type { DuoPose } from './duoControl';
export interface DeviceScreenSize {
 readonly width: number; readonly height: number;
 readonly orientation: 'portrait' | 'portrait_upside_down' | 'landscape_left' | 'landscape_right';
 readonly screenId?: number; readonly supportsHingeAngle?: boolean; readonly supportsPhysicalOrientation?: boolean;
 readonly hingeAngle?: number; readonly hingePose?: DuoPose | null;
 readonly tableMode?: boolean; readonly tableModeAvailable?: boolean;
}
