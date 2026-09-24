import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { fromGatewayEvent, toGatewayEvent } from './realtime-voice';

describe('Vercel AI Gateway realtime translation', () => {
  it('maps gateway server events onto the OpenAI-shaped events the handler reads', () => {
    expect(fromGatewayEvent({ type: 'speech-started' })).toEqual({ type: 'input_audio_buffer.speech_started' });
    expect(fromGatewayEvent({ type: 'audio-delta', delta: 'AAAA' })).toEqual({ type: 'response.output_audio.delta', delta: 'AAAA' });
    expect(fromGatewayEvent({ type: 'input-transcription-completed', transcript: 'hi' })).toEqual({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'hi',
    });
    expect(fromGatewayEvent({ type: 'function-call-arguments-done', callId: 'c1', name: 'spacron_orchestrator', arguments: '{}' })).toEqual({
      type: 'response.function_call_arguments.done',
      call_id: 'c1',
      name: 'spacron_orchestrator',
      arguments: '{}',
    });
    expect(fromGatewayEvent({ type: 'response-done', status: 'failed' })).toEqual({ type: 'response.done', response: { status: 'failed' } });
    expect(fromGatewayEvent({ type: 'error', message: 'nope' })).toEqual({ type: 'error', error: { message: 'nope' } });
  });

  it('drops server events it has no counterpart for', () => {
    expect(fromGatewayEvent({ type: 'session-usage' })).toBeNull();
    expect(fromGatewayEvent({})).toBeNull();
  });

  it('maps outgoing audio and response requests', () => {
    const names = new Map<string, string>();
    expect(toGatewayEvent({ type: 'input_audio_buffer.append', audio: 'AAAA' }, names)).toEqual({ type: 'input-audio-append', audio: 'AAAA' });
    expect(toGatewayEvent({ type: 'response.create' }, names)).toEqual({ type: 'response-create' });
  });

  it('names the tool on a function output, from the call it answers', () => {
    const names = new Map([['c1', 'spacron_orchestrator']]);
    expect(
      toGatewayEvent({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: 'c1', output: 'done' } }, names),
    ).toEqual({
      type: 'conversation-item-create',
      item: { type: 'function-call-output', callId: 'c1', name: 'spacron_orchestrator', output: 'done' },
    });
    expect(names.has('c1')).toBe(false);
  });

  it('sends background announcements as a user text item', () => {
    const event = {
      type: 'conversation.item.create',
      item: { type: 'message', role: 'system', content: [{ type: 'input_text', text: 'Background update: Codex finished.' }] },
    };
    expect(toGatewayEvent(event, new Map())).toEqual({
      type: 'conversation-item-create',
      item: { type: 'text-message', role: 'user', text: 'Background update: Codex finished.' },
    });
  });

  it('drops outgoing events the gateway has no form for', () => {
    expect(toGatewayEvent({ type: 'session.commentary.append' }, new Map())).toBeNull();
  });
});
