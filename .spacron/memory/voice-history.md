# Voice history (Settings → Voice → History)

Two durable logs of what was said, added 2026-08-26. Store:
`src/lib/stores/voiceHistory.ts`. UI:
`src/lib/components/shared/VoiceHistoryPanel.tsx` (+ its CSS), mounted from the
**Voice tab** of `SettingsModal` behind a `Settings | History` pill switch
(`.settings-subnav`) — deliberately NOT a tenth entry in the left rail.

    transcriptionHistory   every dictation      (one entry per delivery)
    conversationHistory    every realtime call  (one entry, holding its turns)

They never merge: "what did I dictate into that file?" and "what did I ask the
agent to do?" are different questions, and one list with a `kind` field would
only be filtered apart again by every consumer. See [[transcription-hotkey]] and
[[voice-is-realtime-only]] for the two paths that feed them.

## Retention lives in the store, not in `stores/settings.ts`

`voiceHistoryRetention` is its own persisted writable
(`spacron_voice_history_retention`), same pattern as `previewHistory.ts`. It is
NOT declared in `stores/settings.ts` + the three zustand spots, on purpose:
`transcription-hotkey.ts` imports this module, and its tests mock
`$lib/stores/settings` down to the two exports that service reads — pulling
retention from there would make the store explode at import time under those
mocks. Values: `off | 1d | 7d | 30d | 90d | 365d | forever` (default forever).
`off` records nothing AND clears what is stored. On top of the age window there
are hard caps (1000 dictations / 200 calls / 400 turns / 8k chars per field),
because "forever" is a promise about time, not about localStorage quota.

## The subscribe-order trap (cost an hour)

A store's subscriber fires **once synchronously on subscribe**. The retention
subscription calls `pruneVoiceHistory()`, which touches `transcriptionHistory` —
so subscribing next to `voiceHistoryRetention` (above the two logs) reached a
`const` in its TDZ and threw on import, **in the browser only**: under Node the
`typeof window === 'undefined'` guard returned before the prune and hid it, so
every test passed. The subscription now sits BELOW both logs, and that first
synchronous call is also what folds away whatever aged out while the app was
closed — there is no separate load-time prune. If you add another cross-store
subscriber here, put it at the bottom of the file.

## Where entries come from

- `transcription-hotkey.ts` → `logToHistory()` inside `deliver()`, called
  **before** delivery is attempted. A transcript that could not be inserted (the
  field went away, the session died) is exactly the one you want to find and
  copy by hand. The whole call is wrapped in try/catch: history must never cost
  a delivery. `captureStartedAt` is stamped on the FIRST `onStart` only (the mic
  re-arms after every pause and each re-arm calls it again).
- `TasksPanel.tsx` → per-turn task dictation, `target: 'task'`.
- `FloatingPromptBar.tsx` → `startConversationRecord` before the realtime call
  connects (so the transcript callbacks always have somewhere to land), turns
  appended alongside `appendVoiceExchangeMessage`, `endConversationRecord` on
  every teardown path (stop, transport `onEnded`, connect failure, re-entry).
  A record that ends with zero turns is **dropped**, so a failed handshake
  leaves no empty row; `endConversationRecord` keeps the first end time, since
  the teardown and the transport's `onEnded` both land.

Conversation history is separate from the project chat on purpose: the chat card
is a live view that gets compacted and summarized away (`compactProjectChat`),
this is the durable record.

## Time ranges

`resolveRange(preset, now, custom)` → `{from, to}`, inclusive-from /
**exclusive-to**. A custom end date means the whole of that day, so its bound is
the start of the next one. `parseDateInput` parses `<input type="date">` as
LOCAL midnight — `new Date('2026-08-26')` is UTC and silently shifts the
boundary by the timezone offset, adding or dropping a day of entries.
A conversation is filtered (and aged) by when it **ended**, not started.

Everything above the render is pure and unit-tested in
`stores/voiceHistory.test.ts` (27 tests): retention windows, pruning, the
conversation lifecycle, range maths, filtering, day grouping.
