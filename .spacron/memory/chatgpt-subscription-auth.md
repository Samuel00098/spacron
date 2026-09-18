# ChatGPT subscription sign-in

Spacron never touches Codex tokens: sign-in spawns the CLI's own `codex login`
(browser flow) or `codex login --device-auth` (one-time user code, headless
path) and only relays the approval URL / code. The CLI owns
`~/.codex/auth.json`, refresh, and the usage meter. Backend:
`commands/chatgpt_auth.rs`; UI: `ChatGptSignIn.tsx` in Settings → AI
Connections → ChatGPT subscription.

Traps: status parsing must test negative markers first — "Not logged in."
contains the substring "logged in". Device-code flow needs enabling in the
user's ChatGPT security settings first. Browser flow needs localhost:1455
free. Model list still comes from the `codex app-server` probe, so it only
works while signed in — surface its error, don't swallow it.
