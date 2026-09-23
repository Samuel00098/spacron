# Live model list refresh

Never cache a failed model fetch as an empty list: the picker falls back to
the curated catalogue on empty, and a cached `[]` blocks every later retry,
so new models (e.g. a new Grok) never appear. `ChatModePanel` keeps failures
in a timestamp ref with a 60s gate instead, and Settings keeps the error
string beside the provider card. Live lists are authoritative; curated lists
in `stores/settings.ts` are fallback only — update them when users report a
missing model, but fix the fetch path first.

Local CLI agent pickers (`AgentLaunchConfigFields`) are stricter: the adapters
in `chat-provider-adapters.ts` pre-list **no** models (only `default`), by
user request. No live list = picker greyed out on "CLI default". Locally the
probe is Rust-only (`agent_list_models`, windowless) — do not add an embedded
terminal fallback back; it surfaced as a terminal popping up in the app. Only
remote workspaces use the hidden-session terminal probe.
