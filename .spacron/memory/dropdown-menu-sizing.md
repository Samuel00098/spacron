# Dropdown menus size to their content, not to the trigger

`src/lib/components/shared/Dropdown.tsx` portals its menu to `<body>` with
`position: fixed`, so placement is computed in JS (`updatePlacement`), not CSS.

**The trap it used to have:** placement set `width: r.width` — the *trigger's*
width. Any picker with a narrow trigger and descriptive options clipped every
label. The live case was the mobile panel's stream-resolution picker: a 116px
"864p" trigger (`.mobile-panel .mobile-quality .dropdown { max-width: 116px }`
in `MobilePanel.css`) against options reading "1440p · Sharpest · slowest". The
menu inherited 116px and the option text was cut mid-word.

**How it works now (2026-08-22):**

- Placement sets `minWidth: r.width` + `width: 'max-content'`, so the trigger
  width is a *floor*. A menu can never come out narrower than it used to be —
  wide triggers with short options are unchanged.
- `maxWidth` is `MENU_MAX_WIDTH` (420) bounded by the window, so one long option
  ellipsizes instead of the menu spanning the screen.
- A `useLayoutEffect` runs a **second placement pass** after render, because a
  content-sized menu's real width is only knowable once it exists. It clamps
  `left` back inside the window — a menu near the right edge right-aligns with
  its trigger and grows inward. It converges: the guard returns the previous
  style object when the recomputed `left` is unchanged, so it does not loop.

**Also:** `.dd-item-sub` was `flex-shrink: 0` while `.dd-item-label` was
`flex: 1; min-width: 0`. In a too-narrow menu that squeezed the *label* — the
value being chosen — to an ellipsis while the descriptive sublabel survived
intact, exactly backwards. Both ellipsize now.

If you add a picker with a deliberately narrow trigger, you no longer need to
widen it just so the menu is readable.

