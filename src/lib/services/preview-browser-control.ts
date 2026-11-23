export type PreviewBrowserAction =
  | { action: 'snapshot' }
  | { action: 'click'; selector: string }
  | { action: 'fill'; selector: string; text: string };

type PreviewBrowserHandler = (action: PreviewBrowserAction, signal: AbortSignal) => Promise<string>;
let activeHandler: PreviewBrowserHandler | undefined;

export function registerPreviewBrowser(handler: PreviewBrowserHandler): () => void {
  activeHandler = handler;
  return () => {
    if (activeHandler === handler) activeHandler = undefined;
  };
}

export function controlPreviewBrowser(action: PreviewBrowserAction, signal: AbortSignal): Promise<string> {
  return activeHandler?.(action, signal) ?? Promise.reject(new Error('Open the in-app Preview first.'));
}
