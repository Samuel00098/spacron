# Orca — competitor deep-dive and "make Spacron look like it" plan

> **Superseded for the visual parts (2026-08-10).** Spacron keeps its own styling —
> the palette/layout adoption in §3, §4 and §7 is **not** being pursued. What is being
> pursued is the *functionality*: see **`docs/orca-feature-gap.md`**. Sections 1, 2 and 5
> (what Orca is, its design thesis, the MIT licence position) remain accurate reference,
> and the geometry/behaviour rules in §3 are still worth reading as craft notes.

Status: **RESEARCH** — nothing implemented. Companion to `docs/premium-theming-spec.md`
(the CNVS deep-dive); the two point in **opposite visual directions**, see §6.

Researched 2026-08-10 from primary sources: `onorca.dev`, `github.com/stablyai/orca`
(MIT, public), their `docs/STYLEGUIDE.md`, and their canonical token file
`src/renderer/src/assets/main.css`. Everything below is quoted from those, not guessed.

---

## 1. What Orca is

- **Orca ADE** ("Agent Development Environment") by **Stably AI / Lovecast Inc.** (YC-backed,
  SF). First stable release ~March 2026; >24k GitHub stars.
- **Electron + TypeScript + React**, cross-platform (macOS arm64/x64, Windows, Linux AppImage).
  Not Tauri.
- **Free, MIT, fully open source** — the entire renderer, main process, mobile app and docs
  are public. There is no paid tier; monetisation is the parent company.
- Same product shape as Spacron: run **Claude Code / Codex / Gemini / OpenCode / Grok / Cursor**
  in parallel, each in its **own git worktree**, with terminals, diffs, review and follow-up
  prompts in one window.
- Differentiators they lead with: Ghostty-class **WebGL terminal with infinite splits** and
  restart-surviving scrollback; **Design Mode** (click a UI element in an embedded Chromium
  window, its HTML + CSS + cropped screenshot go into the agent prompt); native **GitHub /
  Linear / Jira / GitLab** task browsing; **inline diff annotations** sent back to agents;
  **SSH worktrees**; `orca` **CLI** (`worktree create`, `snapshot`, `click`, `fill`);
  **iOS/Android companion** paired by QR; **automations** (scheduled per-agent tasks);
  Claude/Codex **usage meters with account switching**.

**The single most useful fact for us:** Orca ships a written UI style guide
(`docs/STYLEGUIDE.md`) *and* a single canonical token file. Replicating their look is not
reverse-engineering — it is transcription.

---

## 2. Their design language, in one paragraph

> "The visual identity is **monochrome and quiet** — neutral grays carry the chrome, colour is
> reserved for state. The product spends most of its time hosting other people's tools
> (Monaco, xterm, Markdown previews), so Orca's own UI should recede and frame."

Concretely: **shadcn/ui "new-york-v4" on Tailwind v4, neutral base, Radix primitives,
lucide-react icons, Geist variable font, 10px base radius, hairline borders, almost no
shadow, no gradients, no translucency, no wallpaper.** Two app themes only — `light`,
`dark`, `system`. (Their theme *variety* lives in the terminal: they import Warp and Ghostty
theme files. App chrome stays neutral and can optionally be tinted by `--bg-titlebar`.)

---

## 3. The exact tokens (transcribed from their `main.css`)

### Colour — dark

