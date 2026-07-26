import { lazy, Suspense } from 'react';

// Lazy boundary for ProblemsPanel, matching the other panels: loaded on demand,
// renders nothing until ready so call sites stay unchanged.
const ProblemsPanel = lazy(() => import('./ProblemsPanel.tsx'));

export default function ProblemsPanelLazy() {
  return (
    <Suspense fallback={null}>
      <ProblemsPanel />
    </Suspense>
  );
}
