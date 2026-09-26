# global.css rules that silently win over component CSS

Three app-wide rules in `src/styles/global.css` beat what a component's own
stylesheet says. Each has cost a "I changed it and nothing happened" round.

- **Text size and weight.** One rule sets `font-size: inherit !important` and
  `font-weight: var(--ui-font-weight) !important` on every UI element, and a
  second pins headings/bold to 500. A component that needs its own size (the
  Settings title, the sidebar wordmark) must be added to the `:not(...)`
  exclusions of both rules. Setting it in the component's CSS does nothing.
- **Borders.** The "clear every drawn outline" block sets
  `border-color: transparent !important` on inputs, buttons, and anything whose
  class contains `-card`, `-panel`, `-modal`, `-tile`, `-pill`, `-chip`,
  `-badge`, `-popover` or `-menu`. A visible outline there has to be a ring:
  `box-shadow: var(--surface-outline) !important`. A border won't show.
- **Shadows.** The same file puts bevel/lift/well shadows on buttons, wells and
  listed surfaces with `!important` inside `:where()` (zero specificity), so any
  class-level `box-shadow: ... !important` overrides them.

The flat look the user wants (no black fills, no 3D, menus in the Settings
dropdown colour) is carried by the `--surface-*` tokens at the top of
global.css, plus the "one menu colour" rule near the end.

Separate trap, same symptom: `overscroll-behavior: contain` still lets a list
rubber-band in WebView2. Use `none`.
