import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/stores/preview', () => ({ openUrlInPreviewPanel: vi.fn() }));

import { externalLinkUrl } from './external-links';

const anchor = (attrs: Record<string, string>) => ({
  getAttribute: (name: string) => attrs[name] ?? null,
  hasAttribute: (name: string) => name in attrs,
}) as unknown as Element;

describe('externalLinkUrl', () => {
  const app = 'http://tauri.localhost';

  it('takes web links that leave the app', () => {
    expect(externalLinkUrl(anchor({ href: 'https://libraries.excalidraw.com' }), app)).toBe('https://libraries.excalidraw.com/');
    expect(externalLinkUrl(anchor({ href: 'http://localhost:3000/a' }), app)).toBe('http://localhost:3000/a');
  });

  it('leaves everything else alone', () => {
    expect(externalLinkUrl(null, app)).toBeNull();
    expect(externalLinkUrl(anchor({}), app)).toBeNull();
    expect(externalLinkUrl(anchor({ href: '#section' }), app)).toBeNull();
    expect(externalLinkUrl(anchor({ href: 'mailto:a@b.c' }), app)).toBeNull();
    expect(externalLinkUrl(anchor({ href: `${app}/index.html` }), app)).toBeNull();
    expect(externalLinkUrl(anchor({ href: 'https://x.test/f.zip', download: '' }), app)).toBeNull();
  });
});
