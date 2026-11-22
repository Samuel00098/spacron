import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

describe('proxied Design Mode bridge', () => {
  it('activates only from the parent and resets the picker when disabled', () => {
    const source = readFileSync('src-tauri/src/preview/mod.rs', 'utf8');
    const script = source.match(/const INSPECTOR_SNIPPET: &str = r#"<script>([\s\S]*?)<\/script>"#;/)![1];
    const handlers: Record<string, (event: any) => void> = {};
    const root = { style: { cursor: '' }, appendChild: () => {} };
    const overlays: Array<{ style: { display?: string } }> = [];
    let selectionPublished = false;
    const parent = { postMessage: () => {
      selectionPublished = true;
      expect(overlays.map(({ style }) => style.display)).toEqual(['none', 'none']);
    } };
    class Element {
      tagName = 'H1';
      nodeType = 1;
      getBoundingClientRect() { return { x: 10, y: 20, left: 10, top: 20, width: 200, height: 40 }; }
    }
    const window = {
      parent,
      getComputedStyle: () => ({}),
      addEventListener: (type: string, handler: (event: any) => void) => { handlers[type] = handler; },
    };
    runInNewContext(script, {
      window, parent, Element, location: { hash: '' }, console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
      document: {
        documentElement: root,
        addEventListener: window.addEventListener,
        createElement: () => {
          const overlay = { style: {} };
          overlays.push(overlay);
          return overlay;
        },
      },
    });
    handlers.message({ source: {}, data: { type: 'forge-inspector:set', enabled: true } });
    expect(root.style.cursor).toBe('');
    handlers.message({ source: parent, data: { type: 'forge-inspector:set', enabled: true, parentOrigin: 'http://tauri.localhost' } });
    expect(root.style.cursor).toBe('crosshair');
    const target = new Element();
    handlers.mousemove({ target });
    expect(overlays[0].style.display).toBe('block');
    handlers.click({ target, preventDefault() {}, stopPropagation() {} });
    expect(selectionPublished).toBe(true);
    expect(root.style.cursor).toBe('');
    handlers.message({ source: parent, data: { type: 'forge-inspector:set', enabled: false } });
    expect(root.style.cursor).toBe('');
  });
});