| Token | Value | Role |
|---|---|---|
| `--background` / `--foreground` | `#0a0a0a` / `#fafafa` | app canvas |
| `--card`, `--popover` | `#171717` | lifted panels, floating menus |
| `--sidebar` | `#171717` | left nav rail |
| `--worktree-sidebar` | `#2a2a2a` (accent `#353535`) | the worktree list panel |
| `--secondary`, `--muted` | `#262626` | low-emphasis fills |
| `--muted-foreground` | `#a1a1a1` | captions, paths, placeholders |
| `--accent` | `#404040` | hover/active row wash |
| `--primary` / `--primary-foreground` | `#e5e5e5` / `#171717` | the one affirmative action |
| `--border` | `rgb(255 255 255 / 0.07)` | **every** hairline |
| `--input` | `rgb(255 255 255 / 0.15)` | field outline |
| `--ring` | `#737373` | focus / selection halo |
| `--editor-surface` | `#1e1e1e` | Monaco + markdown panes (VS Code parity) |
| `--destructive` | `#ff6568` | delete / error |
| `--sidebar-primary` | `#1447e6` | the only saturated chrome colour in dark |
| `--ai-action-accent` | violet-400 | "this is AI" affordance |
| `--status-success` | `#86efac` | + 10% bg / 25% border via `color-mix` |

### Colour — light

`--background` `#fff` · `--foreground` `#0a0a0a` · `--card`/`--popover` `#fff` ·
`--sidebar` `#fafafa` · `--worktree-sidebar` `#f5f5f5` (accent `#eaeaea`) ·
`--secondary`/`--muted`/`--accent` `#f5f5f5` · `--muted-foreground` `#737373` ·
`--border`/`--input` `#e5e5e5` · `--ring` `#a1a1a1` · `--destructive` `#e40014` ·
`--primary` `#171717` · `--editor-surface` `#ffffff`.

Git decorations mirror VS Code exactly: added `#81b88b`, modified `#e2c08d`,
deleted `#c74e39`, renamed/untracked/copied `#73c991`, ignored `#6e6e6e`.
Git graph lanes: `#ffb000`, `#dc267f`, `#ce9178`, `#40b0a6`, `#b66dff`;
refs `#3794ff` / remote `#b66dff` / base `#ea5c00`.

**Rule they enforce:** never a raw hex in a component; tints come from
`color-mix(in srgb, var(--token) N%, var(--surface))` so light/dark parity is automatic.

### Type

- **Geist** as one variable woff2 (100–900), self-hosted. `--font-mono` = SF Mono → Cascadia →
  Menlo → Consolas. A separate `Orca Nerd Font Symbols` face is mapped to the private-use
  unicode ranges so terminal glyphs work.
- `letter-spacing: 0.01em` set once on `body`, never overridden per component.
  `-webkit-font-smoothing: antialiased`.
- Sizes: **11px** (uppercase meta / section labels — 600 weight, `text-transform: uppercase`,
  `letter-spacing: .05em`), **12px** (paths, sub-text), **13px** (sidebar items, dense rows),
  **14px** (body, default button).

### Geometry

- `--radius: 0.625rem` (10px) base; `sm` ×0.6 = 6px, `md` ×0.8 = 8px, `lg` ×1 = 10px,
  `xl` ×1.4 = 14px, `2xl` ×1.8, `3xl` ×2.2, `4xl` ×2.6. Buttons/inputs `rounded-md`;
  `Card` `rounded-xl`; badges `rounded-full`.
- **Titlebar 36px** (`min-height` too), `background: var(--bg-titlebar, var(--card))`,
  1px bottom border, `-webkit-app-region: drag`. The *left* segment paints
  `--worktree-sidebar` instead so the left column reads as one panel, and draws its divider
  with `box-shadow: inset 0 -1px 0 var(--border)` rather than `border-bottom` — a border
  would shrink the flex box to 35px and land centred controls a half-pixel off the macOS
  traffic lights. macOS reserves an **80px** traffic-light gutter.
- Workspace centre/right columns align to the same 36px baseline as **4px drag strip + 32px
  tab row**.
- **Sidebar 240px**, `transition: width 200ms ease`.
- Split resize handle: **6px** hit area, **3px** visible line, `border-radius: 1px`,
  colour `--tab-group-split-divider` `#71717a` → `#a1a1aa` on hover/drag, 100ms.
- Buttons: `default` 36 / `sm` 32 / `xs` 24 / `lg` 40 px, plus icon variants.
- Scrollbars: 12px track, 3px transparent border + `background-clip: padding-box` → a 6px
  thumb at `muted-foreground` 28%, **`border-radius: 0`**, `min-height: 28px`. Three classes
  only (`.scrollbar-sleek`, `.scrollbar-editor`, `.worktree-sidebar-scrollbar`).

