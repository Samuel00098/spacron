# 3D mobile emulator viewer and ray unprojection

The Mobile Panel (`src/lib/components/mobile/MobilePanel.tsx`) features a toggleable **3D perspective phone view** (`MobilePhone3D.tsx`) that renders live Android and iOS emulator streams inside realistic 3D chassis models.

## Key invariants & mechanics

1. **Hardware-accelerated CSS 3D & 360° rotation**:
   - Uses `perspective: 1200px` with `transform-style: preserve-3d`.
   - The live `<canvas>` (scrcpy/mjpeg) and `<img>` (snapshot) elements render directly inside the 3D rig without copying pixel buffers to WebGL textures, preserving high frame rates with zero texture upload lag.
   - Full 360° continuous yaw rotation: spinning the phone reveals the real physical side rails and back.
   - Both `.mobile-3d-front` and `.mobile-3d-back` have `backface-visibility: hidden;` so turning past 90° cleanly reveals the back.

2. **Dedicated authentic designs (iOS vs Android)**:
   - **iOS (iPhone Pro)**: 44px corner radius, Dynamic Island on front, titanium rails with Action Button, Volume buttons, Side button, and Camera Control; back features the polished chrome Apple logo and elevated squircle triple-camera plateau with milled lens rings, TrueTone flash, and LiDAR scanner.
   - **Android (Google Pixel)**: 34px corner radius, centered punch-hole camera on front, aluminum rails with textured power button; back features the iconic edge-to-edge horizontal Camera Visor bar with pill glass cutout, multiple sensors, and embossed Google "G" emblem.
   - **Solid 3D Side Rails**: 4 physical 3D side faces (left, right, top, bottom at 90°) with USB-C port, speaker/mic grilles, antenna bands, and protruding buttons.

3. **Interaction separation**:
   - **On the screen**: clicks, drags, swipes, and wheel scrolls strictly control the device emulator; the phone model does not move.
   - **Outside the screen** (stage or chassis): mouse/trackpad drag or two-finger trackpad panning freely rotates the 3D phone model. Double-clicking the stage or clicking "Restore 3D view" in the header toolbar resets to front-facing (0°, 0°).
   - Theme-aware menus and floating popup: `.mobile-device-menu` and `.mobile-panel-floating` use `var(--app-surface)` / `var(--surface-menu)` and `var(--text-primary)` to adapt seamlessly to light and dark themes without hardcoded `#101010` fills.

4. **Floating popup 2D mode, 8-angle resizing & independent host lifecycle**:
   - When the user selects "Float device over chat" or when the right sidebar is closed while the device is active, the device automatically floats over chat via `MobilePanelFloatingHost` at the root of `AppShell`.
   - Floating host independence: because `MobilePanelFloatingHost` lives at the root of `AppShell`, closing the right sidebar does NOT unmount or close the floating device.
   - Smooth 8-angle resize handles (`n`, `s`, `e`, `w`, `nw`, `ne`, `sw`, `se`) allow resizing the floating window freely from any angle or edge with pointer capture.
   - Returning from popup to sidebar: clicking "Go back to sidebar" closes the floating window, calls `openMobileSidebar()`, and explicitly restores the device to its **"perfect state" in 3D** (`rotX = 0, rotY = 0`, upright, facing forward, not tilted or bent at an angle).
   - Module-level frame and dimension caching (`cachedAndroidFrame`, `cachedIosShot`, `cachedIosShotDims`, `lastKnownStreamDims`) ensures 0ms paint delay and zero black screen when moving between floating and sidebar views.
   - Sizing consistency: `.mobile-3d-rig` has `width: 100%; height: 100%` and `.mobile-3d-chassis` has `max-width: 100%; max-height: 100%`, guaranteeing that the phone is identical in size to 2D flat mode (does not shrink or reduce).

5. **Touch/tap accuracy over 3D transforms (`unproject3d.ts`)**:
   - `unproject3dPoint` traces an analytical ray from the virtual camera through the perspective stage and computes the exact ray-plane intersection on the rotated phone screen.
   - When facing sideways or backward ($nz \le 0.05$), clicks return `null` so taps never leak onto the hidden front screen.
