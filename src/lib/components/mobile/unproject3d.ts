/**
 * Ray-plane perspective unprojection for 3D-transformed phone screens.
 *
 * When the phone chassis is rotated in CSS 3D space (`transform: rotateX(...) rotateY(...)`),
 * clicks and pointer gestures arrive in 2D viewport coordinates. This helper traces a ray
 * from the virtual camera through the perspective stage and solves the exact 3D intersection
 * on the rotated phone screen, returning accurate native device pixels.
 */

export interface UnprojectOptions {
  clientX: number;
  clientY: number;
  /** Unprojected element dimensions and position when flat. */
  screenRect: { width: number; height: number; left: number; top: number };
  /** Stage bounding rect (used for the perspective origin at 50% 50%). */
  stageRect: { width: number; height: number; left: number; top: number };
  rotXDeg: number;
  rotYDeg: number;
  perspectivePx?: number;
  dims: { width: number; height: number };
}

export function unproject3dPoint(opts: UnprojectOptions): { x: number; y: number } | null {
  const { clientX, clientY, screenRect, stageRect, rotXDeg, rotYDeg, perspectivePx = 1200, dims } = opts;

  // Fast path: when perfectly flat (within 0.05 deg), standard 2D projection
  if (Math.abs(rotXDeg) < 0.05 && Math.abs(rotYDeg) < 0.05) {
    if (screenRect.width <= 0 || screenRect.height <= 0) return null;
    const u = (clientX - screenRect.left) / screenRect.width;
    const v = (clientY - screenRect.top) / screenRect.height;
    return {
      x: Math.max(0, Math.min(dims.width - 1, Math.round(u * dims.width))),
      y: Math.max(0, Math.min(dims.height - 1, Math.round(v * dims.height))),
    };
  }

  // The perspective origin is at the center of the stage container
  const stageCenterX = stageRect.left + stageRect.width / 2;
  const stageCenterY = stageRect.top + stageRect.height / 2;

  // Relative to stage center
  const px = clientX - stageCenterX;
  const py = clientY - stageCenterY;
  const d = perspectivePx;

  // Rotation angles in radians
  const radX = (rotXDeg * Math.PI) / 180;
  const radY = (rotYDeg * Math.PI) / 180;

  // Normal vector of the rotated phone screen plane:
  // Rotation matrix R = R_y(rotY) * R_x(rotX)
  // n = R * [0, 0, 1]^T = [sin(y)*cos(x), -sin(x), cos(y)*cos(x)]
  const nx = Math.sin(radY) * Math.cos(radX);
  const ny = -Math.sin(radX);
  const nz = Math.cos(radY) * Math.cos(radX);

  // When facing sideways or away from the camera (viewing the back of the phone),
  // clicks should not reach the hidden front screen.
  if (nz <= 0.05) return null;

  // Ray from camera E=(0, 0, d) with direction D=(px, py, -d)
  // Line: P(t) = E + t*D
  // Plane equation: dot(P - PlaneCenter, n) = 0
  // In the stage, the phone is centered at (0, 0, 0) relative to stage center
  const denom = px * nx + py * ny - d * nz;
  if (Math.abs(denom) < 1e-7) return null; // Parallel ray

  const t = (-d * nz) / denom;
  if (t <= 0) return null; // Intersection behind camera

  // 3D coordinates of intersection point relative to stage center:
  const Px = t * px;
  const Py = t * py;
  const Pz = d - t * d;

  // Project P onto the phone screen's local 2D axes:
  // Local X axis (uAxis): R * [1, 0, 0]^T = [cos(y), 0, -sin(y)]
  // Local Y axis (vAxis): R * [0, 1, 0]^T = [sin(y)*sin(x), cos(x), cos(y)*sin(x)]
  const uX = Math.cos(radY);
  const uZ = -Math.sin(radY);

  const vX = Math.sin(radY) * Math.sin(radX);
  const vY = Math.cos(radX);
  const vZ = Math.cos(radY) * Math.sin(radX);

  const xLocal = Px * uX + Pz * uZ;
  const yLocal = Px * vX + Py * vY + Pz * vZ;

  const halfW = screenRect.width / 2;
  const halfH = screenRect.height / 2;

  const normU = (xLocal + halfW) / screenRect.width;
  const normV = (yLocal + halfH) / screenRect.height;

  // Discard clicks that land too far outside the screen quad
  if (normU < -0.05 || normU > 1.05 || normV < -0.05 || normV > 1.05) {
    return null;
  }

  const clampedU = Math.max(0, Math.min(1, normU));
  const clampedV = Math.max(0, Math.min(1, normV));

  return {
    x: Math.max(0, Math.min(dims.width - 1, Math.round(clampedU * dims.width))),
    y: Math.max(0, Math.min(dims.height - 1, Math.round(clampedV * dims.height))),
  };
}
