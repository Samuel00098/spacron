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

## `agentBrands` is copied, never imported

The site's agent logos come from its own copy, `website/lib/agentBrands.tsx`,
which is a byte-identical stand-in for the desktop
`src/lib/components/shared/agentBrands.tsx` and must be re-copied when the
desktop file changes (new brands, colour tweaks, geometry fixes). Do NOT import
it from `../../src/lib/...` inside `website/`: that path only resolves locally,
because the repo root has `node_modules`; on Vercel the website is its own
root, so the desktop file's `import ... from 'react'` cannot resolve and the
build fails with "Cannot find module 'react'" (regression 97b58cb, fixed by
copying the file and importing `@/lib/agentBrands` in `page.tsx`).
