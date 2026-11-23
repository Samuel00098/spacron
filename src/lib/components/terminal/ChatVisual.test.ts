import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { parseVisualDirective, splitReply, visualReplyText } from './ChatVisual';

describe('inline chat visuals', () => {
  it('reads a whole-line directive with file and optional title', () => {
    expect(parseVisualDirective('::spacron-visual{file="sales-7c1e.html" title="Sales by month"}')).toEqual({
      file: 'sales-7c1e.html',
      title: 'Sales by month',
    });
    expect(parseVisualDirective('   ::spacron-visual{file="a.html"}  ')).toEqual({ file: 'a.html', title: null });
    // Unknown keys from newer agents are ignored.
    expect(parseVisualDirective('::spacron-visual{file="a.html" height="300"}')?.file).toBe('a.html');
  });

  it('rejects paths, bad names and malformed attributes', () => {
    expect(parseVisualDirective('::spacron-visual{file="../x.html"}')).toBeNull();
    expect(parseVisualDirective('::spacron-visual{file="C:/x.html"}')).toBeNull();
    expect(parseVisualDirective('::spacron-visual{file="x.js"}')).toBeNull();
    expect(parseVisualDirective('::spacron-visual{title="no file"}')).toBeNull();
    expect(parseVisualDirective('::spacron-visual{file="a.html" file="b.html"}')).toBeNull();
    expect(parseVisualDirective('see ::spacron-visual{file="a.html"} here')).toBeNull();
    expect(parseVisualDirective('    ::spacron-visual{file="a.html"}')).toBeNull(); // 4 spaces = code
  });

  it('splits a reply into text and visuals, ignoring directives inside code fences', () => {
    const reply = [
      'Here is the breakdown:',
      '::spacron-visual{file="chart.html" title="Chart"}',
      'And the raw syntax:',
      '```',
      '::spacron-visual{file="example.html"}',
      '```',
    ].join('\n');
    const segments = splitReply(reply);
    expect(segments.map((s) => s.type)).toEqual(['text', 'visual', 'text']);
    expect(segments[1]).toEqual({ type: 'visual', visual: { file: 'chart.html', title: 'Chart' } });
    expect(segments[2].type === 'text' && segments[2].text).toContain('example.html');
  });

  it('caps visuals per reply at eight', () => {
    const reply = Array.from({ length: 10 }, (_, i) => `::spacron-visual{file="v${i}.html"}`).join('\n');
    expect(splitReply(reply).filter((s) => s.type === 'visual')).toHaveLength(8);
  });

  it('keeps Markdown text available for copy and playback without visual directives', () => {
    const reply = '## Summary\n::spacron-visual{file="chart.html"}\nTotal: 42';
    expect(visualReplyText(splitReply(reply))).toBe('## Summary\n\nTotal: 42');
    expect(visualReplyText(splitReply('::spacron-visual{file="chart.html"}'))).toBe('');
  });
});
