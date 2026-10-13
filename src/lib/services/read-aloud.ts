import { invoke } from '@tauri-apps/api/core';
import { marked, type Token } from 'marked';
import { get, writable } from '$lib/stores/storeCompat';
import { showToast } from '$lib/stores/notification';
import { readAloudSettings, readAloudVoiceFor, type ReadAloudEngine } from '$lib/stores/readAloud';

/**
 * Read a chat reply aloud on request: with the OS's built-in voices (the Web
 * Speech API WebView2 exposes, free and offline) or a human-sounding cloud
 * voice (OpenAI or ElevenLabs, through `read_aloud_speak` so keys stay in the
 * backend). This is NOT the deleted reply-TTS pipeline: nothing ever speaks
 * on its own; the user presses Read aloud on one message and can stop it.
 */

/** The message being read, or null. Drives the button's Stop state. */
export const readAloudMessageId = writable<string | null>(null);

/** Chromium drops utterances that run past ~15 s, so speech goes in short pieces. */
const MAX_CHUNK = 220;

export function readAloudSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';
}

type MdToken = Token & {
  tokens?: MdToken[];
  items?: MdToken[];
  text?: string;
  header?: { tokens: MdToken[] }[];
  rows?: { tokens: MdToken[] }[][];
};

function inlineText(tokens: MdToken[] = []): string {
  return tokens.map((token) => {
    switch (token.type) {
      case 'codespan': case 'escape': case 'image': return token.text ?? '';
      case 'br': return ' ';
      case 'html': return '';
      default: return token.tokens ? inlineText(token.tokens) : token.text ?? token.raw;
    }
  }).join('');
}

