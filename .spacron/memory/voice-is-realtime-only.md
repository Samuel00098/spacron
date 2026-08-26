# Voice output is realtime-only; TTS is gone

Since 2026-08-25 Spacron never synthesizes speech itself. Two separate paths,
no overlap:

- **Transcription** (`transcription-hotkey.ts`) — speech-to-text only, lands
  text at the caret or in a terminal. Never speaks. See
  [[transcription-hotkey]].
- **Speech-to-speech** — one live realtime call (`realtime-voice.ts`), OpenAI
  over WebRTC or xAI Grok over WebSocket. The model owns the mic and speaks for
  itself; barge-in is server-side.

## What was deleted

`services/tts.ts` (+ its test), the Rust `tts_speak` command and its whole
provider block in `commands/secrets.rs` (~370 lines: the four `*_TTS_URL`
consts, `tts_voice_is_safe`, `apply_openai_speech_controls`, `TtsAudioPayload`,
`pcm_s16le_to_wav_bytes`), `ModelPurpose::Tts` and its arms, the entire TTS
voice/model catalog in `stores/settings.ts` (~11 arrays plus
`getTts*`/`getDefaultTts*`/`providerSupportsReplyTts`/`getProviderTtsBadge`/
the `ttsSupport` provider flag), and the Settings "Voice replies" section.

`voice-input.ts` lost its playback gate too — `setPlaybackActive`,
`VAD_PLAYBACK_*`, `PLAYBACK_TAIL_CHUNKS`. Nothing plays audio locally any more,
so `playbackActive` was permanently false.

## There is no separate voice brain any more

`voiceReplyProvider` was briefly renamed `voiceBrainProvider`, then deleted
outright along with `voiceConversationAiModelByProvider`,
`currentVoiceConversationAiModel` and `setVoiceConversationAiModel`.

`getConversationLlmConfig()` now takes **no argument** and always returns the
main AI provider/model. A realtime call brings its own brain, and the work it
delegates through the `spacron_orchestrator` tool goes to the SAME orchestrator
every other surface talks to — a second configurable brain only meant two
things to set and two ways for them to disagree. `sendChatMessage`'s
`voiceConversation` option still exists; it just no longer selects a model
(it still drives `conversational` phrasing and the undecided-spawn path).

`TtsVoiceOption`/`TtsModelOption` were renamed to
**`VoiceOption`/`VoiceModelOption`** — the realtime pickers still use these
shapes.

## The `'pipeline'` engine trap (fixed)

`VoiceConversationEngine` used to include `'pipeline'` and **default to it**,
while `FloatingPromptBar` mapped anything-not-xai to `'openai-realtime'`. A
fresh install therefore reported "Standard (STT + brain + TTS)" in Settings and
silently opened a billed OpenAI Realtime call — or just failed with no OpenAI
key. The member is gone, the default is `'openai-realtime'`, and a migration
moves persisted `'pipeline'` values across. If you add an engine, make sure the
bar's `startRealtimeVoiceMode` handles it explicitly rather than falling
through.

Related: [[transcription-hotkey]], [[prompt-bar-is-voice-only]]

## Entering voice mode (2026-08-25)

A **bare tap of left Alt** toggles a realtime call from anywhere in the app,
including while the caret is in a text input or a dialog. The old
`voiceShortcutArmedRef` (which required clicking the bar first) was removed at
the user's explicit request, with the tradeoff stated: a stray Alt tap now opens
the mic and starts a call billed per audio token. That is why the gesture stays
a *deliberate bare tap* via `alt-tap-gesture.ts` — cancelled by any modifier or
any other key — rather than "Alt was involved". Don't loosen it further.

`Ctrl+Shift+M` (`launchVoiceMode`) is a second, separate entry point and still
goes through AppShell's normal bubble handler, so it DOES stand down for modals.
