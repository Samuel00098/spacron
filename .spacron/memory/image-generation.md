# Image & video generation (`generate_image` / `generate_video`)

`images::generate_media` tries providers in order: the user's ChatGPT plan
through Codex app-server first (images only), then the API-key providers in
`commands/media.rs` (OpenAI, Google, OpenRouter, fal, Replicate), falling back
on quota/auth/no-key errors and returning a per-provider report when none
works. Output goes to `<project>/generations`.

- Only the ChatGPT path was measured live. The HTTP shapes in `media.rs`
  (Sora `/v1/videos`, Veo `predictLongRunning`, fal queue, Replicate
  predictions) were written from docs on 2026-09-22 and never run with a real
  key; suspect them first when a provider fails.
- `<project>/generations` is outside the startup asset scope: the chat panel
  re-grants it per project (`allow_generations_dir`). Skip that and saved
  images/videos 403 after a restart.

ChatGPT-path facts measured live on 2026-09-22 that the code cannot tell you:

- A generation takes ~50–70s (one with a reference image: 66s). It spends the
  plan's image limit; the failure item is `{"type":"usageLimitExceeded"}`.
- The `imageGeneration` item carries BOTH `savedPath` (under
  `~/.codex/generated_images`) and the full base64 PNG in `result` (~1.5 MB of
  text). The copy into `<config>/generated-images` prefers the file and falls
  back to decoding.
- Reference images go in as `{"type":"localImage","path":…}` turn input.

Traps:

- The asset-protocol scope for the generated and pasted folders is granted at
  startup (`images::allow_image_dirs` in `lib.rs`), NOT in `tauri.conf.json`.
  Moving the folders means changing that call, or thumbnails silently 403.
- Only attachments with `generated: true` keep `path` when a thread is saved
  (`chatThreads.ts::copyAttachments`); pasted paths die with the temp folder on
  exit, so persisting them would render broken images after a restart. See
  [[image-attach-delivery]].
- The brain still cannot see pixels ([[orchestrator-emulator-tools]]): it
  learns reference paths from the attachment text ("saved at <path>"), so a
  change to `buildAttachmentPrompt`'s wording can break "edit this image".
- The brain's own Codex turns (`chatgpt::run_turn`) must keep Codex's native
  image tool off (`features.image_generation` per-thread override). With it on,
  the brain draws the picture itself and the chat shows only its sentence — the
  2026-09-22 "0 operations, 1m02s, no image" bug.
- With that tool off, the ChatGPT brain can still refuse outright ("image
  generation is unavailable in this session", 0 operations). The brain loop's
  one-shot media recovery pass (`mediaGenerationRequest` in `chat-turn.ts`)
  sends it back to call `generate_image`; if it refuses AGAIN, the loop calls
  the tool itself with the user's words (the San Francisco Bay screenshot:
  one recovery pass was not enough). Keep that classifier conservative — it
  now decides whether Spacron generates media without the model's consent.
- `run_turn`'s appended base instruction once said "you have no shell, file
  or web tools", which the model read as "no tools at all". It must keep
  saying the listed Spacron tools ARE available.
