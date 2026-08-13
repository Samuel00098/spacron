# Spike: does the browser pillar require leaving Tauri?

> **Not run — decided without it (2026-08-10).** Spacron stays on Tauri, and agents get an
> *external* browser rather than an embedded one ([[stack-decision-tauri]]). This plan is kept
> as the plan of record if the question ever reopens; the background in "What we already know"
> is accurate and worth reading before any browser work.

Status: **PLAN — not started, superseded by decision.** Timebox: **5 working days.**

## The question

Spacron is being considered for a wider scope: browse inside the app, run agents, and control
the machine. Of those three, only **browsing** plausibly requires Electron. This spike answers
one question with evidence instead of argument:

> Can Spacron host a **real, in-window browser surface** — arbitrary external sites, reliable
> two-way DOM access, correct at non-100% DPI, on Windows **and** macOS — without moving to
> Electron?

It does **not** decide whether the wider product scope is right. That's a product decision and
it comes first; this spike only prices one of its consequences.

**Kill criterion:** if day 5 arrives without a verdict, the answer is "migrate" — a browser
surface we cannot make work in a week of focused effort is not one we'll maintain in Tauri.

---

## What we already know (do not re-derive)

Two prior attempts are documented and both constrain this spike:

1. **The preview proxy** ([[preview-proxy]]) — `src-tauri/src/preview/mod.rs`. External pages
   are served from a loopback origin under `/proxy/{scheme}/{host}/path` with framing/CSP
   headers stripped, rendered in an **iframe**. A `BRIDGE_SNIPPET` is injected at the top of
   every external page's `<head>`, wrapping `fetch`/XHR/`sendBeacon`/`EventSource`/`WebSocket`
   and `history.pushState`. A persistent server-side cookie jar is what "remembers logins".
   **This means we already have script injection and therefore already have a DOM channel** on
   any page the proxy can serve. That is the single most important fact for this spike.
2. **The in-panel native child webview** ([[native-preview-overlay]]) — added and removed the
   same day, 2026-07-25. It failed for four reasons, and **these four are the spike's test
   criteria**, because they are exactly what Electron's `WebContentsView` handles for you:
   - **Lifetime.** Rust owned it, so it survived HMR, reload and renderer crashes while the
     store reset to `false`. The orphan swallowed every click in its rect — the preview
     panel's own buttons went dead with no console error.
   - **Unmounting.** AppShell unmounts PreviewPanel on view switch; the overlay kept floating
     over the editor with no toggle left to dismiss it.
   - **Bounds and DPI.** Logical pixels only; multiplying by `devicePixelRatio` double-applied
     the scale and was correct at exactly 100% DPI. At Windows 125%/150% the oversized overlay
     covered the toolbar. `ResizeObserver` fires on resize but never on reposition, so any
     layout shift that moved the panel left the overlay on stale coordinates.
   - **No result channel.** `webview.eval` is fire-and-forget, so DOM *reads* were impossible
     and clicks unverifiable. **This is the blocker for Design Mode**, and the standing rule
     from that note applies to every option below: **never grant remote IPC to a webview that
     loads arbitrary third-party pages** — it would hand any visited site the app's command
     surface ([[security-trust-boundaries]]).

Everything the spike builds is throwaway. Nothing lands on `main`.

---

## The three candidate architectures

| | **A — Proxy + iframe (extend what we have)** | **B — Tauri + external Chromium over CDP** | **C — Electron `WebContentsView`** |
|---|---|---|---|
| Rendering | iframe on the loopback origin | real Chromium, separate process | real Chromium, composited in-window |
| In-window? | yes, it's a DOM node — no bounds/DPI/lifetime problem at all | no (separate window), or streamed frames | yes, but it's an OS surface — same bounds/DPI class of problem the child webview had |
| DOM read/write | **already solved** via `BRIDGE_SNIPPET` injection | full, via CDP `Runtime.evaluate` | full, via preload + `executeJavaScript` (returns a Promise) |
| Screenshots | DOM-side only (imperfect) | `Page.captureScreenshot` — pixel-accurate, incl. clips | `capturePage` — pixel-accurate |
| Profiles / extensions | none | full | full (per-view `session` partitions) |
| Breaks on | anti-bot, service workers, strict CSP, `postMessage` origin checks, storage (fresh ephemeral proxy port each run kills browser-side localStorage) | nothing much; integration is the cost | nothing much |
| Cost if chosen | days | 1–2 weeks | **months** (28 Rust command modules → Node) |

The honest framing: **A is nearly free and already half-built; C is the most capable and the
most expensive; B is the middle and is what the agent-facing browser already looks like**
([[agent-browser-tools]] — agents get a browser from Playwright MCP, not from us).

---

## What to build

Five tasks. Each is a throwaway branch; stop the moment a task produces its verdict.

### Day 1 — Task 1: Design Mode on Path A (the cheap answer first)

Extend `BRIDGE_SNIPPET` with an element-picker mode toggled from the app:

- Overlay highlight following `document.elementFromPoint`, Esc to cancel.
- On click: collect `outerHTML` (truncated), the element's *computed* style (filtered to a
  useful subset, not all 340 properties), its selector path, and bounding box.
- Post the payload back over the existing bridge channel to the app, into the prompt bar.
- Crop a screenshot: try `element.getBoundingClientRect()` + an existing full-page capture,
  cropped app-side.

