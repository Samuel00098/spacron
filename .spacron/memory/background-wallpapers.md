# Spacron Background Wallpapers

Wallpapers live in `static/backgrounds/`, one per preset theme, shipped as
**light/dark pairs**. As of 2026-08-07 there are **20** (10 pairs), and every
preset theme declares a `backgroundImage`.

The source PNGs are kept in `images/` at the repo root, named by their ChatGPT
export timestamp. Pairs are adjacent timestamps (day shot, then night shot of
the same scene). To find which sources are not yet shipped, compare that
directory against `static/backgrounds/` — there is no manifest.

Corrected 2026-08-06: this note previously claimed 32 wallpapers (16 light / 16
dark). That was true before the theming rework (commits `1c60ad5` → `7896257`)
consolidated everything to one wallpaper set with two accents. Count the
directory before trusting any number here.

## Specifications & Requirements

- **Directory:** [static/backgrounds](file:///C:/Users/samue/OneDrive/Documents/Projects/Real%20Projects/spacron/static/backgrounds)
- **Format:** WebP, lossy VP8
- **Resolution:** 1672×941 as actually shipped — the prompt doc asks for
  2560×1440, but nothing in the app depends on that and no shipped file has it.
  Match the existing files, not the doc.
- **File size:** the old "65–120 KB band" described the first four pairs only,
  and it is **content, not encoder settings** — those images are soft and
  heavily depth-of-field blurred, so they compress to nothing. The six pairs
  added 2026-08-07 are sharp photographic scenes (foliage, raked gravel,
  wildflowers) and land at **100–325 KB** even at quality 60. Squeezing them
  into 120 KB needs quality ~15–20 and visibly falls apart. Judge a new file
  by eye, not against the band. Whole directory is ~3.1 MB.
- **Overlay:** UI overlay operates at 75% opacity with glassmorphism blur.
- **Prompt Reference:** [background-generation-prompt.md](file:///C:/Users/samue/OneDrive/Documents/Projects/Real%20Projects/spacron/background-generation-prompt.md)

## Adding a new wallpaper pair

There is no image tooling in `node_modules` (no `sharp`) and no ImageMagick on
PATH, but **ffmpeg is installed**. Convert a source PNG with:

```
ffmpeg -i src.png -c:v libwebp -quality 60 -compression_level 6 -preset picture \
  static/backgrounds/light-<name>.webp
```

`-quality 60` is what the 2026-08-07 batch shipped at: no visible artefacts on
detailed scenes, ~20% smaller than the 82 the first pairs used. Sources are
already 1672×941, so no scaling is needed.

Then add a light/dark pair to `presetThemes.ts` (see below). Nothing else needs
touching — the Settings theme grid and the MCP `set_theme` name lookup both map
over `presetThemes`, so a new entry propagates everywhere on its own.

## Wallpaper "opacity" — the field named opacity is NOT the lever

`Theme.backgroundOpacity` (the `75` every preset passes) is **dead**.
`theme.ts` writes it to `--user-bg-opacity`, and **no CSS rule reads that
variable**. The wallpaper layer (`body::before`) is painted at `opacity: 1`
whenever `html.has-bg-image` is set — deliberately, per the comment at
`global.css:379`. Editing the `75`s changes nothing on screen.

What actually dims the wallpaper is **two stacked scrims** in `global.css`:

| layer | dark themes | light themes |
| --- | --- | --- |
| `body::after` flat wash | `rgba(--bg-primary-rgb, 0.10)` | `rgba(255,255,255,0.03)` |
| `#app::before` gradient | black `0.06 → 0.13` | white `0.12 → 0.15` |

At these values roughly 82–86% (dark) / ~78% (light) of the wallpaper reads
through. History: dark wash was `0.40` before 2026-08-07, `0.16` until
2026-08-26, then lightened again at the user's request ("images too dim") —
the same day the **accent bloom halos** on `body::after` (the radial-gradient
layers inherited from the base liquid-glass rule) were cut to ~1/3 strength
(18/12/8% → 6/4/3%) under `has-bg-image`, because they read as a coloured haze
over the image. The no-wallpaper look keeps full-strength blooms. Wallpapers
have NO blur by default (`backgroundBlur` is unset in every preset ⇒ 0px).

Both carry `!important` and override the `--frost-base` value that
`interfaceTransparency` computes, so the Settings transparency slider does not
affect the wash while a wallpaper is on. To make wallpapers read stronger or
weaker, change these two rules — and change dark and light together, since they
are separate rules that drifted apart before (dark sat ~15 points heavier than
light, which is why dark themes looked washed out). Values above are as of
2026-08-07.

## Don't re-colour themes from their wallpaper — this was tried and reverted

`analyseImage` measures `dominantHue` and average RGB, and `deriveGlassBackground`
exists to consume them, but **only the `isDark` boolean is actually used**. That
looks like an unfinished feature. It was finished on 2026-08-07 — surfaces and
text re-tinted toward each wallpaper's hue — and **reverted the same day: on some
wallpapers the text came out bad.** The mechanism worked (contrast was held to
within 0.3% by solving for luminance rather than holding HSL lightness); the
*look* was the problem, and no amount of contrast maths fixes that. Per-preset
authored colours win.

If you pick this up again, the three things that will bite you, in order:

1. `rgbToHue` returns -1 ("grey") whenever raw `delta < 0.05`, which catches
   **every** dark wallpaper — dark-architecture averages `#13100c`,
   unmistakably warm, delta only 0.027. Nothing tints until that is relative
   to brightness.
2. Judging "is this colour meaningful" by HSL saturation fails: near-black
   chrome like `#090d14` scores 0.38, higher than many accents, so the very
   surfaces you want to tint get skipped. Absolute chroma separates them
   (0.04 vs an indigo accent's 0.47).
3. `global.css` sets `--text-*` with `!important` under `.bg-palette-dark` /
   `.bg-palette-light` as a no-JS fallback. Inline values lose to it, so
   `applyForegroundPalette` silently has no effect unless it writes with
   `important` priority. Harmless today only because both sides hold the same
   hardcoded neutral.

The wallpaper's own visibility (the scrims above)
is the safer lever for making a theme feel like its image.

## Theme Mapping

Preset themes defined in [src/lib/stores/presetThemes.ts](file:///C:/Users/samue/OneDrive/Documents/Projects/Real%20Projects/spacron/src/lib/stores/presetThemes.ts) reference these background images directly via relative paths (e.g. `/backgrounds/light-library.webp`, `/backgrounds/dark-coastline.webp`).

Accent colours are **not** per-wallpaper: every preset spreads the shared
`LIGHT_ACCENT` / `DARK_ACCENT` maps, so a new pair only supplies neutrals,
semantic colours and syntax tokens.

**Chrome neutrals are effectively shared too — reuse them.** A new pair should
copy the existing ramp (light `#f8fafc`/`#f1f5f9`/`#e2e8f0`, border `#cbd5e1`;
dark `#0f141c`/`#090d14`/`#18202c`, border `#1e293b`) rather than invent a
palette matching its wallpaper. The Settings modal is a large flat fill of
`bg-secondary` with a `border` edge, so a per-theme cast makes that one surface
read as a different app — this was tried on Grand Library and pulled back on
2026-08-07. A wallpaper's character belongs in the wallpaper and the syntax
tokens. Amalfi Day (teal `#ccfbf1`) is the one surviving exception.

Contrast bar for a new palette: UI text (`text-primary/secondary/muted`) and the
semantic colours should clear 4.5:1 against both `bg-primary` and `bg-secondary`.
Syntax tokens in the existing presets run **2.7–4.9:1** and were clearly never
held to 4.5 — don't fail a new theme for matching that.
