import { invoke } from '@tauri-apps/api/core';
import { downsamplePcmChunks, requestMicrophoneStream } from '$lib/services/voice-input';

/**
 * Realtime (speech-to-speech) voice engines.
 *
 * A realtime session is one live call: the mic streams straight to the model,
 * the model's voice streams straight back, and turn-taking/barge-in are handled
 * server-side. First audio typically lands well under a second after the user
 * stops speaking — the whole point of offering these engines.
 *
 * Three engines, two transports, and shared lifecycle handling:
 *
 * - 'openai' — WebRTC. The SDP offer/answer is exchanged in Rust
 *   (`openai_realtime_connect`) so the API key never reaches the renderer and
 *   the webview CSP stays closed; audio + events then flow peer-to-peer, which
 *   CSP does not govern.
 * - 'xai' (Grok) — WebSocket to wss://api.x.ai/v1/realtime (allowed by CSP),
 *   authenticated with a minutes-lived client secret minted in Rust
 *   (`xai_realtime_client_secret`), streaming 24 kHz PCM16 both ways.
 * - 'openai-live' — WebRTC to OpenAI GPT-Live. Rust creates the session with
 *   client delegation; the renderer returns delegation results to the session.
 */

export type RealtimeVoiceProvider = 'openai' | 'xai' | 'openai-live';

export type RealtimeVoiceState = 'connecting' | 'listening' | 'thinking' | 'speaking';

export type RealtimeVoiceCallbacks = {
  onStateChange?: (state: RealtimeVoiceState) => void;
  /** Final transcript of what the user said in a turn. */
  onUserTranscript?: (text: string) => void;
  /** Assistant speech transcript; `final` marks the end of the utterance. */
  onAssistantTranscript?: (text: string, final: boolean) => void;
  /**
   * The model asked Spacron's orchestrator to do real work (spawn agents,
   * report status, …). Return the orchestrator's reply text; it is fed back to
   * the model as the tool result so the model can speak it.
   */
  onOrchestratorCommand?: (request: string) => Promise<string>;
  onError?: (message: string) => void;
  /** The session ended — either via stop() or a transport failure. */
  onEnded?: () => void;
};

export type RealtimeVoiceSession = {
  stop: () => void;
  /**
   * Speak a background update (e.g. "Codex finished: Add dark mode") through
   * the live call in the model's own voice. Queued until the model is idle so
   * it never talks over the user or an in-flight response.
   */
  announce: (text: string) => void;
};

// The one live session's announcer (there is never more than one call at a
// time). Lets far-away modules — the orchestrator's completion watcher — speak
// through the call without holding a session handle.
let activeAnnouncer: ((text: string) => void) | null = null;

/**
 * Speak `text` through the live realtime session, if one exists.
 * Returns false when no session is active (caller falls back to the chime).
 */
export function announceViaRealtimeVoice(text: string): boolean {
  if (!activeAnnouncer) return false;
  activeAnnouncer(text);
  return true;
}

function getAudioContextCtor(): (new () => AudioContext) | null {
  if (typeof window === 'undefined') return null;
  return (window as any).AudioContext || (window as any).webkitAudioContext || null;
}

export function isRealtimeVoiceSupported(provider: RealtimeVoiceProvider = 'openai'): boolean {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return false;
  if (provider === 'openai' || provider === 'openai-live') return typeof RTCPeerConnection === 'function';
  // xAI streams raw PCM over a WebSocket and plays replies via Web Audio.
  return typeof WebSocket === 'function' && !!getAudioContextCtor();
}

const ORCHESTRATOR_TOOL = {
  type: 'function',
  name: 'spacron_orchestrator',
  description:
    "Send a request to Spacron's agent orchestrator. Use it whenever the user wants project work done or asks about it: spawning/closing AI coding agents (Claude, Codex, Gemini, …), assigning them tasks, checking what agents are doing, reading their output, or navigating the app. The orchestrator acts on the request immediately. Do NOT use it for casual conversation.",
  parameters: {
    type: 'object',
    properties: {
      request: {
        type: 'string',
        description:
          "The user's request rephrased as one clear, standalone instruction or question for the orchestrator.",
      },
    },
    required: ['request'],
  },
} as const;