**This is the actual product feature** (#31 in `docs/orca-feature-gap.md`). If it works well
enough on real sites, the browser pillar is not a migration argument and the spike can end on
day 2. Build it first for exactly that reason.

### Day 2 — Task 2: the Path A break-list

Run Task 1's picker against a fixed target list (below) and record precisely *where* it fails
and *why*. The output is a table, not a feeling.

### Day 3 — Task 3: Path B probe

Drive a real Chromium from Rust (`chromiumoxide` or a Playwright sidecar):

- Launch with a persistent profile dir, navigate, `Runtime.evaluate` an element picker,
  `Page.captureScreenshot` with a clip rect.
- Measure round-trip: click in the browser → payload in the prompt bar.
- Decide the compositing question honestly: is a **separate always-on-top window** acceptable
  product-wise, or must it dock inside the layout? Write the answer down before measuring, so
  the measurement doesn't rationalise it.

### Day 4 — Task 4: Path C reference implementation

A bare Electron app — not a migration, ~200 lines:

- One `BrowserWindow` + one `WebContentsView` docked in a pane.
- Preload with `contextIsolation: true`, element picker, `executeJavaScript` returning a value.
- `capturePage` with a rect.
- Then **reproduce the four failure modes from `native-preview-overlay`**: reload the renderer
  mid-session, unmount and remount the pane, run at 125% and 150% Windows scaling, and move the
  pane without resizing it. Record which ones Electron actually solves for free and which ones
  you'd still be hand-managing.

### Day 5 — Task 5: measure and write the verdict

Fill in the decision table, write the recommendation, delete the branches.

---

## Test targets (identical for A, B and C)

Chosen to break things in different ways. Record pass/degraded/fail per path per site.

| Target | What it tests |
|---|---|
| A local Vite dev server | the happy path — must be flawless on all three |
| `github.com` (logged out) | ordinary complex SPA, strict CSP |
| A Cloudflare-challenged site | anti-bot vs a loopback proxy origin |
| Google account sign-in | `Sec-Fetch-*` handling, third-party cookies, popups |
| YouTube | service workers, media, heavy `postMessage` |
| A WebGL / canvas app | screenshot fidelity and input passthrough |
| A site with an OAuth popup flow | window.open, cross-window messaging |
| Any page after app restart | does the session survive? (Path A's ephemeral proxy port does not) |

**Per-target measurements:** page renders correctly (y/n/degraded) · picker returns correct
`outerHTML` (y/n) · computed CSS matches the browser's own devtools (spot-check 5 properties) ·
screenshot crop is pixel-correct at 100% **and** 150% DPI · click→prompt-bar latency (ms) ·
process RSS after 5 tabs open (MB).

**Platforms:** Windows 11 (WebView2 — Chromium, the easy case) **and** macOS (WKWebView — the
case that actually decides it). A result that only holds on Windows decides nothing, because
that's the platform where Tauri's webview is already Chromium.

---

## Decision criteria — write these down before measuring

**Stay on Tauri, ship Path A** if: the picker works on the local dev server and at least 5 of
the 8 targets, computed CSS is accurate, and the screenshot crop is correct at 150% DPI.
Rationale: Design Mode's real job is *your own app under development*, and Path A costs days.

**Stay on Tauri, add Path B** if: Path A fails on external sites but a separate Chromium window
is product-acceptable, and click→prompt latency stays under ~300 ms. Rationale: full Chromium
capability, no rewrite, and it converges with how agents already get a browser.

**Migrate to Electron** if **all** of these hold:
1. The browser must be **docked in the layout** — a separate window is a genuine product
   failure, not just less tidy; **and**
2. Path A demonstrably cannot serve the target sites, **and**
3. Path C's reference implementation solves at least the *lifetime* and *result-channel*
   failures from `native-preview-overlay` cleanly — bounds/DPI you will be managing by hand
   either way, so if Electron doesn't fix lifetime and IPC, it isn't buying the thing you'd be
   paying months for; **and**
4. Profiles and/or extensions are on the actual roadmap, not hypothetical.

If 1–4 all hold, the migration is justified and I'd plan it properly rather than resist it.

---

## Settle the third pillar separately — half a day, not part of the browser question

"Control my laptop" does **not** depend on this decision, and the assumption that Electron
helps is worth killing early with a probe:

- Rust: `enigo` (input synthesis), `xcap` (screen/window capture), `windows-rs` / Core Graphics
  for window enumeration. Prove: enumerate windows, capture one, synthesise a click, read the
  result back. Half a day.
- Note the counter-evidence already in hand: Orca is Electron and still had to ship three
  native helper binaries (`native/computer-use-{macos,windows,linux}`) for exactly this,
  because Chromium can't reach the OS. Migrating would mean adopting that workaround, not
  avoiding it.

Do this probe **first**, on day 0. If it passes — and it should — one of the three pillars is
permanently off the migration ledger and the spike gets simpler.

**Security gate before any of it ships:** an agent that can synthesise input can click anything
on the machine, including the app's own confirmation dialogs. That needs an explicit consent
model and a scope boundary designed up front, not retrofitted ([[security-trust-boundaries]]).

---

## Rules for the spike

- **Nothing lands on `main`.** Throwaway branches, deleted on day 5.
- **Never grant remote IPC to a webview loading third-party pages** — the standing rule from
  [[native-preview-overlay]], and it applies to Electron's preload design too
  (`contextIsolation: true`, a narrow typed channel, never `nodeIntegration`).
- **Don't reintroduce the Tauri child webview** to "test it properly". It's documented as
  removed; Path C is how you test the in-window-OS-surface idea.
- **Measure on macOS.** Windows results alone prove nothing here.
- Write the numbers down as you go. The failure mode of this spike is finishing with an
  impression instead of a table.

## Output

One section appended to this file: the filled decision table, the verdict, and — whichever way
it goes — the next concrete step. If the verdict is "migrate", the follow-up is a migration
plan with a phase order and a rollback point, not a rewrite starting on Monday.
