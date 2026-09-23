/**
 * The readable part of a model reply that is still streaming in.
 *
 * Brain replies are protocol JSON (`{"reply":"…","actions":[]}`), so the raw
 * stream is not something to show a person. This pulls the `reply` string out
 * of a partial object as it grows, and hides tool rounds (`tool_calls`)
 * entirely. It is display-only: the finished response is still parsed by the
 * brain's normal protocol path, and this never influences routing.
 *
 * Returns `null` when the stream is a tool round, `''` when nothing readable
 * has arrived yet.
 */
export function streamingReplyPreview(raw: string): string | null {
  let text = raw;
  // Inline reasoning some OpenAI-compatible models emit before the answer.
  if (/^\s*<think>/i.test(text)) {
    const end = text.search(/<\/think>/i);
    if (end < 0) return '';
    text = text.slice(end + '</think>'.length);
  }
  text = text.replace(/^\s*```(?:json)?\s*/i, '');
  if (/"tool_calls"\s*:/.test(text)) return null;

  const key = text.match(/"reply"\s*:\s*"/);
  if (key && key.index !== undefined) return decodePartialJsonString(text.slice(key.index + key[0].length));
  // Protocol JSON whose reply field has not arrived yet.
  if (text.trimStart().startsWith('{')) return '';
  // A plain-text answer (models that ignore the protocol) reads as-is.
  return text.trim();
}

const SIMPLE_ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '', b: '', f: '', '"': '"', '\\': '\\', '/': '/' };

/** Decode a JSON string body up to its closing quote or the end of input. */
function decodePartialJsonString(body: string): string {
  let out = '';
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === '"') break;
    if (ch !== '\\') { out += ch; continue; }
    const next = body[i + 1];
    if (next === undefined) break; // escape split across chunks
    if (next === 'u') {
      const hex = body.slice(i + 2, i + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 5;
      continue;
    }
    out += SIMPLE_ESCAPES[next] ?? next;
    i += 1;
  }
  return out;
}
