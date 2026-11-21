import { lazy, Suspense } from 'react';

// Lazy boundary for MobilePanel — the React lazy boundary for
// dynamic import. Loaded on demand; renders nothing until ready
// (matching the original `{#if Panel}` gate) so call sites stay unchanged.
const MobilePanel = lazy(() => import('./MobilePanel.tsx'));
const MobilePanelFloatingHost = lazy(() =>
  import('./MobilePanel.tsx').then((module) => ({ default: module.MobilePanelFloatingHost })),
);

export default function MobilePanelLazy() {
  return (
    <Suspense fallback={null}>
      <MobilePanel />
    </Suspense>
  );
}

export function MobilePanelFloatingHostLazy() {
  return (
    <Suspense fallback={null}>
      <MobilePanelFloatingHost />
    </Suspense>
  );
}