// System instructions for the realtime speech-to-speech engines. The model
// converses on its own and delegates real work to the orchestrator via the
// spacron_orchestrator tool. Shared by the floating bar and the chat composer,
// so the voice persona is identical no matter where the call was started.
export const REALTIME_VOICE_INSTRUCTIONS = [
  "You are Spacron's voice assistant. The user is a developer talking to you hands-free inside Spacron, a desktop app that orchestrates AI coding agents (Claude Code, Codex, Gemini and others) working in terminals on the user's projects.",
  'Personality: a sharp, friendly pair-programming partner. Sound natural and conversational — contractions, brief reactions, no corporate filler.',
  'Keep spoken replies short: one to three sentences unless the user asks for detail. Never read code, file paths, or long output aloud verbatim — summarize what it means instead.',
  'EXCEPTION — when the user explicitly asks you to READ OUT an agent\'s output ("read out what <agent> produced", "read me that output" — where <agent> is whatever name they used), the orchestrator returns the agent\'s actual transcript. Read it out to them properly rather than summarizing it — that is what they asked for. Speak it naturally: skip escape codes and progress bars, say file paths as words, and describe code by what it does instead of spelling it character by character.',
  'IMPORTANT for that case: the orchestrator decides to return a full transcript by the WORDING of your request, so keep the read-out intent in it. Phrase it as "Read out <agent name>\'s output" (or "Read out the last agent\'s output" when they did not name one). If you rewrite it into "what did <agent> say?" you will get a short summary back instead of the transcript the user asked to hear.',
  'Whenever the user wants project work done or asked about — spawning or closing agents, giving an agent a task, checking progress or output, navigating the app — call the spacron_orchestrator tool with a clear standalone request, then relay its answer conversationally. For casual conversation, just talk; do not call the tool.',
  'Calling the tool executes the request immediately — there is no separate confirmation step after it. When the user clearly asked for something, call the tool right away instead of only saying you will. Only ask a clarifying question first when the request is ambiguous or destructive (like closing agents).',
  'WHERE AGENTS RUN — every new agent runs either in an isolated git worktree (its own branch; edits do not appear in the main checkout until merged) or in the main repo (edits visible immediately; needed for git tag/push). Resolve this BEFORE calling the tool: if the user said where ("in a worktree", "in the main repo", "no worktree"), keep those exact words in the request you send. If they did not say and you are spawning an agent, ask them first — "isolated worktree, or the main repo?" — then call the tool with their answer included. Carry it per agent: "open one Claude Code in a worktree and another in the main repo" must go through as one request naming both placements.',
  'If a tool result is long, give the gist and offer to go deeper — unless it came from an explicit read-out request, which you read through as described above.',
].join('\n');

// xAI's realtime API speaks 24 kHz mono PCM16 in both directions.
const XAI_AUDIO_RATE = 24_000;

/** Encode a Float32 PCM buffer as base64 s16le for input_audio_buffer.append. */
function floatToPcm16Base64(samples: Float32Array): string {
  const int16 = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  const bytes = new Uint8Array(int16.buffer);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Decode a base64 s16le audio delta into Float32 PCM. */
function pcm16Base64ToFloat(b64: string): Float32Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const int16 = new Int16Array(bytes.buffer, 0, Math.floor(bytes.length / 2));
  const out = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i += 1) out[i] = int16[i] / 0x8000;
  return out;
}

type RealtimeEvent = {
  type?: string;
  transcript?: string;
  delta?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
  delegation?: { id?: string };
  error?: { message?: string };
  response?: { status?: string; status_details?: { error?: { message?: string } } };
};

