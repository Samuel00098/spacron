import { describe, expect, it } from 'vitest';
import { streamingReplyPreview } from './reply-stream';

describe('streamingReplyPreview', () => {
  it('pulls the reply out of partial protocol JSON as it grows', () => {
    expect(streamingReplyPreview('{"re')).toBe('');
    expect(streamingReplyPreview('{"reply":"Hel')).toBe('Hel');
    expect(streamingReplyPreview('{"reply":"Hello\\nwor')).toBe('Hello\nwor');
    expect(streamingReplyPreview('{"reply":"Say \\"hi\\"","actions":[]}')).toBe('Say "hi"');
  });

  it('waits out an escape split across chunks', () => {
    expect(streamingReplyPreview('{"reply":"a\\')).toBe('a');
    expect(streamingReplyPreview('{"reply":"a\\u00')).toBe('a');
    expect(streamingReplyPreview('{"reply":"a\\u00e9b')).toBe('aéb');
  });

  it('hides tool rounds', () => {
    expect(streamingReplyPreview('{"tool_calls":[{"name":"read_file"')).toBeNull();
    expect(streamingReplyPreview('{"reply":"Reading","tool_calls":[')).toBeNull();
  });

  it('handles fences, inline reasoning and plain text', () => {
    expect(streamingReplyPreview('```json\n{"reply":"ok')).toBe('ok');
    expect(streamingReplyPreview('<think>planning')).toBe('');
    expect(streamingReplyPreview('<think>x</think>{"reply":"done')).toBe('done');
    expect(streamingReplyPreview('Just a plain answer')).toBe('Just a plain answer');
  });
});
