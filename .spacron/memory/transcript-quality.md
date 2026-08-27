# Transcript quality: the two-stage cleanup

Dictated text is cleaned twice, and the split is the whole design.

    services/technical-transcript.ts   deterministic, ALWAYS runs, terminals included
    ai_refine_prompt (secrets.rs)      LLM rewrite, text fields only, opt-in

Wispr Flow and Typeless do nearly all of this in an LLM pass. We do the
unambiguous half deterministically because the rewrite is slow, costs a
request, is often unconfigured, and must never touch a shell command — so a
terminal payload would otherwise get no technical cleanup at all.

## The pass order in `refineVoiceTranscript` is load-bearing

Technical pass → spoken punctuation → fillers → whitespace → capitalization.

The spoken-punctuation table rewrites the WORDS "dot" and "dash" into `.` and
`-`. Once that has run, "app dot ts" is `app . ts` and "dash dash force" is
`- - force`, and nothing downstream can tell either from real punctuation. Any
new rule that keys off a spoken symbol name has to go in the technical pass,
before that table. Do not reorder these.

## Conservatism is the design, not an unfinished state

Every rule fires only on a form that is not ordinary English. Widening them has
been tried and is wrong here:

- Bare `sequel` → SQL breaks "the sequel was better"; bare `jason` → JSON
  renames a person. Both are correction-by-context only (`sequel query`,
  `jason payload`), and the LLM pass is what handles the rest.
- `--dry run` from "dash dash dry run" also produces `--strict-and` from "run
  dash dash strict and check the tests". Nothing in the audio separates a
  second flag word from the rest of the sentence, so a long flag claims exactly
  ONE word unless the joining dash is spoken.
- Joining any run of single letters produces "ABC" from "plan A, B and C".
  A spelled acronym is collapsed only when the joined letters are in
  `DEV_ACRONYMS`.
- `\b` around an acronym fires inside `config.json` and `src/api/routes`.
  `normalizeAcronymCase` uses explicit boundary classes; a trailing full stop
  still has to count as the end of a sentence.

Anything genuinely ambiguous belongs to the rewrite pass, which has context.

## Capitalization is prose-only, permanently

`cleanTranscript(raw, allowNewLines)` in `transcription-hotkey.ts` uses
`allowNewLines` to mean "this is prose": text fields get sentence
capitalization, terminals do not. "Npm install" is a typo, not politeness.
`LOWERCASE_LOCKED` covers the names whose canonical form is lowercase.

## Two silent data-loss bugs that are now guarded — do not undo the guards

- **`max_tokens` on `ai_refine_prompt` scales with the input.** It was a flat
  512, which truncated any dictation past ~380 words: the model stopped
  mid-sentence and the tail was gone, with nothing anywhere reporting it.
- **`refinementKeptTheContent`** rejects a rewrite under half the word count.
  Models break "nothing is lost" by summarizing, and a summary reads perfectly
  well, so the user never finds out. The threshold is a compromise documented
  at the definition site — honest copy-editing of filler-heavy speech does
  approach half, so a stricter bar throws away good rewrites.

Both failures are invisible from the outside, which is why they survived.

## Whisper is tuned for accuracy, not for defaults

`commands/whisper.rs` uses beam search (greedy commits to the first plausible
token, which is exactly how library names become the nearest common word),
threads from the host, and whisper.cpp's anti-hallucination params, which
`FullParams::new` does NOT apply for you: `suppress_blank`, `suppress_nst`,
`no_speech_thold`, the entropy/logprob fallback. Silence is trimmed before
decoding and stock phrases ("Thank you.", "[BLANK_AUDIO]") are filtered after —
belt and braces, because that hallucination is the most visible failure a local
dictation setup has.

The vocabulary hint is clamped **on a term boundary**. A hard character cut
leaves a half-word that the decoder conditions on as readily as a real term, so
the cap meant to protect the context window ends up biasing toward a word that
does not exist.

Related: [[transcription-hotkey]], [[voice-history]]
