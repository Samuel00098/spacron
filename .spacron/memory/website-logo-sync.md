# The website logo must be re-stamped from the app icon

`website/public/` holds copies of the app icon — `icon.png`, `favicon.png`,
`favicon.ico` — and it has drifted before (the site shipped the old
hexagon+bolt design for weeks after the ribbon-S redesign landed 2025-09-05).
When the app icon changes, re-copy the set:

- `static/icon-dark.png` -> `website/public/icon.png` (the site is dark-themed,
  so use the dark-background variants)
- `static/favicon-dark.png` -> `website/public/favicon.png`
- `src-tauri/icons/icon.ico` -> `website/public/favicon.ico` (the only real ICO;
  `static/` has none)

Authoritative sources for "current" are `src-tauri/icons/` (what the app ships)
and `static/` (the design source). Nothing in `website/` owns the design.
