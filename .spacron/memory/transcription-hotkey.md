# Transcription hotkey (`Ctrl+Shift+M`, formerly `F9`)

Speech-to-text only — WhisperFlow-style. Nothing is ever spoken back;
conversation is a separate path (see [[voice-is-realtime-only]]).

    Ctrl+Shift+M     start dictating (Cmd+Shift+M on macOS)
    ...speak, pause, keep speaking — pauses do NOT end it...
    hotkey / Escape  end, then paste everything at once
    Ctrl/Cmd+Escape  discard without pasting

## Pauses must not end the dictation

The VAD finalizes an utterance after ~800 ms of silence — far shorter than an
ordinary thinking pause. The original design delivered on the first `onResult`,
so any sentence you paused inside got chopped and pasted early. Utterances are
now banked in `accumulated` and the mic re-armed (`setConversationMode(true)`,
so re-arming skips getUserMedia — that latency is what would otherwise eat the
first word after each pause). Only `finalizeListening` ends a dictation.

Two ordering traps, both now covered by tests:

- `deliver()` calls `teardownMic()`, whose `stop()` fires `onEnd` **again**.
  Delivery used to be guarded by `phase === 'listening'`; that guard died when
  finalize moved the phase to `processing` instantly (see the exit-lag section
  below), so the real guard now is `deliveryStarted` inside `beginDelivery()` —
  exactly-one-delivery per dictation, however many times `onEnd` fires.
- `abortTranscription()` must `resetToIdle()` **before** `teardownMic()`. Stop
  fires `onEnd`, and without the reset-first order a stale end event could
  still deliver or resurrect what the user just cancelled.

## The two end-of-turn signals, and cumulative vs utterances mode

Both of these now have their full explanation as doc comments at the definition
site in `voice-input.ts` — on `onTurnComplete` in `VoiceInputCallbacks`, and on
`VoiceInputSessionOptions`. **Read them there, not here.** They used to be
written out in this note as well, and a second copy of a rule is the copy that
goes stale.

What this note adds, because it is about the *hotkey* rather than the session:

- The hotkey reads any `onEnd` while listening as "the mic died", which is why
  the split matters to it more than to other consumers. If you add a consumer:
  commit-per-turn ⇒ `onTurnComplete`; session-over ⇒ `onEnd`. Never re-merge.
- Webspeech engines also auto-end continuous recognition after long silences —
  an `onEnd` nobody asked for. The hotkey answers it with `scheduleRearm()`,
  bounded by `MAX_REARM_FAILURES` and reset on every `onStart`; past the cap it
  delivers whatever was banked rather than looping or binning it.
- Dictation banking accumulates what it receives, so it MUST pass
  `'utterances'`. Cumulative payloads into an accumulating consumer is the
  "says everything twice" bug.

## Ending feels instant (the exit-lag fix)

Three causes of "Escape needed two or three presses", all fixed:

1. During mic startup (`starting`, phase still `idle`) Escape was swallowed by
   `finalizeListening`'s phase guard. Plain Escape now cancels while starting.
2. After the first Escape the phase stayed `listening` through the whole STT
   drain, so the pill kept saying "Listening" and further presses did nothing.
   `finalizeListening` now sets `processing` SYNCHRONOUSLY — the pill flips the
   moment you end; drain/polish/delivery continue in the background (option B
   from the user: instant dismiss, paste lands when ready).
3. Bug-B pauses above made the dictation end itself, so later Escapes hit idle.

Processing label is "Transcribing…" (`TranscriptionIndicator.tsx`) because the
drain covers STT + optional polish, not just sending.

## Quality pass: fillers + polish

- `refineVoiceTranscript` strips hesitation fillers BY DEFAULT
  (`removeFillers`, word-bounded `um/uh/umm/uhh/uhm/erm/ahh?` + trailing
  punctuation). Mechanical, safe for terminal payloads too. Opt out verbatim.