export async function startRealtimeVoiceSession(options: {
  provider?: RealtimeVoiceProvider;
  model: string;
  voice: string;
  instructions: string;
  callbacks: RealtimeVoiceCallbacks;
}): Promise<RealtimeVoiceSession> {
  const { model, voice, instructions, callbacks } = options;
  const provider: RealtimeVoiceProvider = options.provider ?? 'openai';

  let ended = false;
  let mic: MediaStream | null = null;
  let state: RealtimeVoiceState = 'connecting';
  // Assistant transcript accumulated across deltas for the current utterance.
  let assistantBuf = '';
  let liveUserBuf = '';
  let liveAssistantBuf = '';
  let liveDelegationContext: string[] = [];
  // Turn bookkeeping for announcements: an injected response.create while a
  // response is active (or the user is mid-utterance) errors out / talks over,
  // so background updates queue until the call is idle.
  let responseActive = false;
  let userSpeaking = false;
  const announcementQueue: string[] = [];
  // The announcement whose response.create is in flight, so an
  // "already has active response" race can silently re-queue it.
  let announcementInFlight: string | null = null;

  // Transport hooks, filled in by the provider-specific connect below.
  let transportSend: ((json: string) => void) | null = null;
  let transportClose: (() => void) | null = null;
  let channelReady = false;

  // --- OpenAI (WebRTC) transport state ---
  let pc: RTCPeerConnection | null = null;
  let dc: RTCDataChannel | null = null;
  let audioEl: HTMLAudioElement | null = null;

  // --- xAI (WebSocket) transport state ---
  let captureContext: AudioContext | null = null;
  let captureSource: MediaStreamAudioSourceNode | null = null;
  let captureProcessor: ScriptProcessorNode | null = null;
  let playbackContext: AudioContext | null = null;
  let nextPlayTime = 0;
  const liveSources = new Set<AudioBufferSourceNode>();

  const setState = (next: RealtimeVoiceState) => {
    if (ended || next === state) return;
    state = next;
    callbacks.onStateChange?.(next);
  };

  /** Drop any reply audio that is queued or playing (xAI transport only). */
  const stopPlayback = () => {
    for (const source of liveSources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        /* already stopped */
      }
    }
    liveSources.clear();
    nextPlayTime = 0;
  };

  /** Schedule one PCM reply chunk gaplessly after the previous one (xAI). */
  const playPcmChunk = (b64: string) => {
    if (ended) return;
    if (!playbackContext) {
      const Ctor = getAudioContextCtor();
      if (!Ctor) return;
      playbackContext = new Ctor();
    }
    const samples = pcm16Base64ToFloat(b64);
    if (samples.length === 0) return;
    const buffer = playbackContext.createBuffer(1, samples.length, XAI_AUDIO_RATE);
    buffer.getChannelData(0).set(samples);
    const source = playbackContext.createBufferSource();
    source.buffer = buffer;
    source.connect(playbackContext.destination);
    const startAt = Math.max(playbackContext.currentTime + 0.02, nextPlayTime);
    source.onended = () => {
      liveSources.delete(source);
      // Reply audio drained with nothing queued behind it: back to listening.
      if (!ended && liveSources.size === 0 && state === 'speaking') setState('listening');
    };
    liveSources.add(source);
    source.start(startAt);
    nextPlayTime = startAt + buffer.duration;
  };

  const teardown = (notify: boolean) => {
    if (ended) return;
    ended = true;
    if (activeAnnouncer === announce) activeAnnouncer = null;
    // Stop any xAI audio that's still playing.
    stopPlayback();
    transportClose?.();
    mic?.getTracks().forEach((track) => track.stop());
    mic = null;
    if (notify) callbacks.onEnded?.();
  };

  const send = (event: Record<string, unknown>) => {
    if (ended || !transportSend) return;
    try {
      transportSend(JSON.stringify(event));
    } catch {
      /* channel is closing — the transport's close handler reports it */
    }
  };

  const flushAnnouncements = () => {
    if (ended || !channelReady) return;
    if (responseActive || userSpeaking || announcementQueue.length === 0) return;
    const text = announcementQueue.shift()!;
    announcementInFlight = text;
    if (provider === 'openai-live') {
      send({
        type: 'session.commentary.append',
        delegation_id: null,
        content: `Background update from Spacron: ${text}. Relay this in one short spoken sentence.`,
      });
      announcementInFlight = null;
      return;
    }
    send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'system',
        content: [
          {
            type: 'input_text',
            text: `Background update from Spacron (not spoken by the user): ${text}\nRelay this to the user now in one short spoken sentence.`,
          },
        ],
      },
    });
    send({ type: 'response.create' });
    // Optimistic: response.created confirms, and the error handler re-queues if
    // a user turn beat us to it.
    responseActive = true;
  };

  const announce = (text: string) => {
    const trimmed = text.trim();
    if (ended || !trimmed) return;
    announcementQueue.push(trimmed);
    flushAnnouncements();
  };

  const handleFunctionCall = async (name: string, callId: string, argsJson: string) => {
    let output: string;
    if (name === ORCHESTRATOR_TOOL.name && callbacks.onOrchestratorCommand) {
      try {
        const args = JSON.parse(argsJson || '{}');
        const request = typeof args?.request === 'string' ? args.request.trim() : '';
        output = request
          ? await callbacks.onOrchestratorCommand(request)
          : 'The request argument was empty.';
      } catch (error) {
        output = `The orchestrator failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    } else {
      output = `Unknown tool: ${name}`;
    }
    if (ended) return;
    send({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: callId, output: output.slice(0, 8_000) },
    });
    // Ask the model to speak the tool result.
    send({ type: 'response.create' });
  };

  const handleEvent = (event: RealtimeEvent) => {
    switch (event.type) {
      // The user started talking (also fires on barge-in: the server cuts the
      // assistant's audio and listens).
      case 'input_audio_buffer.speech_started':
        userSpeaking = true;
        // xAI transport plays reply audio locally — silence it on barge-in.
        stopPlayback();
        setState('listening');
        break;
      case 'input_audio_buffer.speech_stopped':
        userSpeaking = false;
        setState('thinking');
        break;
      case 'conversation.item.input_audio_transcription.completed':
        if (event.transcript?.trim()) callbacks.onUserTranscript?.(event.transcript.trim());
        break;
      case 'session.started':
        channelReady = true;
        setState('listening');
        flushAnnouncements();
        break;
      case 'session.input_transcript.delta':
        liveUserBuf += event.delta ?? '';
        break;
      case 'session.output_transcript.delta':
        liveAssistantBuf += event.delta ?? '';
        setState('speaking');
        if (liveAssistantBuf) callbacks.onAssistantTranscript?.(liveAssistantBuf, false);
        break;
      case 'session.delegation.created':
        if (event.delegation?.id && callbacks.onOrchestratorCommand) {
          const request = [...liveDelegationContext, liveUserBuf.trim()]
            .filter(Boolean)
            .slice(-6)
            .join('\n');
          if (liveUserBuf.trim()) callbacks.onUserTranscript?.(liveUserBuf.trim());
          liveUserBuf = '';
          void callbacks.onOrchestratorCommand(request || 'Handle the latest user request.')
            .then((output) => {
              if (ended) return;
              send({
                type: 'session.commentary.append',
                delegation_id: event.delegation!.id,
                content: output.slice(0, 8_000),
              });
              liveDelegationContext = [...liveDelegationContext, request].slice(-6);
            })
            .catch((error) => callbacks.onError?.(
              `GPT Live delegation failed: ${error instanceof Error ? error.message : String(error)}`,
            ));
        }
        break;
      case 'session.output_transcript.done': {
        const text = (event.transcript ?? liveAssistantBuf).trim();
        liveAssistantBuf = '';
        if (text) {
          liveDelegationContext = [...liveDelegationContext, text].slice(-6);
          callbacks.onAssistantTranscript?.(text, true);
        }
        break;
      }
      case 'session.output_audio.done':
        if (liveAssistantBuf.trim()) {
          const text = liveAssistantBuf.trim();
          liveAssistantBuf = '';
          liveDelegationContext = [...liveDelegationContext, text].slice(-6);
          callbacks.onAssistantTranscript?.(text, true);
        }
        break;
      case 'response.created':
        responseActive = true;
        setState('thinking');
        break;
      case 'response.output_audio_transcript.delta':
        setState('speaking');
        assistantBuf += event.delta ?? '';
        if (assistantBuf) callbacks.onAssistantTranscript?.(assistantBuf, false);
        break;
      case 'response.output_audio_transcript.done': {
        const text = (event.transcript ?? assistantBuf).trim();
        assistantBuf = '';
        if (text) callbacks.onAssistantTranscript?.(text, true);
        break;
      }
      // Reply audio over the WebSocket transport (base64 PCM16 deltas).
      case 'response.output_audio.delta':
        if (event.delta) {
          setState('speaking');
          playPcmChunk(event.delta);
        }
        break;
      // WebRTC-only signals for when the remote audio actually starts/drains —
      // response.done fires before playback finishes, so these drive the orb.
      case 'output_audio_buffer.started':
        setState('speaking');
        break;
      case 'output_audio_buffer.stopped':
      case 'output_audio_buffer.cleared':
        setState('listening');
        break;
      case 'response.function_call_arguments.done':
        if (event.call_id) {
          void handleFunctionCall(event.name ?? '', event.call_id, event.arguments ?? '');
        }
        break;
      case 'response.done':
        responseActive = false;
        announcementInFlight = null;
        // Text-only responses (e.g. a pure tool round) produce no audio buffer
        // events; don't leave the orb stuck on "thinking".
        if (state === 'thinking') setState('listening');
        if (event.response?.status === 'failed') {
          callbacks.onError?.(
            event.response?.status_details?.error?.message || 'The voice model failed to respond.',
          );
        }
        flushAnnouncements();
        break;
      case 'error': {
        // A queued announcement can race a user turn's auto-response; put it
        // back and retry at the next idle point instead of surfacing an error.
        const message = event.error?.message || 'Realtime voice error.';
        if (announcementInFlight && /active response/i.test(message)) {
          announcementQueue.unshift(announcementInFlight);
          announcementInFlight = null;
          responseActive = true; // the server said one is running
          break;
        }
        callbacks.onError?.(message);
        break;
      }
      default:
        break;
    }
  };

  const handleRawMessage = (data: unknown) => {
    if (typeof data !== 'string') return;
    try {
      handleEvent(JSON.parse(data) as RealtimeEvent);
    } catch {
      /* non-JSON frame — ignore */
    }
  };

  // --- Connect ---
  if (!isRealtimeVoiceSupported(provider)) {
    throw new Error(
      provider === 'openai'
        ? 'Realtime voice needs WebRTC, which this runtime does not support.'
        : provider === 'openai-live'
          ? 'GPT Live voice needs WebRTC, which this runtime does not support.'
          : 'Realtime voice needs WebSocket + Web Audio, which this runtime does not support.',
    );
  }

  const streamOrError = await requestMicrophoneStream();
  if (typeof streamOrError === 'string') {
    throw new Error(streamOrError);
  }
  mic = streamOrError;

  try {
    if (provider === 'openai' || provider === 'openai-live') {
      pc = new RTCPeerConnection();
      audioEl = new Audio();
      audioEl.autoplay = true;
      pc.ontrack = (event) => {
        if (audioEl && event.streams[0]) audioEl.srcObject = event.streams[0];
      };
      for (const track of mic.getAudioTracks()) pc.addTrack(track, mic);

      dc = pc.createDataChannel('oai-events');
      transportSend = (json) => dc?.send(json);
      transportClose = () => {
        try {
          dc?.close();
        } catch {
          /* already closed */
        }
        try {
          pc?.close();
        } catch {
          /* already closed */
        }
        if (audioEl) {
          audioEl.pause();
          audioEl.srcObject = null;
        }
        dc = null;
        pc = null;
        audioEl = null;
      };
      dc.onmessage = (event) => handleRawMessage(event.data);
      dc.onopen = () => {
        if (provider === 'openai') {
          channelReady = true;
          setState('listening');
          flushAnnouncements();
        }
      };

      pc.onconnectionstatechange = () => {
        const s = pc?.connectionState;
        if ((s === 'failed' || s === 'disconnected' || s === 'closed') && !ended) {
          if (s === 'failed') callbacks.onError?.('Voice connection lost. Check your network and try again.');
          teardown(true);
        }
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const localSdp = offer.sdp ?? pc.localDescription?.sdp ?? '';
      if (!localSdp.trim().startsWith('v=0')) {
        throw new Error('Could not create a valid SDP offer.');
      }

      const answerSdp = await invoke<string>(
        provider === 'openai' ? 'openai_realtime_connect' : 'openai_live_connect',
        provider === 'openai'
          ? { offerSdp: localSdp, model, voice, instructions, tools: [ORCHESTRATOR_TOOL] }
          : { offerSdp: localSdp, model, voice, instructions },
      );
      if (ended) throw new Error('Voice session was cancelled.');
      await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
    } else {
      // xAI Grok Realtime over WebSocket. The minutes-lived client secret is
      // minted in Rust and presented as a subprotocol (never a URL parameter,
      // so it can't leak into logs).
      const secret = await invoke<string>('xai_realtime_client_secret');
      if (ended) throw new Error('Voice session was cancelled.');

      const socket = new WebSocket(
        `wss://api.x.ai/v1/realtime?model=${encodeURIComponent(model)}`,
        [`xai-client-secret.${secret}`],
      );
      transportSend = (json) => socket.send(json);
      transportClose = () => {
        stopPlayback();
        captureProcessor?.disconnect();
        captureSource?.disconnect();
        if (captureContext && captureContext.state !== 'closed') {
          void captureContext.close().catch(() => undefined);
        }
        if (playbackContext && playbackContext.state !== 'closed') {
          void playbackContext.close().catch(() => undefined);
        }
        captureProcessor = null;
        captureSource = null;
        captureContext = null;
        playbackContext = null;
        try {
          socket.close();
        } catch {
          /* already closed */
        }
      };

      await new Promise<void>((resolve, reject) => {
        socket.onopen = () => resolve();
        socket.onerror = () => reject(new Error('Could not connect to Grok Realtime.'));
        socket.onclose = () => reject(new Error('Grok Realtime refused the connection.'));
      });
      if (ended) throw new Error('Voice session was cancelled.');

      socket.onmessage = (event) => handleRawMessage(event.data);
      socket.onerror = null;
      socket.onclose = () => {
        if (!ended) {
          callbacks.onError?.('Grok voice connection lost. Check your network and try again.');
          teardown(true);
        }
      };

      send({
        type: 'session.update',
        session: {
          voice,
          instructions,
          // Tune Grok's server VAD (OpenAI Realtime-compatible fields) for more
          // patient turn-taking: a slightly longer end-of-turn silence so a mid-
          // thought pause doesn't cut the user off, plus lead-in padding so the
          // first word of a turn isn't clipped. (OpenAI's GPT Realtime path uses
          // semantic_vad, configured server-side in openai_realtime_connect.)
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 700,
          },
          audio: {
            input: { format: { type: 'audio/pcm', rate: XAI_AUDIO_RATE } },
            output: { format: { type: 'audio/pcm', rate: XAI_AUDIO_RATE } },
          },
          tools: [ORCHESTRATOR_TOOL],
        },
      });

      // Stream the mic as 24 kHz PCM16. The capture graph mirrors the pipeline
      // engine's (ScriptProcessor for WebKit compatibility); each ~85 ms buffer
      // is downsampled from the device rate and shipped as one append event.
      const Ctor = getAudioContextCtor()!;
      captureContext = new Ctor();
      captureSource = captureContext.createMediaStreamSource(mic);
      captureProcessor = captureContext.createScriptProcessor(4096, 1, 1);
      const captureRate = captureContext.sampleRate;
      captureProcessor.onaudioprocess = (event: AudioProcessingEvent) => {
        if (ended) return;
        const input = event.inputBuffer.getChannelData(0);
        const pcm = downsamplePcmChunks([new Float32Array(input)], captureRate, XAI_AUDIO_RATE);
        if (pcm.length === 0) return;
        send({ type: 'input_audio_buffer.append', audio: floatToPcm16Base64(pcm) });
      };
      captureSource.connect(captureProcessor);
      // ScriptProcessorNodes only fire when connected to the destination; the
      // node outputs silence, so nothing is audible.
      captureProcessor.connect(captureContext.destination);

      channelReady = true;
      setState('listening');
      flushAnnouncements();
    }
  } catch (error) {
    teardown(false);
    throw error instanceof Error ? error : new Error(String(error));
  }

  activeAnnouncer = announce;

  return {
    stop() {
      teardown(true);
    },
    announce,
  };
}
