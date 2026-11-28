import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/global.css';
import App from './App.tsx';
import ReactErrorBoundary from '$lib/react/ReactErrorBoundary';
import { isTauriRuntime, isWebkitGtk } from '$lib/utils/tauri';

// Mark WebKitGTK (Linux) before the first paint so the CSS that keeps the dock and
// floating bar reliably visible (`.is-webkitgtk` rules) applies from frame one.
if (isWebkitGtk()) {
  document.documentElement.classList.add('is-webkitgtk');
}

const container = document.getElementById('app');
if (!container) {
  throw new Error('App root container not found');
}

// Web links open in Preview instead of replacing the app's window.
if (isTauriRuntime()) {
  void import('$lib/services/external-links').then((m) => m.routeExternalLinks());
}

// Delete chats left untouched past the retention period (Settings > Chat).
void import('$lib/services/chat-retention').then((m) => m.startChatRetention());

createRoot(container).render(
  <StrictMode>
    <ReactErrorBoundary>
      <App />
    </ReactErrorBoundary>
  </StrictMode>,
);