- Text-field targets additionally get AI polish via `refineVoicePrompt(…
  { allowForModelProviders: true })` when `voiceRefinementEnabled` is set —
  WhisperFlow-style cleanup for prose. TERMINALS never get polish (must never
  reword shell commands); `allowForModelProviders` bypasses the old
  model-provider gate for the dictation path only.
- **Custom vocabulary** (`dictationVocabulary` setting, comma-separated):
  injected into the polish system prompt via a `vocabulary` arg on
  `ai_refine_prompt` (Rust appends `CUSTOM_VOCABULARY_RULE` +
  the list to `OPENROUTER_SYSTEM_PROMPT`; capped at 4k chars). This is the
  hotword trick that fixes the names speech models mangle. Declared in
  `stores/settings.ts` + all three zustand spots (see
  [[per-project-persistence]]-style boot-read trap); UI row lives in
  SettingsModal's "Voice refinement" section. Empty list ⇒ no instruction sent.
- **STT-layer biasing** (the Wispr "Variable Recognition" slot): the same list
  ALSO rides into the transcription request itself — `local_stt_transcribe`
  takes `initialPrompt` → `whisper_rs`'s `set_initial_prompt` (600-char cap;
  Parakeet has no conditioning and ignores it), `ai_transcribe_audio` takes
  `vocabulary` (Google: appended to the transcription prompt text; OpenAI:
  `prompt` form field, 600-char cap; OpenRouter/local-server: no standard slot,
  skipped). So terms resolve BEFORE polish, terminals included.
- **Editor-symbol context** (`services/editor-symbols.ts`): identifiers from
  the ACTIVE editor tab (`activeFile` + `fileCache` in `stores/editor.ts`) are
  extracted — declarations first, then code-shaped tokens (camel/snake/Pascal),
  keywords/prose filtered, capped at 80 / 200 KB scan — and MERGED into the STT
  bias after the user's list in `voice-input.ts`. STT-only on purpose: never
  feed auto-extracted code names to the prose rewriter. Node tests mock
  `$lib/stores/editor` at the seam (its import chain drags zustand+backend);
  there is no `typeof window` guard — transcription only runs in the webview.
- **Smart VAD** (`smartVadEnabled` setting, default OFF; `commands/vad.rs`):
  Silero v5 ONNX (~2 MB, downloaded via the normal model catalog) runs natively
  through the same ORT dylib as Parakeet. Toggle lives in **Settings → Voice →
  "Voice input" section**; the model itself downloads under Settings → Models →
  Local Speech-to-Text. The renderer keeps its capture graph
  and RMS pipeline; when enabled it batches ~4 processor frames (~340 ms) of
  Int16 PCM to `vad_session_feed`, which returns max speech probability over
  completed 512-sample windows (state tensors persist per session in Rust).
  Probability OWNS the turn decision (onset ≥0.55, release ≥0.35) while live;
  ANY backend failure silently reverts to the RMS gate. Session lifecycle is
  tied to `clearCaptureState`. If Silero misbehaves on real audio, delete the
  model or flip the toggle — the gate is untouched underneath.
- **Rewrite-pass rules 9–10** in `OPENROUTER_SYSTEM_PROMPT`: self-correction
  collapse ("5pm actually 6pm" ⇒ keep 6pm) and ramble-shaping into lists —
  the two behaviours research pinned as Wispr Flow's actual differentiator
  (their moat is the LLM rewrite pass + dictionary/context plumbing, NOT a
  secret ASR engine; Typeless likewise, cloud-only with an undisclosed model).

## Why `Ctrl+Shift+M`, and why it needs a capture-phase listener

