import { describe, expect, it, vi } from 'vitest';
import {
  buildSideChatContext,
  clearPaneContext,
  paneWireText,
  setPaneContext,
  sideChatContextFor,
  stripSideChatContext,
  withContext,
} from './side-chat-context';

describe('side chat context', () => {
  it('carries user and assistant messages only', () => {
    const block = buildSideChatContext([
      { kind: 'user', text: 'the codeword is PELICAN' },
      { kind: 'tool', text: 'ls output' },
      { kind: 'assistant', text: 'noted' },
      { kind: 'assistant', text: 'half written', pending: true },
    ])!;
    expect(block).toContain('User:\nthe codeword is PELICAN');
    expect(block).toContain('Assistant:\nnoted');
    expect(block).not.toContain('ls output');
    expect(block).not.toContain('half written');
    expect(buildSideChatContext([{ role: 'system', text: 'intro' }])).toBeNull();
  });

  it('applies in Chat mode only to threads holding copied parent turns', () => {
    const message = { role: 'user', text: 'earlier' };
    expect(sideChatContextFor([{ ...message, id: 'm1' }])).toBeNull();
    expect(sideChatContextFor([{ ...message, id: 'm1-sidecopy-abc' }])).toContain('earlier');
  });

  it('strips the block from an echoed prompt', () => {
    const block = buildSideChatContext([{ kind: 'user', text: 'earlier' }]);
    expect(stripSideChatContext(withContext(block, 'new question'))).toBe('new question');
    expect(stripSideChatContext('plain')).toBe('plain');
  });

  it('keeps the block for a pane until a prompt is delivered', () => {
    const onSent = vi.fn();
    setPaneContext(1, 'BLOCK', onSent);
    expect(paneWireText(1, '/compact').text).toBe('/compact');
    expect(paneWireText(1, 'first try').text).toBe('BLOCK\n\nfirst try');
    const retry = paneWireText(1, 'second try');
    expect(retry.text).toBe('BLOCK\n\nsecond try');
    retry.sent();
    expect(onSent).toHaveBeenCalledTimes(1);
    expect(paneWireText(1, 'third').text).toBe('third');

    setPaneContext(2, 'BLOCK', onSent);
    clearPaneContext(2);
    expect(paneWireText(2, 'hello').text).toBe('hello');
  });
});
