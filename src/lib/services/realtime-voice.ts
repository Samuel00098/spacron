import { invoke } from '@tauri-apps/api/core';
import { requestMicrophoneStream } from '$lib/services/voice-input';

/**
 * OpenAI Realtime (speech-to-speech) voice engine.
 *
 * Unlike the classic pipeline (VAD → STT upload → brain LLM → TTS chunks),
 * a Realtime session is one live WebRTC call: the mic streams straight to the
 * model, the model's voice streams straight back, and turn-taking/barge-in are
 * handled server-side. First audio typically lands well under a second after
 * the user stops speaking — the whole point of offering this engine.
 *
 * The SDP offer/answer exchange happens in Rust (`openai_realtime_connect`) so
 * the OpenAI API key never reaches the renderer and the webview CSP stays
 * closed. Only the resulting peer-to-peer audio/data traffic — which CSP does
 * not govern — flows from the renderer.
 */

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
};

export function isRealtimeVoiceSupported(): boolean {
  return (
    typeof RTCPeerConnection === 'function' &&
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia
  );
}

const ORCHESTRATOR_TOOL = {
  type: 'function',
  name: 'spacron_orchestrator',
  description:
    "Send a request to Spacron's agent orchestrator. Use it whenever the user wants project work done or asks about it: spawning/closing AI coding agents (Claude, Codex, Gemini, …), assigning them tasks, checking what agents are doing, reading their output, or navigating the app. Do NOT use it for casual conversation.",
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

type RealtimeEvent = {
  type?: string;
  transcript?: string;
  delta?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
  error?: { message?: string };
  response?: { status?: string; status_details?: { error?: { message?: string } } };
};

export async function startRealtimeVoiceSession(options: {
  model: string;
  voice: string;
  instructions: string;
  callbacks: RealtimeVoiceCallbacks;
}): Promise<RealtimeVoiceSession> {
  const { model, voice, instructions, callbacks } = options;

  let ended = false;
  let pc: RTCPeerConnection | null = null;
  let dc: RTCDataChannel | null = null;
  let mic: MediaStream | null = null;
  let audioEl: HTMLAudioElement | null = null;
  let state: RealtimeVoiceState = 'connecting';
  // Assistant transcript accumulated across deltas for the current utterance.
  let assistantBuf = '';

  const setState = (next: RealtimeVoiceState) => {
    if (ended || next === state) return;
    state = next;
    callbacks.onStateChange?.(next);
  };

  const teardown = (notify: boolean) => {
    if (ended) return;
    ended = true;
    try {
      dc?.close();
    } catch {
      /* already closed */
    }
    mic?.getTracks().forEach((track) => track.stop());
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
    mic = null;
    audioEl = null;
    if (notify) callbacks.onEnded?.();
  };

  const send = (event: Record<string, unknown>) => {
    if (ended || !dc || dc.readyState !== 'open') return;
    try {
      dc.send(JSON.stringify(event));
    } catch {
      /* channel is closing — the connection-state handler reports it */
    }
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
        setState('listening');
        break;
      case 'input_audio_buffer.speech_stopped':
        setState('thinking');
        break;
      case 'conversation.item.input_audio_transcription.completed':
        if (event.transcript?.trim()) callbacks.onUserTranscript?.(event.transcript.trim());
        break;
      case 'response.created':
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
        // Text-only responses (e.g. a pure tool round) produce no audio buffer
        // events; don't leave the orb stuck on "thinking".
        if (state === 'thinking') setState('listening');
        if (event.response?.status === 'failed') {
          callbacks.onError?.(
            event.response?.status_details?.error?.message || 'The voice model failed to respond.',
          );
        }
        break;
      case 'error':
        callbacks.onError?.(event.error?.message || 'Realtime voice error.');
        break;
      default:
        break;
    }
  };

  // --- Connect ---
  if (!isRealtimeVoiceSupported()) {
    throw new Error('Realtime voice needs WebRTC, which this runtime does not support.');
  }

  const streamOrError = await requestMicrophoneStream();
  if (typeof streamOrError === 'string') {
    throw new Error(streamOrError);
  }
  mic = streamOrError;

  try {
    pc = new RTCPeerConnection();
    audioEl = new Audio();
    audioEl.autoplay = true;
    pc.ontrack = (event) => {
      if (audioEl && event.streams[0]) audioEl.srcObject = event.streams[0];
    };
    for (const track of mic.getAudioTracks()) pc.addTrack(track, mic);

    dc = pc.createDataChannel('oai-events');
    dc.onmessage = (event) => {
      try {
        handleEvent(JSON.parse(event.data) as RealtimeEvent);
      } catch {
        /* non-JSON frame — ignore */
      }
    };
    dc.onopen = () => setState('listening');

    pc.onconnectionstatechange = () => {
      const s = pc?.connectionState;
      if ((s === 'failed' || s === 'disconnected' || s === 'closed') && !ended) {
        if (s === 'failed') callbacks.onError?.('Voice connection lost.');
        teardown(true);
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const answerSdp = await invoke<string>('openai_realtime_connect', {
      offerSdp: offer.sdp ?? '',
      model,
      voice,
      instructions,
      tools: [ORCHESTRATOR_TOOL],
    });
    if (ended) throw new Error('Voice session was cancelled.');
    await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
  } catch (error) {
    teardown(false);
    throw error instanceof Error ? error : new Error(String(error));
  }

  return {
    stop() {
      teardown(true);
    },
  };
}
