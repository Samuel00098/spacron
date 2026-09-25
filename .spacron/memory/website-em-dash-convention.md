# No em dashes in visible website copy

The marketing site (`website/app`) uses no em dashes in user-visible copy:

- **`·` for every decorative separator** that ties two short labels together:
  button CTAs (`Buy Spacron · $49`), the OS list (`Windows · macOS · Linux`),
  changelog dates (`v1.3.0 · Jan 12, 2026`), the pricing sub
  (`Perpetual license, per user · Windows, macOS, Linux`), and the terminal
  mock rows (`orchestrator: planning · 3 sub-tasks...`).
- **`:` / `,` / `.` for grammatical breaks** in prose that previously used an em
  dash (e.g. the hero lead, section leads, chat-mock lines, the metadata
  description in `layout.tsx`). The user prefers no em dashes at all in the
  visible marketing copy, so rephrase with those instead of reintroducing `—`.

Em dashes are fine in code comments and non-visible strings; the changelog
page's `—` come from the root `CHANGELOG.md`, which is deliberately left
untouched.

Also search for HTML entities, not just the literal char: `&#8212;` / `&mdash;`
(em dash) and `&#8211;` / `&ndash;` (en dash) render as dashes in the browser
but never match an `rg "—"`. `rg -n "&#8212;|&mdash;|&ndash;|&#8211;"` catches
them.

Worth knowing when editing:

- The two `Buy Spacron · $49` CTAs (hero + final) are byte-identical strings —
  editing either one needs `replaceAll: true` or surrounding-context
  disambiguation, otherwise the edit tool reports a multiple-match failure.
- Em dashes written in shell/bash arguments on Windows get mangled (become a
  replacement char), which makes `oldString` lookups fail even though the file
  is fine. Verify fixtures against the file with the read/edit tools (which
  render the dash correctly) rather than re-typing it into a shell command.
- `rg -n "—"` on the file prints the real dash correctly; only *typed* command
  arguments are at risk of mangling.

Related: [[website-motion-layer]] (the reveal-layer convention), [[pricing-license-model]] (the `$49` / license wording).