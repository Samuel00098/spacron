# Shortcut matching compares produced characters, not key caps

`matchShortcut` in `src/lib/stores/settings.ts` is the single matcher for every
binding (`defaultShortcuts` / `userShortcuts`). It compares `event.key`, which
is the character the keyboard **produced**, against the binding string a user
typed with **key caps**. Those disagree the moment Shift is involved:
`Ctrl+Shift+\`` (New Terminal Tab) arrives as `~`, so it never matched.

Both sides now go through `UNSHIFTED_PUNCTUATION`, which folds `~`→`` ` ``,
`!`→`1`, `+`→`=`, `?`→`/` and the rest back to the unshifted key cap. Any new
binding on shifted punctuation works because of that table — don't add
one-off special cases like the old `'+' | '='` branch.

`event.code` is only a **fallback**, used when `event.key` isn't plain ASCII.
That covers macOS, where Option rewrites the character (`Alt+Shift+F` → `Ï`).
It must not be the primary comparison: `code` names the US key cap, so on
AZERTY, pressing A (key `a`, code `KeyQ`) would fire a `Ctrl+Q` binding.

Other things worth knowing:

- A binding written with `Ctrl` also matches Cmd (macOS). Writing `Meta`
  explicitly is the opt-out — it then requires Meta and rejects Ctrl.
- `AppShell.tsx` dispatches every action except `zoomIn`/`zoomOut`/`resetZoom`,
  which `App.tsx` owns. AppShell still `preventDefault()`s them, so a new
  action added to `shortcutActions` with no `case` anywhere silently eats
  its key.
- Shortcut strings are free-typed in Settings (`ShortcutEditor`), not recorded
  from a keypress — nothing validates that what's typed is reachable.
  `src/lib/stores/shortcuts.test.ts` synthesizes the real keydown for every
  default and is what catches an unreachable binding.

See [[modal-open-count-gate]] — a pinned modal count looks like this being
broken.
