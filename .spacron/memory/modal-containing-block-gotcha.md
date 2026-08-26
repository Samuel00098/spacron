# A modal mounted from the title bar must portal to <body>

`RemoteSetupWizard` mounts inside `RemoteStatus`, which lives in the title bar
(`TitleBar.tsx`). `.titlebar` has `backdrop-filter: blur(18px)…`
(`TitleBar.css`) — and a non-`none` `backdrop-filter` (like `transform`,
`filter`, `will-change`) makes that element the **containing block for
`position: fixed` descendants**. The wizard's old
`.rsw-overlay { position: fixed; inset: 0 }` therefore resolved against the
38px-tall title bar instead of the viewport, pinning the card to the top of
the window ("modal shows above the application").

**Rule:** anything overlay-shaped rendered from `RemoteStatus` / `TitleBar`
must go through `createPortal(…, document.body)` — same pattern as
`SettingsModal`. Portaled since 2026-08-22, with `z-index: 9000` (parity with
`.settings-overlay`; the title bar intentionally stays above at 100000 so the
window controls remain clickable).

Related second symptom: the wizard's native `<select>` popup opened far from
the control. `AppShell.css` sets `zoom: var(--zoom-factor)` on the app root,
and WebView2 misplaces native select popups under CSS zoom. Fix: use the
shared `Dropdown` (`$lib/components/shared/Dropdown.tsx`), whose menu portals
to `<body>` and places itself from `getBoundingClientRect()` right below the
trigger — see [[dropdown-menu-sizing]]. Its Escape handler stops propagation,
so an open menu doesn't close the host dialog. Focus restore on close still
belongs to the trigger side — [[modal-focus-restore-gotcha]].
