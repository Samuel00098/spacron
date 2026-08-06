# Spacron Background Wallpapers

The Spacron developer workspace ships **6** preset background wallpapers in
`static/backgrounds/`, and exactly **2** preset themes declare a `backgroundImage`.

Corrected 2026-08-06: this note previously claimed 32 wallpapers (16 light / 16
dark). That was true before the theming rework (commits `1c60ad5` → `7896257`)
consolidated everything to one wallpaper set with two accents. Count the
directory before trusting any number here.

## Specifications & Requirements

- **Directory:** [static/backgrounds](file:///C:/Users/samue/OneDrive/Documents/Projects/Real%20Projects/spacron/static/backgrounds)
- **Format:** WebP
- **Resolution:** 2560×1440 (16:9 landscape)
- **Overlay:** UI overlay operates at 75% opacity with glassmorphism blur (see [[glass-panel-recipe]]).
- **Prompt Reference:** [background-generation-prompt.md](file:///C:/Users/samue/OneDrive/Documents/Projects/Real%20Projects/spacron/background-generation-prompt.md)

## Theme Mapping

Preset themes defined in [src/lib/stores/presetThemes.ts](file:///C:/Users/samue/OneDrive/Documents/Projects/Real%20Projects/spacron/src/lib/stores/presetThemes.ts) reference these background images directly via relative paths (e.g. `/backgrounds/light-office.webp`, `/backgrounds/dark-street.webp`).