### Elevation — only three levels

1. **Inset hairline** — a `--border` line. The default; almost everything sits here.
2. **Subtle lift** — `shadow-xs` + one border. Outline buttons, embedded cards.
3. **Floating** — `0 10px 24px rgba(0,0,0,0.18)`. Popovers only.

"Don't add a fourth level. If something needs more emphasis than floating, you're probably
reaching for the focus `ring` instead."

### Behaviour rules worth stealing regardless of look

- **Theme swap kills transitions** — a `.theme-transition-disabled` class sets
  `transition: none !important` on everything (animations excepted) while variables flip, so
  the UI doesn't fade at different speeds per element.
- **`@custom-variant can-hover`** — hover-reveal row actions are hidden behind
  `@media (hover: hover)` so touch devices keep them visible.
- **In-flight feedback matched to duration**: 0–100ms nothing · 100ms–1s disabled only ·
  1–3s disabled + spinner · 3s+ named stage labels. Pre-reserve the width a control will grow
  into. Bind *disabled* immediately but *visible* loading on a ~200ms timer so local users see
  nothing and SSH users get feedback.
- **Cancel/Dismiss/Close are not destructive** — quiet ghost, no colour, no shortcut chip.
- **UI copy must not overclaim** — result verbs ("skipped", "verified", "deleted") only when
  there is real result state behind them.

---

## 4. The shell, region by region (from their hero screenshot)

```
┌ 36px titlebar ─────────────────────────────────────────────────────────────┐
│ traffic lights │ Orca │ ⧉  ← → │ [tab] + │ ▶ dev ⌄ ⋯ │ [tabs…] + │ icons ⧉ │
├────────────┬──────────────────────────────────┬────────────────────────────┤
│ 240px      │  terminal / editor / browser     │  right sidebar             │
│ sidebar    │  panes, split H and V,           │  file tree, git, tasks     │
│            │  each with its own footer strip  │  (activity-bar icon row)   │
│ Tasks      │                                  │                            │
│ Automations│                                  │                            │
│ Orca Mobile│                                  │                            │
│ Search     │                                  │                            │
│ ── WORKSPACES ─────                           │                            │
│ ▾ Pinned 3 │                                  │                            │
│  ● 📁 .claude [Folder]                        │                            │
│  ● 🚀 main   [primary]                        │                            │
│ ▾ In progress 17                              │                            │
│  ● improve-readme                             │                            │
│      [orca] Jinwoo-H/improve-readme           │                            │
│      ⊙ ⚛ ✳ ✳  ← agent brand chips             │                            │
├────────────┴──────────────────────────────────┴────────────────────────────┤
│ ✳ ▬▬▬ 78% 5h · 94% wk   ◎ ▬▬▬ 100% 5h · 80% wk   ⟳     (status bar)        │
└────────────────────────────────────────────────────────────────────────────┘
```

Row anatomy in the worktree sidebar: **status dot · emoji/icon · name · pill badge**
(`Folder`, `primary`, `expired`) / second line **repo pill + branch path in muted 12px** /
third line **agent brand chips**, and when expanded, the agent's last message + a relative
timestamp (`4h`) right-aligned. Group headers are 11px uppercase with a **count badge**.
List row states are the whole system: idle transparent → hover `bg-accent` → cmdk-selected
`bg-accent` + `border-border` → current `bg-accent` + `data-current="true"`.

---

## 5. Can we replicate it? Yes — and the licence says how

- The code is **MIT**. You may copy their CSS, tokens and component code into Spacron even
  though Spacron is closed-source ([[licensing-and-docs]]). The one hard obligation: ship the
  MIT copyright + permission notice covering the copied portions (a `THIRD-PARTY-NOTICES.md`
  entry and a header comment on any transcribed file is the normal way).
