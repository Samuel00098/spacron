# Model capabilities: learned, saved, refreshed in the background (2026-09-24)

What each chat model supports (vision, reasoning, tools) comes from the
providers' own model lists, not from code per provider.

- **Learning** happens in one place: `remember_metadata` (agent_turn.rs) runs
  for every model list Spacron fetches and reads the field names in use today
  (`capabilities.rs`, `vision::catalogue_accepts_images`). A new provider that
  publishes any of them needs no code. One that publishes nothing is answered
  from other catalogues' entries for the same bare model name, then name rules.
- **Saved** to `%APPDATA%/spacron/model-capabilities.json` and loaded by
  `metadata()` at first use, so icons are right before any list is fetched.
  `save` is a no-op in test builds: unit tests feed fake lists through
  `remember_metadata`.
- **Refreshed** by `capabilities::start` (15 s after launch, each configured
  provider at most daily) and `refresh_soon` from `provider_api_key_set`. The
  ChatGPT plan saves no key, so `ChatGptSignIn` calls
  `refreshModelCapabilities('chatgpt')` on sign-in. Local providers are skipped
  (their URL lives in the frontend); they are learned when their list opens.
  Each refresh emits `model-capabilities-updated`; `services/model-capabilities.ts`
  drops that provider's cache and bumps `modelCapabilitiesVersion`.
- **Reasoning icon vs reasoning menu** are deliberately different: the icon may
  use another catalogue's word for the same model; the menu only offers levels
  from built-in rules or the provider's OWN list (`reasoningEffort`), because
  whether the parameter works depends on the provider.

Audit (free): `cargo test --lib live_background_refresh -- --ignored --nocapture`.

Related: [[orchestrator-vision]].