`Ctrl+Alt+M` was the original default and did not work reliably: on Windows Ctrl+Alt
IS AltGr, and the chord also reaches xterm, which forwards anything it doesn't
claim to the shell. `F9` replaced it briefly, but on Windows laptops `F9` / `Fn+F9`
often triggers OEM hardware or Windows Search shortcuts before the app sees it, and
on macOS `F9` is a media key. `Ctrl+Shift+M` (`M` = Microphone, with the retired
`launchVoiceMode` cleared) has zero OS/AltGr/Fn/WebView2 conflicts and works with the
capture-phase listener. `forge_migration_shortcutsAudit_v1` in `zustand/settings.ts`
moves legacy `F9` and `Ctrl+Alt+M` installs onto `Ctrl+Shift+M` once.

The dispatch lives in its OWN capture-phase `keydown` listener in `AppShell`
(`handleTranscriptionKeyDown`), not the shared bubble-phase handler: xterm sees
keys first and would otherwise both swallow the key and type it into the shell.
It is the only action handled that way — everything else keeps the bubble path
so panes can claim their own keys. Don't re-add a `transcribeToTerminal` case to
the bubble switch; that would double-toggle.

- **Service**: `src/lib/services/transcription-hotkey.ts` — single-shot
  semantics: hotkey → listen → first finalized utterance wins → deliver → idle.
  `phase` (module-local, mirrored to the exported `transcriptionState` store)
  is authoritative; `starting` gates re-entry during async mic startup.
- **Scope is in-app** (confirmed with the user 2026-08-25): it reaches every
  part of Spacron including terminals, but there is no Tauri global shortcut and
  no OS-level text injection, so it cannot type into VS Code or Chrome. Making
  it system-wide means the global-shortcut plugin plus an injection backend.

## Target resolution — the part that bites