- **Not** covered by MIT: the name **Orca**, the whale mark, and the `onorca.dev` branding —
  those are trademark. Copy the layout and tokens, never the mark or the name.
- Copying *pixel-for-pixel including their branding* would also be trade dress. Copying a
  design language (neutral shadcn, Geist, 10px radius, 36px titlebar) is not — that's the
  same vocabulary Linear, Vercel and half of shadcn-land already share.

So "exactly a replica" is achievable in the honest sense — same layout, same tokens, same
density, our own name and mark. The parts that are *not* a theming job are the features that
create the look: Design Mode's embedded Chromium, the mobile companion, usage meters, the
right-hand activity bar. Those are product work, not CSS.

**One strategic caveat, stated once:** Orca is free and MIT with 24k stars. Spacron sells for
a one-time fee ([[open-source-decision]]). Shipping a visual clone of a free competitor makes
"why not just use Orca?" the first question every prospect asks. Adopting their *discipline*
(one token file, three elevation levels, quiet monochrome, a written style guide) is
defensible on its own merits; adopting their *identity* trades away the only thing a paid app
has. The plan below works either way — you choose how far down §7 you go.

---

## 6. The gap: our stack vs theirs

| | Orca | Spacron today |
|---|---|---|
| Shell | Electron + React | **Tauri + React** |
| Styling | Tailwind v4 + shadcn/ui + CVA + Radix | **55 hand-written component `.css` files**, no Tailwind, no component library |
| Icons | `lucide-react` | inline SVG + `useAgentBrand` brand marks |
| Font | Geist (one variable file) | **Inter** 400–800 + JetBrains Mono |
| Tokens | one file, `:root` + `.dark`, ~40 semantic names | `global.css` (1289 lines) + `presetThemes.ts` + `loader.rs`, `--bg-primary/secondary/tertiary`, `--text-*`, `--frost-*` |
| Themes | light / dark / system, **2 palettes** | **20 presets** + wallpapers + custom themes + brand-migration chain |
| Surfaces | flat, opaque, hairline borders | **translucent glass** — `backdrop-filter: blur(18px) saturate(130%)`, wallpaper behind everything |
| Titlebar | 36px, `--card`, inset-shadow divider | 38px, transparent + frosted, `z-index: 100000` |
| Radius | 10px base, computed scale | per-component, no scale |
| Elevation | 3 levels, documented | ad-hoc `box-shadow` (the elevation tokens are still only *proposed* in `premium-theming-spec.md`) |

**The direct conflict:** `docs/premium-theming-spec.md` ("Nightglass") argues Spacron should
go *more* cinematic — aura layers, vignettes, wallpaper crossfades, glass. Orca's whole thesis
is the opposite: **recede and frame**, no atmosphere at all. These cannot both be the plan.
Pick one before any of §7 is committed, or Spacron ends up with tokens from two religions.

---

## 7. What to actually do — phased, with files

Each phase is independently shippable and reversible. Phases 0–2 are worth doing under
*either* design direction; 3–4 are the actual "look like Orca" work.

### Phase 0 — collapse to one token file (no visual change)

The prerequisite for everything. Add a semantic layer over the existing palette in
`src/styles/global.css` so components stop reading raw `--bg-secondary`:

```css
:root {
  --surface-canvas: var(--bg-primary);   /* Orca: --background   */
  --surface-card:   var(--bg-secondary); /* Orca: --card         */
  --surface-sidebar:var(--bg-secondary); /* Orca: --sidebar      */
  --text-body:      var(--text-primary);
  --text-quiet:     var(--text-secondary);
  --hairline:       var(--border-color);
  --focus-ring:     var(--accent-color);
}
```

Then sweep the biggest consumers (`AppShell.css`, `TitleBar.css`, `SettingsModal`) onto the
new names. This is what makes a later palette swap a one-file edit instead of 55.

### Phase 1 — geometry parity (cheap, high signal)

Adopt Orca's measurements without touching colour:

