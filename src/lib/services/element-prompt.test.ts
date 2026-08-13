import { describe, it, expect } from 'vitest';
import { buildElementPrompt, type SelectedElementInfo } from './element-prompt';

const base: SelectedElementInfo = {
  selector: 'div.app > main > button.primary',
  tag: 'BUTTON',
  text: 'Save changes',
  html: '<button class="primary" type="submit">Save changes</button>',
  attributes: { class: 'primary', type: 'submit', 'aria-label': 'Save changes' },
  classes: ['primary'],
  styles: {
    width: '120px',
    color: 'rgb(255, 255, 255)',
    display: 'inline-flex',
    backgroundColor: 'rgb(20, 71, 230)',
  },
  page: { url: 'http://localhost:5173/settings', title: 'Settings' },
  rect: { x: 40, y: 120, width: 120.4, height: 36.2 },
};

describe('buildElementPrompt', () => {
  it('sends the payload the inspector actually collected', () => {
    const out = buildElementPrompt(base);
    expect(out).toContain('Selected `div.app > main > button.primary` on http://localhost:5173/settings');
    expect(out).toContain('Text: "Save changes"');
    expect(out).toContain('Box: 120×36 px');
    expect(out).toContain('```html');
    expect(out).toContain('<button class="primary" type="submit">Save changes</button>');
  });

  it('orders computed styles layout-first rather than by object key order', () => {
    const out = buildElementPrompt(base);
    const styles = out.slice(out.indexOf('Computed styles:'));
    expect(styles.indexOf('display:')).toBeLessThan(styles.indexOf('width:'));
    expect(styles.indexOf('width:')).toBeLessThan(styles.indexOf('color:'));
  });

  it('normalises camelCase style keys to CSS spelling', () => {
    expect(buildElementPrompt(base)).toContain('background-color: rgb(20, 71, 230)');
  });

  it('drops class and style attributes as noise, keeps the rest', () => {
    const out = buildElementPrompt(base);
    expect(out).toContain('type="submit"');
    expect(out).toContain('aria-label="Save changes"');
    expect(out).not.toContain('class="primary"\n');
  });

  it('never prints the redundant ancestor path', () => {
    const out = buildElementPrompt({
      ...base,
      ancestorPath: ['html', 'html > body', 'html > body > div.app'],
    });
    expect(out).not.toContain('Path:');
  });

  it('truncates oversized html instead of flooding the prompt bar', () => {
    const out = buildElementPrompt({ ...base, html: `<div>${'x'.repeat(5000)}</div>` });
    expect(out.length).toBeLessThan(3000);
    expect(out).toContain('…');
  });

  it('survives the minimal payload the inline fallback inspector can send', () => {
    const out = buildElementPrompt({
      selector: 'span',
      tag: 'SPAN',
      text: '',
      rect: { x: 0, y: 0, width: 0, height: 0 },
    });
    expect(out).toBe('Selected `span`\n');
  });

  it('falls back to the tag when no selector could be built', () => {
    const out = buildElementPrompt({ ...base, selector: '   ', page: undefined });
    expect(out.startsWith('Selected `button`')).toBe(true);
  });
});
