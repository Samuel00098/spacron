# Spacron Background Wallpapers

Spacron ships 22 preset background wallpapers (11 light, 11 dark) in `static/backgrounds/`.
One wallpaper per preset theme — there is no theme without a background.

## Specifications & Requirements

- **Directory:** `static/backgrounds/`
- **Format:** WebP (written with PIL, `quality=88, method=6`; ~200–580 KB each, 7.6 MB total)
- **Resolution:** 3840×2160 (4K, exact 16:9). The 2026-08-04 source renders were only
  1664×928, so the shipped files are a LANCZOS upscale (centre-cropped to 16:9 first,
  then `UnsharpMask(radius=2.0, percent=55, threshold=3)`) — real detail is still
  1664px-worth. If you regenerate, generate at 3840×2160 natively rather than
  re-upscaling. Note the generation spec doc still says 2560×1440.
- **Overlay:** UI overlay operates at 75% opacity with glassmorphism blur
  (see [[platform-glass-transparency]]).
- **Prompt Reference:** `background-generation-prompt.md` — its `### N. \`filename.webp\``
  headings and `**Theme name:**` lines are kept in lockstep with `presetThemes.ts`.
  Change one, change the other.

## Theme Mapping

Preset themes in `src/lib/stores/presetThemes.ts` point at these files via
`backgroundImage: '/backgrounds/<name>.webp'` (served from `static/`, so the path is
root-relative, not `$lib`).

Gotcha: **theme `id`s are persisted** (`theme.ts` looks up `savedThemeId` against
`presetThemes`), so renaming an id silently drops a user's saved theme back to the
default. Rename the `name` (display label) and the image file freely; leave ids alone.
That is why ids like `solace-workspace`, `cyber-server` and `midnight-glow` no longer
describe their imagery (they are now Above the Clouds, Neon Bokeh, Aurora Borealis).

Current pairs (id → name → file):

| id | name | background |
|---|---|---|
| solace-workspace | Above the Clouds | light-cloud-window |
| aether-curves | Architectural Curves | light-architecture |
| azure-shoreline | Amalfi Coastline | light-beach |
| study-sanctuary | Grand Library | light-library |
| botanical-greenhouse | Rainy Greenhouse | light-greenhouse |
| desert-oasis | Canyon Overlook | light-desert |
| alpine-meadows | Alpine Meadow | light-meadows |
| zen-rock-garden | Kyoto Zen Garden | light-zen-garden |
| sakura-park | Sakura Blossoms | light-sakura |
| autumn-park | Autumn Forest Path | light-autumn-path |
| balcony-view | Coastal Dawn Terrace | light-balcony-morning |
| cyber-tokyo | Tokyo Neon Street | dark-street |
| midnight-glow | Aurora Borealis | dark-aurora |
| volcanic-obsidian | Black Sand Storm | dark-obsidian |
| misty-highlands | Bioluminescent Woods | dark-forest |
| cyber-server | Neon Bokeh | dark-bokeh-lights |
| cabin-fireplace | Cozy Fireplace Cabin | dark-fireplace |
| abyssal-depths | Moonlit Sea | dark-ocean |
| cosmic-nebula | Cosmic Nebula | dark-nebula |
| rainy-window | Rainy City Skyline | dark-rainy-window |
| industrial-loft | Industrial Loft Twilight | dark-industrial-loft |
| volcanic-cave | Basalt Lava Cave | dark-volcanic-cave |

A user-chosen custom background (`stores/background.ts`) overrides the theme's own
wallpaper; the theme wallpaper is only cleared when the active theme has no
`backgroundImage` of its own.
