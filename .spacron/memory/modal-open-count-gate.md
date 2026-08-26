# `modalOpenCount` gates every global shortcut — an always-mounted host pins it

`useModalFocus` (`src/lib/react/useModalFocus.ts`) increments a module-level
`modalOpenCount` on mount and decrements on unmount. Both app-wide keydown
listeners — `App.tsx` (zoom) and `AppShell.tsx` (the whole shortcut switch) —
start with `if (isModalOpen()) return;`. So **one leaked increment silently
kills every keyboard shortcut in the app**, with no error and nothing in the
console.

That is exactly what happened: `AgentPlacementModal` is rendered
unconditionally from `App.tsx` and returns `null` until a placement request
arrives, but hooks can't be conditional, so its `useModalFocus` bumped the
count once at startup and never released it. Every shortcut was dead from boot.

The rule: `useModalFocus` may only be called from a component whose **mount
lifetime equals its open lifetime**. Almost every modal here satisfies that
(`{isSettingsOpen && <SettingsModal/>}`). A host that stays mounted must pass
the third argument: `useModalFocus(ref, onEscape, Boolean(isOpen))`.

Two related traps in the same area:

- The hook's effect focuses the first focusable inside the container. It is
  declared before `AgentPlacementModal`'s own reseed effect, so the card's
  `cardRef.focus()` still wins — keep that declaration order.
- Symptom-wise, a pinned count looks identical to "shortcut matching is
  broken". Check `modalOpenCount.value` before digging into `matchShortcut`.

See [[modal-focus-restore-gotcha]] and [[shortcut-key-matching]].