The target is snapshotted at capture start (`startListening`) into `targetField`
/ `targetSessionId`, and then **follows the user**: clicking or tabbing into
another text box while — or just after — speaking retargets the dictation there
(added 2026-08-25 at the user's request; "the box I click on last is the box it
goes in", even when the sentence began over a terminal).

What must not retarget is focus the user did not direct. `retargetDuringCapture`
takes **two** votes and needs both:

1. the landing is itself a text surface (input / textarea / contenteditable) or
   an `.xterm` — so the bar's mic button, a toast and a plain re-render are
   simply not candidates; and
2. `wasUserDirected(el)` — the user's own pointerdown landed on that surface, or
   they pressed Tab. A click on a button that *opens a dialog which autofocuses
   its own field* lands on the button, not the field, so it does not count.
   Terminals need the `.xterm`-root comparison there: focus goes to a hidden
   helper textarea that is a **sibling** of the screen you clicked, so plain
   `contains()` never holds inside one.

A retarget clears `targetSessionId`, which makes `deliver()` resolve the session
again at delivery (`targetSessionId ?? resolveTargetSession()`). That is
deliberate: the pane activation that follows a click into a terminal can land
*after* the focus event, so an id read at click time is one pane behind.

`deliver()` still must never blind-read `lastEditableEl` — that was the original
bug. Two of them lived here, both still pinned by tests in
`transcription-hotkey.dom.test.ts`:

1. `deliver()` read the module-global `lastEditableEl` instead of the target, so
   a transcript meant for a terminal landed in whatever field had focus at the
   end — *any* field, including one nobody had touched during the dictation.
2. `lastEditableEl` was only ever **set, never cleared**. Any text field touched
   earlier in the session (search box, rename dialog, settings) kept swallowing
   every later terminal transcription. The `focusin` tracker now clears it when
   focus lands inside an `.xterm`, and `liveEditable()` drops it once the
   element is no longer `isConnected`.

## It collided with voice mode (fixed 2026-08-25)

`Ctrl+Alt+M` "sometimes opened voice mode instead". The floating bar toggles a
voice call on a **tap of left Alt**, and it used to fire on the Alt **keydown**
— so the chord opened a call the moment Alt went down, before `M` was ever
delivered. "Sometimes" because the gesture is armed by having clicked the bar
(`voiceShortcutArmedRef`).

The rule now lives in `services/alt-tap-gesture.ts` (pure, unit-tested):
completion is on **keyup**, and the tap is cancelled both by Alt arriving with
a modifier already held *and* by any key pressed while Alt is down — you need
both, because holding Alt first and adding Ctrl after still produces a bare-Alt
keydown. If you add another Alt chord, feed it through that gesture rather than
re-reading `event.key === 'Alt'` in a handler.

## There are TWO terminal worlds — pick the right one

`sessions`/`activeSessionId` (agent room) and `devSessions`/`devActiveSessionId`
(dev-terminal room) are independent, and **each keeps its active session id
indefinitely**. `resolveTargetSession` used to be
`activeSessionId ?? devActiveSessionId`, which always preferred the agent room
whenever it held anything: dictating into the dev terminal delivered to an
off-screen session, reported success, and looked like "transcription does
nothing" — no error toast, because nothing failed.

It now breaks the tie on `lastActivatedAt` (stamped by `activateSessionInPane`).
Any other feature that needs "the terminal the user is in" should do the same;
`??` between the two stores is always wrong.

## It must NOT stand down for modals

`handleTranscriptionKeyDown` deliberately skips the `isModalOpen()` guard that
every other app shortcut honours. Dictation is an input method, not navigation,
and the modals ARE the text-entry surfaces — Quick Capture, Task Editor, Clone
Repo, New Folder, Workspace Name, Agent Spawn, Settings all register in
`modalOpenCount`. Gating on it made the key dead in exactly the places you most
want to dictate into, which is why it looked like "transcription only ever goes
to the terminal". Don't re-add that guard.

## Delivery seams (do not add new ones)

- Focused text field → `insertIntoEditable` at the caret (`setRangeText` +
  a dispatched `input` event for inputs/textareas; `execCommand('insertText')`
  for contenteditable). Newlines preserved.
- Terminal → `sendAgentPromptDirect` (bracketed paste + echo-confirm + Enter
  retry for TUI agent CLIs, plain text + `\r` for shells) when auto-send is on,
  else a silent xterm paste via `requestTerminalInput`. Target =
  `activeSessionId ?? devActiveSessionId`.

Transcript cleanup into TERMINALS is mechanical only (`refineVoiceTranscript`,
spoken punctuation + newline flattening). No AI refinement on purpose — it must
never reword shell commands.

## Testing note

The repo has **no jsdom/happy-dom**; vitest runs `environment: 'node'`, where
`typeof document === 'undefined'` short-circuits every text-field path. So
`transcription-hotkey.test.ts` can only reach terminal delivery, and the
targeting tests live in `transcription-hotkey.dom.test.ts` behind a hand-rolled
DOM stub installed on `globalThis` *before* the service import (the focus
tracker binds `document` on first use). Extend that stub rather than adding a
DOM dependency — it now carries a real `parent` chain (so `closest`/`contains`
walk a tree), a `pointerdown` listener list, and `click()` / `makeTerminal()`
helpers, which the retargeting tests need.

Other wiring: shortcut id `transcribeToTerminal` in BOTH `stores/settings.ts`
and the mirrored list in `stores/zustand/settings.ts` (two spots there: merge fn
+ defaults object). Indicator pill:
`components/terminal/TranscriptionIndicator.tsx`, mounted at AppShell root.
Settings toggle `transcriptionAutoSend` binds directly with `.set`, is **off by
default** (2026-08-25) and is declared in `zustand/settings.ts` in all three
places — state, `defaults`, `updateSetting` map. It used to be wrapper-only, so
`persistentWritable`'s boot read hit undefined and the toggle silently reset to
ON at every restart; a guarded `forge_migration_transcriptionAutoSendOff_v1`
clears the stale stored `true` once, so declaring it doesn't resurrect a value
that was never honoured. Pinned by `stores/zustand/settings.test.ts`.

Related: [[shortcut-key-matching]], [[modal-open-count-gate]],
[[voice-is-realtime-only]]
