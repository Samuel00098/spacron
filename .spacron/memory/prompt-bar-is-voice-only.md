# The floating prompt bar is voice-only

Since 2026-08-24 the bar has **no text input**. Typing into it — and with it the
whole "pick a terminal and send it a prompt" path — was removed at the user's
request; voice is the only way to compose.

## What went

The bar used to have two modes behind `isAgentMode`. The textarea and the Send
button rendered **only** in the `!isAgentMode` branch, so removing typing and
removing terminal-target mode were the same cut. Gone with it:

- the `.prompt-input` textarea, `.send-btn`, and the agent/terminal mode toggle
- the target picker (`manualPromptTargetId` pin, `promptTarget`, `isPinned`,
  `resolvePromptTarget`, `runningSessions`)
- prompt history (the `.history-panel`, `stepHistory`, `addHistoryEntry`'s only
  caller — `commandHistory` is now written by nobody)
- `@`-mention file attach, and `MentionDropdown.tsx` with it (deleted; its CSS
  lived in `FloatingPromptBar.css`)
- clipboard image paste (it had no target once the textarea went)
- `submitPrompt`'s terminal-delivery branch: `sendPromptToSession`,
  `activateSessionInPane`, `startCommandBlock`, `addRunEntry`, task summaries

`Ctrl+Alt+M` (speak-into-terminal) is untouched — it is its own service and
never went through the bar. See [[transcription-hotkey]].

## The staged prompt — the one thing that replaced a text box

Other parts of the app hand text to the bar by writing `promptBarInput`:
`PreviewPanel`'s "add element to prompt" (plus a screenshot via
`promptBarImage`) and `orchestrator.ts`'s goal handoff for an agent spawned
without auto-run. There is no box for that text to land in any more, so it
becomes the **staged prompt**: `inputValue` is still the state, but it is now
read-only and rendered as `.staged-prompt` in the agent strip, with Send and
Discard.

Two things depend on it staying a plain string:

- `mergeVoiceTranscript(draftBase, transcript)` in the voice `onEnd` pipeline
  folds what you say onto what is staged, so a handed-over goal is sent
  *together with* the spoken turn rather than replaced by it.
- `submitAgentMessage()` with no argument falls back to `inputValueRef.current`
  and folds in the attachment chips — which is why Send needs no special path.

Gotcha: the strip keys off `hasStagedContent` (text **or** attachments), not
text. Preview can send a screenshot with no text, and keying off text alone left
that chip with no way to send it.

Related: (the trailing controls the bar still renders).