- `--radius-sm/md/lg/xl` = 6 / 8 / 10 / 14px, base 10px, and sweep every hardcoded
  `border-radius` in `src/lib/components/**/*.css`.
- `--elevation-1/2/3` with **only three** levels; floating = `0 10px 24px rgba(0,0,0,.18)`.
- Titlebar 38px → **36px**, and replace `border-bottom` with
  `box-shadow: inset 0 -1px 0 var(--hairline)` (`TitleBar.css:8`) so centred controls keep the
  full 36px box — same reason they did it.
- Type scale tokens 11 / 12 / 13 / 14 px with the 11px uppercase-600-`.05em` meta style.
- One scrollbar class, 12px track / 3px transparent border / `border-radius: 0` thumb.
- `letter-spacing: 0.01em` on the app root.

### Phase 2 — the behavioural rules (no visual change, all upside)

- `theme-transition-disabled` during theme swaps (we currently rely on `theme-transitioning`
  for a page fade — see `theme.ts:293`; this is the complementary half).
- The duration→feedback table, applied to spawn / clone / worktree / SSH actions.
- `@media (hover: hover)` gate on every hover-reveal row action.
- Cancel/Dismiss demoted to quiet ghost everywhere.
- Adopt the *style-guide-as-a-file* habit: `docs/STYLEGUIDE.md` in our repo, same shape.

### Phase 3 — the palette swap (this is where it starts looking like Orca)

Add an **11th preset pair, `orca-dark` / `orca-light`**, in `src/lib/stores/presetThemes.ts`
and `src-tauri/src/theme/loader.rs`, using the §3 values verbatim, with:

- `wallpaper: none` and the **solid-theme** path forced — glass is what makes us not-Orca.
  Note `.solid-theme` misses every wallpaper-gated rule ([[accent-and-icon-treatment]]), so
  this pair must be tested on its own.
- `--border` at `rgb(255 255 255 / 0.07)` — our current hairlines are heavier.
- Git decoration + git graph lane tokens (we don't have a formal set; VS Code parity is free
  legibility for anyone coming from VS Code).
- Bump `BRAND_MIGRATION_VERSION` in `src-tauri/src/theme/registry.rs` so saved custom themes
  inherit the new keys (`apply_color_map` only rewrites keys a theme already has).

Shipping it as *a preset* rather than a rewrite is the whole trick: users who want the quiet
Orca look pick it, our wallpaper identity survives, and nothing is thrown away.

### Phase 4 — layout parity (only if the answer to §5's caveat is "go all the way")

- Left rail: fixed **240px**, `transition: width 200ms ease`, sections
  `Tasks / Automations / Search` above a `WORKSPACES` group with 11px uppercase headers +
  count badges. Our Fleet panel already carries the data ([[fleet-panel-placements]]).
- Worktree card anatomy: dot · icon · name · pill / repo-pill + branch / agent brand chips —
  we already have the brand marks ([[agent-brand-marks]]), the row shape is what's missing.
- Bottom **status bar** with per-agent usage meters (`78% 5h · 94% wk`).
- Right-hand **activity bar** (files / grid / git / tasks) collapsing the right sidebar.
- Split handles at 6px hit / 3px line.

### Explicitly out of scope for a "look" project

Design Mode (embedded Chromium element picker), the mobile companion, SSH worktrees, Warp /
Ghostty theme import, and the `orca` CLI. Each is a real feature; none of them is theming.
Worth their own evaluation — Warp/Ghostty theme import in particular is a cheap win we could
take on its own, since our terminal is always dark ([[terminal-is-always-dark]]) and a theme
importer would give the terminal the variety the app chrome already has.

---

## Sources

- <https://www.onorca.dev/> — positioning, feature list, downloads
- <https://github.com/stablyai/orca> — MIT source; `docs/STYLEGUIDE.md`;
  `src/renderer/src/assets/main.css` (canonical tokens); `components.json` (shadcn new-york-v4,
  neutral base); `docs/assets/readme-hero.jpg` (the shell screenshot §4 is read from)
