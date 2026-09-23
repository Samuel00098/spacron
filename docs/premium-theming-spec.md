# Premium Theming Spec — "Nightglass" Language for Spacron

Status: **PROPOSED** — research-backed spec, not yet implemented.

This spec does two things: (1) records the deep-dive on **CNVS** (`cnvs.dev`), the
closest competitor to Spacron's agent-fleet story, and (2) defines the concrete
theming work that takes Spacron from "looks good" to "feels premium" — with
exact files, tokens and gotchas, learned from `.spacron/memory/` and the tree.

---

## Part 1 — CNVS deep-dive (as of 2026-08-07)

### What CNVS is

- **cnvs.dev** — "Command an army of agents with your voice". Native **macOS**
  app built in Swift by solo dev **Max Blade** (launched ~July 2026).
- Runs **Claude Code, Cursor Composer and Codex in parallel on an infinite
  canvas**. One frontier model ("brain", planning + review) delegates to cheaper
  "hands" (Cursor = reading/fast tasks, OpenAI = execution/terminal); results
  route back to the brain for review; **cross-agent shared memory** curbs
  context bloat. Claim: up to **15x efficiency** of the frontier model alone,
  **8 simultaneous agents on a 16 GB M1 MacBook Pro**, 1M-token brain context.
- **Voice is a product pillar**: local sub-300ms speech-to-text (Nvidia Parakeet
  + GPT Realtime 2.1 Mini), controlling layout, canvases, spawning agents and
  prompting sessions ("Jarvis-style", see the YouTube video *"I Built The
  Ultimate Jarvis AI Coding Setup (CNVS)"*).
- **Pricing**: one-time lifetime license — $99 founder (#1–5), $129 (#6–50),
  $169 (#51–150), reported as high as $199 post-founder. Runs on the user's
  existing AI subscriptions; no API charges.
- **Positioning language**: "a calmer way to build software with AI" — *not*
  another chat box, *not* another terminal wrapper; a **spatial creative
  environment**.

### Release notes read (their roadmap tells us what they value)

**1.3.2 "Nightglass"** (2026-06-17) — foundation release:
- Infinite canvas as core shape; terminals, agent sessions, browser previews,
  music, sketches, working context on one persistent surface.
- Voice became a pillar; multi-canvas projects; detected coding agents.
- **"A quieter, more cinematic interface"** — themes, typography, launcher
  polish, **aura effects**, canvas transitions, **visual restraint**: "less
  noise, more atmosphere, a workspace that feels spacious, focused, and alive."
- External-control foundations: local control server, CLI tooling, MCP-style
  integration.

**1.4.0 "Shorthand"** (2026-08-03) — status legibility:
- **Per-agent one-line work titles** ("Command bar redesign", not the spinner
  verb / current tool) generated on-device by Apple's local model, no key, no
  cost. Shown in the **fleet briefing (F)** and permanently on Stage sidebar
  rows.
- **Command bar + ⌘K merged into one surface** — type, ranked results grow
  upward, bottom row is always "Do it".
- **Stage sidebar rebuilt**: grouped *needs-you / agents / windows*; each agent
  row = brand logo + callsign + work title **in the agent's own colour**; rows
  never reorder except when flipping to needs-you.
- Full keyboard stage control: ⌘↑/⌘↓ walk rows, ⌘←/⌘→ cycle canvases, **⌘J
  jumps to whoever needs you**, ⌘0 grid / ⌘1–9 slots, Esc steps down.
- **Tasks node**: live task list — who's working, what's done, what's blocked.
- **Honest agent status**: rebuilt around "what a harness can honestly report —
  idle, working, needs you — instead of guessing from screen output and
  timers." (The exact problem Spacron's Phase 1 deterministic turn signals
  solve.)
- **"Sidebar legibility is now AAA on every theme, including the video-backed
  glass ones."**

### What Spacron can take from CNVS

| CNVS strength | Spacron equivalent / gap |
|---|---|
| Cinematic visual language ("Nightglass") | No aura/atmosphere layer; wallpaper swap pops instead of crossfading — **Part 2 of this spec** |
| Work titles on every agent row | Agent rooms show task/verb labels; titles exist in tasks but not on room chrome |
| Honest idle/working/needs-you status | Phase 1 of `docs/premium-experience-roadmap.md` (turn signals) — same insight, still open |
| AAA legibility "on every theme" | Needs a verification pass on frosted surfaces (Part 2, §6) |
| Voice-native direction | Spacron already has a voice layer ([[voice-turn-taking]]); not a theme concern |
| macOS-only, $99–199 one-time | Spacron's cross-platform + one-time edge is its own; themes are the visible differentiator |

**Key insight**: CNVS sells "all themes" as a license bullet and invests in
cinematic restraint, not more chrome. Spacron's theme system (20 presets,
wallpapers, glass recipe, motion tokens) is already ahead of most desktop apps;
the gap is **atmosphere and transition**, not another 10 themes.

---

## Part 2 — The premium theming plan for Spacron

### Design principles (adopt as the house rules)

1. **Visual restraint** — one loud thing per screen; most surfaces stay quiet.
2. **Atmosphere, not decoration** — wallpaper + aura + vignette; every layer
   stays below the legibility bar (text never re-tinted from wallpaper — that
   was tried and reverted, [[background-wallpapers]]).
3. **Cinematic motion** — theme switches, room moves and launches read as
   scenes: crossfades and staggers on `--ease-out`, never pops.
4. **Everything measured** — one token for every duration (done,
   [[motion-tokens]]), elevation, radius, font size.

All work below lands on the existing system — no new dependencies, no
architecture changes. The accent stays **graphite** ([[accent-and-icon-treatment]]);
colour everywhere still means something. Atmosphere comes from a new `--aura-*`
token family, not from re-colouring surfaces.

### P0 — atmosphere & transitions (biggest premium-per-hour)

**1. Aura layer (new token family `--aura-*`)**

Per-preset ambient glow that never touches text. Each theme already carries the
*idea* of its wallpaper; give it one desaturated, low-opacity colour token that
lives in its own layer **under** all surfaces:

- New key `aura` (and `aura-2` for a secondary drift tone) per preset in
  `presetThemes.ts` + `loader.rs`, derived from the wallpaper's dominant hue at
  ~15–25% saturation, near-black value for dark, near-white for light.
- Painted as a fixed radial gradient (top-left or top-center, ~60vh falloff)
  at **3–6% opacity** in `global.css`, layered between the wallpaper and the
  scrims. Vignette: a second radial at the edges at 8–10% for cinema.
- **Gotchas from memory that apply**: (a) `apply_color_map` in `registry.rs`
  only rewrites keys a theme already has, so `aura` must also ship a correct
  `global.css` fallback (per-mode neutral) and `BRAND_MIGRATION_VERSION` gets a
  new link so saved custom themes inherit it; (b) the blanket `svg` rules and
  the `!important` text ramps are wallpaper-gated — the aura layer must not
  participate in either; (c) solid themes (`forge-dark`/`forge-light`) have no
  wallpaper — give them a `None` aura fallback via the same `:root` default.

**2. Wallpaper crossfade on theme switch**

Today a theme switch pops the wallpaper (`theme.ts` writes `--user-bg-image`
directly; the `theme-transitioning` class exists at `theme.ts:293` and is only
used for a fade of the page). Change the wallpaper swap to a true crossfade:

- Keep a two-layer wallpaper stack: `body::before` (current image) and a new
  `body::after`-pinned layer that receives the *incoming* image during
  `html.theme-transitioning`, fading it in over `--dur-slower` (0.42s) with
  `--ease-standard`, then promotes it to the base layer on `transitionend`.
- This is separate from the `plus-lighter` view-transition contract
  ([[view-transition-blend-contract]]) — do **not** route it through
  `startViewTransition`; plain CSS fade keeps the page snapshot cost out of it.
- Respect `prefers-reduced-motion` (near-zero duration via the existing
  blanket rule).

**3. Elevation & radius tokens**

`global.css` gets the first token families for the two most visible remaining
inconsistencies (motion is done):

```css
--elevation-1: 0 1px 2px rgba(0,0,0,.05), 0 1px 3px rgba(0,0,0,.06);
--elevation-2: 0 2px 4px rgba(0,0,0,.06), 0 6px 16px rgba(0,0,0,.12);
--elevation-3: 0 4px 8px rgba(0,0,0,.08), 0 16px 40px rgba(0,0,0,.22);
--radius-sm: 6px; --radius-md: 10px; --radius-lg: 14px; --radius-xl: 20px;
```

Light-mode variants shadowed lighter (the deep `rgba(0,0,0,…)` casts read
muddy on `#f8fafc`). Then sweep the largest surfaces — SettingsModal, command
palette, toasts, popover menus, agent cards, FloatingPromptBar — onto the
tokens. No visual redesign; consistency is the premium.

### P1 — presence & character

**4. A flagship theme pair (11th pair, "Studio")**

One cinematic pair following `background-generation-prompt.md`: **Nightglass
Studio** (dark — deep graphite room with a single soft light source) +
**Daylight Studio** (light — same room, daylight). Distinctive syntax tokens so
the picker and editor visibly change; chrome neutrals stay shared per
[[background-wallpapers]] (a new pair must not re-invent the ramp). Only
`presetThemes.ts` + the two `.webp` files need touching (ffmpeg recipe in
[[background-wallpapers]]); the Rust side reads presets on the frontend for the
picker, but the **bundled** defaults live in `loader.rs` — add the pair there
too so a fresh install can hit it before the frontend loads.

**5. Welcome / launcher polish ("launcher polish" per CNVS)**

- Staggered entrance: header → launchpad row → recents → shortcuts footer,
  each rising with `--ease-out`, `--dur-base`, ~20ms stagger
  (keyframes + `animation-delay`, tokenized durations only).
- Clock/date in `font-variant-numeric: tabular-nums`; the `welcome-kicker` and
  `section-label` get one `--tracking-wide` token each.
- The `.welcome .action-label` truncation bug ([[accent-and-icon-treatment]]
  known gaps) fixed as part of this pass.

**6. AAA legibility verification pass (sidebars & agent chrome)**

CNVS shipped "AAA on every theme including glass". Spacron has the tokens to
match: run a contrast check of `--text-secondary`/`--text-muted` on the frosted
side panels, fleet rows, task cards and agent room headers against the
**current** scrim values ([[background-wallpapers]]: dark wash 0.16 + gradient
0.10→0.20; light 0.03 + 0.18→0.22). Where a surface fails 4.5:1, bump that
surface's text to the next token level — do **not** change the scrims or the
global ramps. Also: agent names on room headers use the agent's brand colour
via `useAgentBrand` ([[agent-brand-marks]]) at the dark-theme legibility floor
(≈4.5:1), echoing CNVS's "each agent row in the agent's own colour".

**7. Glass tuning**

- The known repaint cost of `--glass-blur: 40px` on ~165 `backdrop-filter`s
  ([[motion-tokens]], [[premium-feel-fixes]]): introduce two tiers —
  chrome/side panels 24px, dense modals 32px — both still clearly frosted and
  cheaper. `--glass-saturate` per tier too.
- Re-verify the minifier gotcha stays dead (`cssMinify: false` in
  `vite.config.js`; do not re-enable).

### P2 — consistency & feel (rides along)

**8. Type scale tokens** — extend the `--editor-font-*` pattern
([[editor-font-vars]]) with a UI scale: `--fs-xs 12 / --fs-sm 13 / --fs-md 14 /
--fs-lg 16 / --fs-xl 20 / --fs-2xl 24 / --fs-3xl 32` plus `--tracking-tight` /
`--tracking-wide` / `--leading-*`. Sweep the biggest re-declared sizes
(SettingsModal, panels, fleet) onto the tokens in the same pass as §3 — one
token sweep per component, never two edits to the same file.

**9. Terminal chrome** — terminal is always dark ([[terminal-is-always-dark]]):
give terminal panes a 1px inset ring in the agent's `--role-*` colour at low
alpha when the room is focused, plus an inner top highlight so the pane reads
as recessed. Purely visual; no xterm changes.

**10. Error/state polish (feel, not theme)** — from [[premium-feel-fixes]]
"not touched": failures that are `console.error`-only (editor format, preview
port, model loaders, orchestrator spawn) surface via `showToast`; delete the
dead `isLoading` state. Spinners must always resolve or state *why* (Phase 3 of
`premium-experience-roadmap.md`).

---

## Suggested order & verification

1. P0 §2 (crossfade) + P0 §1 (aura) — ~1 theme session, visible in one switch.
2. P0 §3 (tokens) — sweep with `rg` for `box-shadow`/`border-radius` outliers.
3. P1 §4 (Studio pair) — wallpaper generation per
   `background-generation-prompt.md`, then preset + loader.
4. P1 §5–7, P2 §8–10 — each a small commit.

Verify each step with `npm run typecheck` (or `tsc --noEmit`), the existing
vitest suite (454 frontend tests), `cargo check` + Rust tests, and a real
`tauri dev` pass in both modes: dark, light, one glass preset, and
`forge-dark` (solid themes miss every wallpaper-gated rule — check them
separately, [[accent-and-icon-treatment]]).

Contrast gate: no change may take a text colour below 4.5:1 against its
surface; syntax tokens keep the existing 2.7–4.9:1 convention
([[background-wallpapers]]).

---

## Files touched (complete list)

- `src/lib/stores/presetThemes.ts` — aura keys on 20 presets + new Studio pair
- `src-tauri/src/theme/loader.rs` — aura + Studio pair for bundled defaults
- `src-tauri/src/theme/registry.rs` — `BRAND_MIGRATION_VERSION` chain for `aura`
- `src/styles/global.css` — aura layers, vignette, crossfade, elevation/radius
  tokens, type scale, tabular-nums/tracking tokens
- `src/lib/stores/theme.ts` / `background.ts` — aura write + two-layer wallpaper
- `static/backgrounds/` — `light-studio.webp` / `dark-studio.webp`
- `src/lib/components/workspace/WelcomeScreen.tsx` (+ `.css`) — launcher polish
- `src/lib/components/layout/AppShell.tsx` (+ `.css`) — glass tiers
- `src/lib/components/shared/SettingsModal.tsx` — token sweep
- `docs/premium-experience-roadmap.md` — link this spec; do not fork it
