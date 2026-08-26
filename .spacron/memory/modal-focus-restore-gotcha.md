# A dialog that autofocuses cannot restore focus from inside itself

`RemoteSetupWizard` (and any modal with `autoFocus` on a field) cannot capture
"who had focus before I opened" from an effect: React applies `autoFocus`
during the commit, **before** any `useEffect`/`useLayoutEffect` runs, so by the
time an effect captures `document.activeElement` the field already has it.
Restoring that on close refocuses a detached node — a silent no-op that strands
focus on a container/`<body>`.

Restore from the **trigger side** instead: `RemoteStatus` keeps
`vpsTriggerRef` on the "Set up a new VPS…" button and its `onClose` passed to
the wizard does `setSetupOpen(false); vpsTriggerRef.current?.focus();`. All
close paths (Escape, overlay click, Cancel) route through that one `onClose`.

Gotcha while verifying in a plain browser: React Fast Refresh can keep a stale
`onClose` closure alive across HMR updates — the restore looks broken until a
full reload. Reload before concluding focus code is wrong.

The wizard also has a Tab wrap-around trap in its overlay `onKeyDown` (the
`aria-modal` promise), `role="alert"` on its error box and `aria-live="polite"`
on the deploy stage line.