/** End a spoken unit with a pause unless it already has one. */
function sentence(text: string): string {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  return !trimmed ? '' : /[.!?:;]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function blockText(tokens: MdToken[] = []): string[] {
  return tokens.flatMap((token): string[] => {
    switch (token.type) {
      case 'heading': case 'paragraph': return [sentence(inlineText(token.tokens))];
      case 'text': return [sentence(token.tokens ? inlineText(token.tokens) : token.text ?? '')];
      case 'list': return (token.items ?? []).flatMap((item) => blockText(item.tokens));
      case 'blockquote': return blockText(token.tokens);
      case 'code': return ['(code sample)'];
      case 'table': return [
        ...(token.header ?? []).map((cell) => sentence(inlineText(cell.tokens))),
        ...(token.rows ?? []).flatMap((row) => row.map((cell) => sentence(inlineText(cell.tokens)))),
      ];
      default: return [];
    }
  });
}

/**
 * Markdown as it should be heard: code blocks are announced, not spelled out;
 * headings, list items and table cells end in a pause; links read as their
 * text; emoji and status icons (which read as "red circle") are dropped.
 */
export function speakableText(markdown: string): string {
  return blockText(marked.lexer(markdown || '', { gfm: true }) as MdToken[])
    .join(' ')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/\.{2,}/g, '.')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Sentences packed into pieces short enough to survive the engine's cutoff. */
export function speechChunks(text: string, max = MAX_CHUNK): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [text];
  const chunks: string[] = [];
  let current = '';
  for (const raw of sentences) {
    const sentence = raw.trim();
    if (!sentence) continue;
    if (sentence.length > max) {
      if (current) { chunks.push(current); current = ''; }
      // A run-on sentence splits at commas, then at word boundaries.
      let rest = sentence;
      while (rest.length > max) {
        const cut = Math.max(rest.lastIndexOf(', ', max), rest.lastIndexOf(' ', max));
        const at = cut > max / 3 ? cut + 1 : max;
        chunks.push(rest.slice(0, at).trim());
        rest = rest.slice(at).trim();
      }
      current = rest;
    } else if ((current + ' ' + sentence).trim().length > max) {
      chunks.push(current);
      current = sentence;
    } else {
      current = (current + ' ' + sentence).trim();
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/** The most natural installed voice for the UI language. */
function pickVoice(): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return null;
  const lang = (navigator.language || 'en-US').toLowerCase();
  const base = lang.split('-')[0];
  const score = (voice: SpeechSynthesisVoice): number => {
    const voiceLang = voice.lang.toLowerCase();
    let value = voiceLang === lang ? 4 : voiceLang.startsWith(base) ? 2 : 0;
    if (/natural|neural|online/i.test(voice.name)) value += 3;
    if (voice.default) value += 1;
    return value;
  };
  return [...voices].sort((a, b) => score(b) - score(a))[0] ?? null;
}

// The voice list loads asynchronously; asking once early means the first
// Read aloud already has the natural voices to choose from.
if (readAloudSupported()) window.speechSynthesis.getVoices();

let session = 0;
let playing: HTMLAudioElement | null = null;

export function stopReadAloud(): void {
  session += 1;
  if (readAloudSupported()) window.speechSynthesis.cancel();
  if (playing) { playing.pause(); playing = null; }
  readAloudMessageId.set(null);
}

function readSystem(chunks: string[], mine: number): void {
  if (!readAloudSupported()) { readAloudMessageId.set(null); return; }
  const voice = pickVoice();
  let index = 0;
  const next = (): void => {
    if (mine !== session) return;
    if (index >= chunks.length) { readAloudMessageId.set(null); return; }
    const utterance = new SpeechSynthesisUtterance(chunks[index++]);
    if (voice) { utterance.voice = voice; utterance.lang = voice.lang; }
    utterance.onend = next;
    utterance.onerror = (event) => {
      // `interrupted`/`canceled` are our own Stop; anything else ends the read.
      if (mine === session && event.error !== 'interrupted' && event.error !== 'canceled') stopReadAloud();
    };
    window.speechSynthesis.speak(utterance);
  };
  next();
}

function audioUrl(base64: string, mimeType: string): string {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  return URL.createObjectURL(new Blob([bytes], { type: mimeType }));
}

/**
 * A cloud voice: each piece is fetched while the one before it plays, so after
 * the first request the reading runs without gaps. The first piece is kept
 * short so speech starts quickly.
 */
async function readCloud(engine: Exclude<ReadAloudEngine, 'system'>, voice: string, text: string, mine: number): Promise<void> {
  const opening = speechChunks(text, 240);
  const pieces = opening.length > 1 ? [opening[0], ...speechChunks(opening.slice(1).join(' '), 900)] : opening;
  const fetchPiece = (piece: string) =>
    invoke<{ audio: string; mimeType: string }>('read_aloud_speak', { provider: engine, voice, text: piece });
  let pending = fetchPiece(pieces[0]);
  for (let index = 0; index < pieces.length; index++) {
    let clip: { audio: string; mimeType: string };
    try {
      clip = await pending;
    } catch (error) {
      if (mine === session) {
        stopReadAloud();
        showToast(String(error ?? 'Read aloud failed'), 'error', 7000);
      }
      return;
    }
    if (mine !== session) return;
    if (index + 1 < pieces.length) pending = fetchPiece(pieces[index + 1]);
    const url = audioUrl(clip.audio, clip.mimeType);
    const audio = new Audio(url);
    playing = audio;
    const finished = await new Promise<boolean>((resolve) => {
      audio.onended = () => resolve(true);
      audio.onerror = () => resolve(false);
      audio.onpause = () => { if (!audio.ended) resolve(false); };
      void audio.play().catch(() => resolve(false));
    });
    URL.revokeObjectURL(url);
    if (playing === audio) playing = null;
    if (!finished || mine !== session) return;
  }
  if (mine === session) readAloudMessageId.set(null);
}

/** Read `markdown` aloud as message `messageId`; pressing it again stops. */
export function toggleReadAloud(messageId: string, markdown: string): void {
  const current = get(readAloudMessageId);
  stopReadAloud();
  if (current === messageId) return;
  const text = speakableText(markdown);
  if (!text) return;
  const mine = session;
  readAloudMessageId.set(messageId);
  const settings = get(readAloudSettings);
  if (settings.engine === 'system') readSystem(speechChunks(text), mine);
  else void readCloud(settings.engine, readAloudVoiceFor(settings), text, mine);
}

/** Speak a short sample with an engine and voice (the Settings Test button). */
export function previewReadAloud(engine: ReadAloudEngine, voice: string): void {
  stopReadAloud();
  const mine = session;
  readAloudMessageId.set('__preview__');
  const sample = 'Hi! This is how I will sound when I read a reply aloud for you.';
  if (engine === 'system') readSystem([sample], mine);
  else void readCloud(engine, voice, sample, mine);
}
