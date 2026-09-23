# Quick Capture removed

The Quick Capture modal (`QuickCaptureModal.tsx/.css`) was deleted with its whole
plumbing: the `quickCaptureOpen` writable + mirror line + `openQuickCapture` /
`closeQuickCapture` wrappers in `src/lib/stores/layout.ts`, the `quickCaptureOpen`
state and actions in `src/lib/stores/zustand/layout.ts`, the TitleBar button,
the `case 'quickCapture'` in AppShell's shortcut switch, the App.tsx mount, and
the `Ctrl+Shift+Space` entry in `defaultShortcuts` / the shortcut catalog
(`settings.ts` and `zustand/settings.ts`).

It wrote captured thoughts to the active project's `.spacron/inbox.md` via
`fs_create_dir` / `fs_read_file` / `fs_write_file`.

## Notes

- Users who already customized shortcuts may still carry a `quickCapture` row in
  their persisted `spacron_userShortcuts` — it is inert now (the AppShell switch
  no longer handles the id). Left alone, like the onboarding key.
- The `.app-shell ::view-transition-*(spacron-quick-capture-card)` selectors in
  `AppShell.css` were dead already (no transition name was ever used) and were
  removed with the rest.
- `formatShortcutLabel` stays — TitleBar still uses it for mode/project hints.