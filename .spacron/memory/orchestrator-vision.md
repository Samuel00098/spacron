# Orchestrator vision: who gets images, and the traps (2026-09-24)

The chat sends images only to models that accept them; every other model gets
exactly the text request it got before. **Rust decides, in one place**:
`accepts_images` in `commands/secrets/agent_turn.rs` (catalogue modality, else
`vision::model_accepts_images` by name, minus endpoints in `images_refused`).
Order of evidence: the provider's own catalogue → what any published catalogue
says for the same bare model name (`vision::from_catalogues`, filled from
OpenRouter/Kilo/Groq lists and OpenRouter's public list, fetched once per
session by `ensure_public_catalogue`) → name rules (GPT/o-series and Grok by
version number, never by a list of names; that list went stale on gpt-6).
The ChatGPT plan passes images as Codex `localImage` inputs (paths, checked by
`vision::allowed_image_path`). The picker's icons ask `ai_models_accept_images`,
the same function. To audit every configured provider for free:
`cargo test --lib live_model_capability_audit -- --ignored --nocapture`.
The frontend only passes file paths along (`BrainToolResult.images`,
`userImages`); it never decides.

- **Folder allowlist.** `vision::load` reads only from `%TEMP%/spacron-screenshots`,
  `%TEMP%/spacron-playwright` and the pasted-images dir. A new tool that saves
  screenshots elsewhere gets its images silently dropped — add the folder to
  `allowed_roots`, don't loosen the check (the image goes to a third party).
- **Latest round only**, plus the user's own attachments, at most 4 per request,
  downscaled to 1568 px. Older screenshots stay as their text line: they show a
  screen that has changed, and each attached image is paid for every round.
- **OpenAI-style tool messages are text-only**, so images follow them as one
  extra user message. Anthropic puts them inside `tool_result`; Gemini appends
  `inlineData` parts next to the `functionResponse` parts.
- **Refusal fallback.** A 400/422 that `is_image_refusal` recognises marks the
  endpoint text-only for the session and retries the same turn without
  images. Order in `send_turn`: after the stream refusal, before chat-shape and
  reasoning negotiation.
- **A screenshot taints like text.** `desktop_screenshot` sets the same
  untrusted-content flag as `desktop_ui_tree`: a vision model reads what the
  other app shows.

Related: [[orchestrator-emulator-tools]], [[agent-browser-install]], [[computer-use-grants]].
