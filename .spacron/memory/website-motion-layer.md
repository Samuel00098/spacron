# Website motion layer: the html.js gate and the ScrollFX mount rule

`website/app/globals.css` hides `[data-reveal]` elements (opacity 0) **only under
`html.js`**. The `js` class is stamped by a tiny inline script in
`website/app/layout.tsx` before first paint, so entrance animations never flash
hidden content when JS is off — if you move that script below the fold or make
it async, the site will render blank for some users.

Traps:

- **Every page that uses `data-reveal` must be under a layout that mounts
  `website/app/ScrollFX.tsx`** (it is today via the root layout). Without it the
  elements never get `.is-in` and stay invisible.
- The ScrollFX stagger pass skips children that already have an inline
  `--reveal-delay`, so hand-tuned hero sequencing survives; don't "simplify"
  that check away.
- `prefers-reduced-motion` force-shows everything; keep new animated elements
  inside that media query's reset list.
- Related: [[website-logo-sync]].
