# Spacron Background Wallpapers

The Spacron developer workspace features 32 preset background wallpapers (16 light mode, 16 dark mode) located in `static/backgrounds/`.

## Specifications & Requirements

- **Directory:** [static/backgrounds](file:///C:/Users/samue/OneDrive/Documents/Projects/Real%20Projects/spacron/static/backgrounds)
- **Format:** WebP
- **Resolution:** 2560×1440 (16:9 landscape)
- **Overlay:** UI overlay operates at 75% opacity with glassmorphism blur (see [[glass-panel-recipe]]).
- **Prompt Reference:** [background-generation-prompt.md](file:///C:/Users/samue/OneDrive/Documents/Projects/Real%20Projects/spacron/background-generation-prompt.md)

## Theme Mapping

Preset themes defined in [src/lib/stores/presetThemes.ts](file:///C:/Users/samue/OneDrive/Documents/Projects/Real%20Projects/spacron/src/lib/stores/presetThemes.ts) reference these background images directly via relative paths (e.g. `/backgrounds/light-office.webp`, `/backgrounds/dark-street.webp`).
