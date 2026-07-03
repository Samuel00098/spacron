import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/global.css';
import App from './App.tsx';
import ReactErrorBoundary from '$lib/react/ReactErrorBoundary';
import { isWebkitGtk } from '$lib/utils/tauri';

// Mark WebKitGTK (Linux) before the first paint so the CSS that keeps the dock and
// floating bar reliably visible (`.is-webkitgtk` rules) applies from frame one.
if (isWebkitGtk()) {
  document.documentElement.classList.add('is-webkitgtk');
}

const container = document.getElementById('app');
if (!container) {
  throw new Error('App root container not found');
}

createRoot(container).render(
  <StrictMode>
    <ReactErrorBoundary>
      <App />
    </ReactErrorBoundary>
  </StrictMode>,
);
