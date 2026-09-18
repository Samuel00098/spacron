# Image attach into terminal agents and composers

Pasting or dropping an image for a TUI agent (opencode, Claude Code, …) means
saving the bytes via `save_pasted_image` and pasting the **path** — never the
pixels. Two delivery rules:

- Paste the path through xterm (`term.paste` / `requestTerminalInput`, which the
  pane delivers via `term.paste`) so the TUI gets bracketed-paste markers, and
  with **no trailing Enter** — the user sends it. `AgentPanelImages` previously
  did `writeToSession(path + '\r')` (direct PTY write + submit), which fired the
  prompt instead of attaching. See [[html5-dnd-dead-in-tauri]] for which drop
  pipeline owns each surface.
- `ChatAttachment.previewUrl` (chat composer thumbnails) is a live `blob:` URL:
  strip it before `sendChatMessage`/persistence and revoke it on remove, submit,
  new-thread and unmount, or dead URLs get persisted and blobs leak.
