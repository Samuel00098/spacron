# Structured chat: attachments and inline visuals

Two things a structured chat (no PTY) has to arrange itself, because the
terminal launcher used to do them.

**Attachments cross the boundary as paths.** The composer keeps an
`attachment.path` (a picked file, or the scratch copy `save_pasted_image`
wrote) and every provider's `send(sessionId, text, images)` gets those paths —
not bytes. Each adapter then reads the file the way its wire format needs:
Codex sends `localImage` with the path; Claude and the ACP agents call
`chat_image_preview` (image-only, 15 MB cap) to get a data URL and inline the
base64 (`image` content block for ACP, `{type:'image', source:{…}}` for
Claude). Do not "fix" one of these to send data URLs from the view: Codex
would then have a data URL where it needs a path. The one parser both
inline paths share is `structured-chat/attachments.ts`.

A provider item's `images` still holds data URLs, so the transcript thumbnail
and the bytes the model saw are the same image; the journal drops them
(`journalItem`) and keeps a count in the text instead.

**Visuals need a folder, not a PTY.** `structured-chat/visuals.ts` asks
`chat_visuals_prepare` for a spot per pane and passes
`SPACRON_CHAT_VISUALS_DIR` to the agent's own process at launch (ACP, Codex,
Claude, Pi). It writes the spot into the terminal store's
`setSessionVisuals` map, which is also where a CLI pane switched into chat
finds the folder it already had — so don't create a second map. A reply's
`::spacron-visual{…}` then renders with `ChatVisual`; without a spot it says
the visual cannot be shown rather than rendering a broken frame.
