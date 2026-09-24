# Vercel AI Gateway provider (`vercel`): what was verified, and how (2026-09-24)

One key covers chat, dictation, image/video generation and the realtime voice
engine. Built without a gateway key, so **nothing has run end to end yet**.

Verified against the live gateway without a key: every route used
(`/v1/chat/completions`, `/v1/models`, `/v1/realtime/client-secrets`,
`/v4/ai/{transcription,image,video}-model`, `video-model/{start,status}`,
the `wss://…/v4/ai/realtime-model` upgrade) answers 401 "authentication"
with our request shapes, and 404 for a made-up route. That probe caught a real
bug: the client-secret mint rejects `expiresIn` over 300.

Not verified (needs a key): that each realtime model actually talks back over
the normalized protocol, output audio at 24 kHz for every lab (Gemini Live's
native input rate is 16 kHz), and whether Gemini Live sends
`audio-transcript-*` or only `transcript-fragment` (the translator drops the
latter, so its chat transcript could be empty while audio works).

The gateway does not pass OpenAI realtime events through. It speaks the AI SDK
realtime v4 events, so `realtime-voice.ts` translates at the edge. Source of
truth for those shapes: the npm packages `@ai-sdk/provider`
(`realtime-model/v4/*`) and `@ai-sdk/gateway` (`gateway-realtime-*.ts`,
`gateway-provider.ts` for the mint). The docs site only shows SDK calls.

Related: [[voice-is-realtime-only]], [[image-generation]], [[cargo-check-in-agent-shell]].
