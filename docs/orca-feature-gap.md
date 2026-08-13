# Orca feature inventory → Spacron gap analysis

Status: **RESEARCH / DECISION INPUT** — nothing implemented.

Purpose: the complete list of what Orca (`onorca.dev`, MIT, Electron) actually *does*, each
item checked against what Spacron already has, so we can pick features to build. **This is a
functionality exercise only — Spacron keeps its own visual identity.** The styling comparison
lives in `docs/orca-replica-research.md` and is not being pursued.

Sources: their docs nav (`onorca.dev/docs`), `README.md`, and the module layout of
`github.com/stablyai/orca` (`src/main/*`, `src/renderer/src/components/*`) — module sizes are
a reliable signal of what they've actually invested in.

Legend: **✅ have** · **🟡 partial** — the foundation exists, the feature doesn't ·
**❌ missing**.

---

## 1. Core model — worktrees, panes, sessions

| # | Orca feature | Spacron today | Verdict |
|---|---|---|---|
| 1 | **Parallel worktrees** — every task in its own isolated git worktree, own branch, own terminal, own context | Same model; two creation paths, ownership rules ([[agent-worktrees]], [[agent-worktree-staging]]) | ✅ have |
| 2 | **Fan one prompt across N agents**, compare results, keep the winner | We delegate *different* tasks to agents; racing the *same* prompt with a compare-and-pick step is not a flow | 🟡 the compare/merge step is the gap |
| 3 | **Tabs, panes & split layouts** | Split tiles up to 12 rooms, remembered per project ([[split-room-slots]]) | ✅ have (arguably ahead) |
| 4 | **Session restore** — layout, panes and scrollback survive a restart | `PersistedProjectState` + two restore paths ([[per-project-persistence]]); terminal scrollback across app restart not persisted | 🟡 |
| 5 | **Quick Open / Jump Palette (⌘J)** — one search across worktrees, files, agents, commands, repo context | CommandPalette + FloatingSearch + titlebar search, but they're separate surfaces and don't index agents/worktrees | 🟡 unify |
| 6 | **Agent hibernation** — sleep idle agent sessions to reclaim memory | Sessions stay alive; `TerminalPane` must never unmount while its session lives ([[terminal-pane-lifetime]]) | ❌ |
| 7 | **Project groups** — group repos in the sidebar | Multiple projects per workspace, no grouping | ❌ low value |

## 2. Agents

| # | Orca feature | Spacron today | Verdict |
|---|---|---|---|
| 8 | **~30 CLI agents supported** (Claude Code, Codex, Grok, Cursor, Copilot, OpenCode, Amp, Antigravity, Pi, Kimi, Droid, Goose, Cline, Continue, Qwen, Rovo Dev…) + "any CLI agent" | **19 presets** as of 2026-08-10 (was 9), plus auto-detection of what's installed and signed in ([[agent-usage-meters]]) | ✅ have |
| 9 | **Agent hooks** — Orca writes hooks into the agent's own config to get honest status instead of guessing from the screen | We do exactly this: per-session append-only signal file the agent's hooks echo into (`src-tauri/src/commands/agent_signals.rs`) | ✅ have — same insight, independently |
| 10 | **Managed hook install/repair** — detect the agent CLI, install/upgrade its hooks, report presence | Hooks must be set up via the standing brief; no install/repair path ([[standing-brief-sources]]) | 🟡 |
| 11 | **First-work auto-rename** — branch, folder and workspace title generated from the agent's first real work | Worker naming is from a pool ([[worker-naming]]); nothing renames the branch to match the work | ❌ small, high delight |
| 12 | **Usage & rate-limit tracking + account hot-swap** — Claude/Codex/OpenCode usage bars, reset times, switch accounts without re-login | **Shipped 2026-08-10** — titlebar counter + popover + Settings detection table; Claude and Codex report live numbers ([[agent-usage-meters]]) | ✅ have (account hot-swap not built) |
| 13 | **Native chat UI** — a non-terminal chat pane against the agent | Terminal-only, plus the voice layer | ❌ deliberate divergence? |
| 14 | **Agent session history** — browse past sessions and transcripts | Scrollback only, no history browser | ❌ |
| 15 | **Honest idle / working / needs-you status** | `agent_signals` + turn detection ([[completion-announcements]], [[bell-osc-false-positives]]) | ✅ have |
| 16 | **Notifications + inbox with unread state** — mark a finished thread unread and come back to it | Toasts, desktop notifications, chime + chat card ([[completion-announcements]]), **plus the inbox — titlebar bell, unread badge, persisted read state** ([[agent-inbox-unread]]) | ✅ have — built 2026-08-10 |
| 17 | **Agents feed / activity view** | FleetDashboard ([[fleet-panel-placements]]) | ✅ have |
| 18 | **Agent memory across sessions** | `.spacron/memory/` is an agent convention, not a product feature | 🟡 |

## 3. Review & shipping

| # | Orca feature | Spacron today | Verdict |
|---|---|---|---|
| 19 | **Diff viewer** | ReviewPanel + HunkDiffView, two surfaces on purpose ([[review-panel-diff-layout]]) | ✅ have |
| 20 | **Annotate AI diff** — drop a markdown comment on any diff line, ship all comments back to the agent | Diffs are read-only; the reviewer verdict is APPROVED / BOUNCE BACK text ([[reviewer-verdict-signals]]) | ❌ **top pick** — the review loop already exists, this is the missing input device |
| 21 | **Commit & push in-app** | Full source control panel, commit grace window ([[commit-message-grace-window]], [[source-control-panel-layout]]) | ✅ have |
| 22 | **Attribution** — which lines came from which agent | Nothing | ❌ interesting, not urgent |
| 23 | **GitHub native** — PRs, issues, checks, project boards; open a worktree straight from an issue | Auth (device flow + gh import), repo list, create, clone ([[github-auth]]) — no PR/issue browsing | 🟡 **top pick** — auth is the hard half and it's done |
| 24 | **Linear / Jira / GitLab / Bitbucket / Azure DevOps / Gitea drawers** | Nothing | ❌ pick at most one (Linear) |
| 25 | **Worktree checkpoints** — snapshot and roll back a worktree | Workspace Snapshots panel exists; not per-worktree, not agent-triggerable | 🟡 |

## 4. Editing & viewers

| # | Orca feature | Spacron today | Verdict |
|---|---|---|---|
| 26 | Monaco + autosave everywhere | CodeMirror 6, 20+ languages, LSP, format, tabs | ✅ equivalent |
| 27 | Rich markdown editor (WYSIWYG) | Markdown *preview* via marked + dompurify | 🟡 |
| 28 | Mermaid / PDF / image viewers | Images yes; no Mermaid, no PDF | 🟡 cheap |
| 29 | File explorer + external drag-drop, drag files/images into a prompt | Explorer + drag-drop into the prompt bar + `AgentPanelImages` | ✅ have |

## 5. Browser & Design Mode

| # | Orca feature | Spacron today | Verdict |
|---|---|---|---|
| 30 | **Per-worktree embedded browser** | Preview proxy with tabs, device viewports, console, screenshot ([[preview-proxy]]) — one browser, not per-worktree | 🟡 |
| 31 | **Design Mode** — click an element in the live page, its HTML + CSS + a cropped screenshot go into the agent's prompt | **Already built** as "Add Element to Chat" — picker, selector, cropped screenshot, prompt bar, all wired. The payload was the only gap and it is now fixed ([[design-mode-element-prompt]]) | ✅ have — this row said "missing" in the first pass and was wrong |
| 32 | Browser-use profiles / user-agent switching | No | ❌ low value |

## 6. Terminal

| # | Orca feature | Spacron today | Verdict |
|---|---|---|---|
| 33 | Ghostty-class WebGL terminal, infinite splits | xterm + WebGL/canvas renderers, multi-pane ([[terminal-renderers]]) | ✅ have |
| 34 | **Scrollback that survives restart** | Scrollback buffer in-session only | 🟡 |
| 35 | **Warp / Ghostty theme import** — parse real `.yaml`/theme files | 20 app presets, but the terminal is always dark ([[terminal-is-always-dark]]) | ❌ cheap, and it's the one surface with no theming |
| 36 | Terminal search, quick commands | Search exists; no saved quick-commands | 🟡 |

## 7. Remote

| # | Orca feature | Spacron today | Verdict |
|---|---|---|---|
| 37 | **SSH worktrees** — agents on a remote box with full editing, git, terminals, auto-reconnect, port forwarding | Remote workspace shipped v0.6.0 (`docs/remote-workspace.md`, `src-tauri/src/remote/`) | ✅ have |
| 38 | **Headless server mode** (`orca serve` on a Linux box, browse to it) | No | ❌ |
| 39 | Remote-first latency discipline (defer visible loading ~200ms, keep focus stable) | Ad-hoc | 🟡 free to adopt |

## 8. CLI, automation & extensibility

| # | Orca feature | Spacron today | Verdict |
|---|---|---|---|
| 40 | **`orca` CLI** — `worktree create`, `snapshot`, `click`, `fill`; agents script the app itself | Agents drive Spacron through the in-process MCP server ([[mcp-architecture]]) — different transport, same idea. No shell CLI. | 🟡 |
| 41 | **Scheduled automations** — recurring per-agent tasks | Nothing | ❌ pairs with roadmap Phase 2 (the scheduler) |
| 42 | **Orchestration shipped as a skill** — Run / Tasks / Dispatches / supervised workers / decision gates, as a `SKILL.md` the agent reads | We have the orchestrator and the review loop ([[review-loop-design]]) but nothing packaged for the agent to read | 🟡 mostly a documentation artifact |
| 43 | **Skills registry** (8 bundled skills + MCP) | No | ❌ |
| 44 | **Plugins** — third-party sandboxed panels (`orca-plugin.json` + `panel.html`), incl. a deliberate hostile-panel test fixture | No plugin surface ([[security-trust-boundaries]] is the relevant constraint) | ❌ big |
| 45 | **Computer use** — agents drive desktop apps, with native helpers per OS | No | ❌ big, and a security cliff |

## 9. Mobile

| # | Orca feature | Spacron today | Verdict |
|---|---|---|---|
| 46 | **Mobile companion app** (iOS + Android) — QR pair, watch agent status, get finish notifications, send follow-ups | Remote relay exists (`remote_relay.rs`) but there is no phone app | ❌ big, and the single most-marketed thing they have |
| 47 | **Emulator pane** — drive Android devices/AVDs and iOS simulators | `commands/mobile.rs`: device list, AVD launch, screencap, tap, swipe, key, text; iOS simulators | ✅ have (don't confuse it with #46) |

## 10. Platform & polish

| # | Orca feature | Spacron today | Verdict |
|---|---|---|---|
| 48 | Crash reporting, telemetry with documented opt-out, hang watchdog, observability | No | ❌ (telemetry conflicts with our privacy posture — skip or make it strictly local) |
| 49 | i18n — app + README in 7 languages | English only | ❌ |
| 50 | Tray icon, configurable keybindings, native menus | Shortcuts customization ✅, no tray | 🟡 |
| 51 | Ports panel | Port auto-detection in preview | ✅ have |
| 52 | AI vault — secret storage agents can use | `secrets.rs` + EnvManager + keychain ([[security-audit]]) | ✅ have |
| 53 | Dictation / speech | Full voice layer: realtime orchestrator bridge, read-aloud, Parakeet/Whisper ([[voice-turn-taking]]) | ✅ **ahead of them** |

## 11. What Spacron has that Orca does not

Worth stating, because a feature-parity push can quietly erode these: the **voice layer**
(realtime conversation, read-aloud, voice-refined prompts), **20 wallpaper themes** and a
custom theme editor, **Split room tiling**, **DB explorer**, **HTTP client**, **containers
panel**, the **local music player**, the **knowledge-graph overlay**, **tasks kanban / notes /
quick-run / snapshots**, and **LSP diagnostics with a problems panel**. Orca is a fleet
cockpit; Spacron is a fleet cockpit *plus* a workbench.

---

## 12. The premium shortlist — chosen 2026-08-10

The brief for this pass was narrower than "reach parity": **which of Orca's features actually
make Spacron feel more premium, easier to use, and more coherent?** Most of the 53 don't —
they add surface area. Ten do, and they sort into three kinds of improvement.

Premium is not feature count. It is (a) never forcing the user out of the app mid-thought,
(b) the app always telling the truth about its own state, and (c) one obvious way to get
anywhere. Everything below is picked against one of those three.

### A. Close a loop that currently forces a detour

| # | Feature | The detour today → after |
|---|---|---|
| 31 | ~~**Design Mode bridge**~~ — **DONE 2026-08-10.** It turned out to be already built ("Add Element to Chat"); the picker, the cropped screenshot and the prompt-bar wiring all existed, and both inspectors were already collecting `outerHTML`, computed styles and attributes. `buildElementPrompt` was discarding all of it and sending `<button.primary> "Save"`. Now formatted properly in `src/lib/services/element-prompt.ts` (8 tests). See [[design-mode-element-prompt]] — including the two-inspector drift hazard. |
| 20 | **Diff annotations → agent** | Read the diff → switch to the prompt bar → re-describe which line you meant. After: comment on the hunk line, send the batch. The review loop already knows how to bounce work back ([[review-loop-design]], [[reviewer-verdict-signals]]); this gives the *human* the reviewer's channel. **Effort M.** |
| 23 | **Start work from a GitHub issue / PR** | Read the issue in a browser → copy the title → spawn an agent → paste. After: pick the issue, get a worktree + branch + agent already briefed. Auth is the hard half and it's done ([[github-auth]]). **Effort M.** |

### B. Make state legible — the app tells the truth, immediately

| # | Feature | Why it reads as premium |
|---|---|---|
| 12 | **Usage & rate-limit meters** | "Why did my agent stop?" is the most common mystery in agent work, and today Spacron cannot answer it. Per-agent usage bars with reset times answer it *before* it's asked. Self-contained, visible every session. **Effort M.** |
| 11 | **First-work auto-rename** | Branch, folder and room title generated from the agent's first real work, replacing pool names ([[worker-naming]]). The fleet list stops reading `agent-7 / feature-xyz-2` and starts reading like a to-do list. Small change, disproportionate effect on scanability. **Effort S–M.** |
| 16 | ~~**Notification inbox with unread**~~ | **DONE 2026-08-10.** Cheaper than the M estimate: `AgentMailboxCards` / `MailboxCard` / `AgentNotifications` and a `dismissMailboxCard` action already existed, so the card list, its rendering and its dismiss verb were all there. What was actually missing was narrow — dismissal was `useState`, so it died on remount, and there was no unread flag or persistence. Now a titlebar bell + badge, a popover list, and read/dismissed state persisted per project. The load-bearing distinction: **an auto-dismissed card is not a read card**. See [[agent-inbox-unread]]. |
| — | **Their in-flight feedback discipline** (not a feature — a rule) | 0–100 ms: nothing · 100 ms–1 s: disabled only · 1–3 s: spinner or label swap · 3 s+: named stages. Pre-reserve the width a control will grow into. Bind *disabled* immediately, *visible* loading on a ~200 ms timer. This **is** roadmap Phase 3 and the `console.error`-only failures listed under "not touched" in [[premium-feel-fixes]]. Zero new surface area, pure feel. **Effort M, spread.** |

### C. One obvious way to get anywhere

| # | Feature | Why |
|---|---|---|
| 5 | **Unified jump palette (⌘J)** | Today there are three separate find surfaces — CommandPalette, FloatingSearch, titlebar search — and none of them indexes agents or worktrees. One palette over worktrees + agents + files + commands, with a "jump to whoever needs you" binding. This is the clearest "the UI doesn't make sense" item in the app. **Effort M.** |
| 6 | **Agent hibernation** | The app should stay fast at eight agents. Sleep idle sessions, wake on focus. Pairs with Phase 2's ceiling + queue and its "2 running · 1 queued" indicator. Needs care against [[terminal-pane-lifetime]]. **Effort M–L.** |
| 35 | **Terminal theme import** (Warp / Ghostty) | The terminal is the largest visual surface in the app and the only unthemed one ([[terminal-is-always-dark]]). Parsing real theme files is a contained parser job with an outsized payoff. **Effort S–M.** |

### Convergent signal worth noting

Orca's #11 (work-derived titles on every row) and CNVS's "Shorthand" release
([[premium-theming-spec]]) independently arrived at the same conclusion: **an agent row must
say what the agent is doing, not what tool it is running.** Two competitors solving the same
problem the same way is the strongest evidence in this document.

### Deliberately excluded from this shortlist

Mobile companion, plugins, computer use, i18n, native chat, a second issue-tracker drawer,
telemetry, project groups, browser profiles, headless server. All are real features; none of
them makes the existing product feel better to the person already using it. The 30-agent
registry (#8) is *cheap* and helps adoption, but it is a marketing number, not a premium
improvement — do it when convenient, not as part of this pass.

### Suggested sequence

1. **Design Mode bridge** — biggest payoff, smallest new surface, all three parts already exist.
2. **First-work auto-rename** — one day of work that changes how the sidebar reads all day.
3. **Feedback discipline pass** (roadmap Phase 3) — do it *before* adding more surfaces, so the
   new ones inherit the rule instead of needing a retrofit.
4. **Diff annotations** — completes the review loop.
5. **Unified ⌘J palette** — collapses three surfaces into one.
6. **Usage meters** → ~~7. **Notification inbox**~~ (done, out of order — it turned out to be
   the smallest item on the list once the existing card components were counted) →
   8. **Terminal theme import** → 9. **GitHub issues** → 10. **Hibernation** (with Phase 2).

---

## Recommended order

Ranked by value ÷ effort against the code we already have, not by what Orca markets hardest.

**Tier 1 — build these next (each is days, not weeks, and each rides on existing code)**

1. **Design Mode bridge** (#31). We have the DOM inspector, the screenshot path and the prompt
   bar. Add: "send this element to agent X" → serialize outerHTML + computed CSS + a cropped
   screenshot into the prompt. This is joining three things we own.
2. **Diff annotations → agent** (#20). Comment on a hunk line in `HunkDiffView`, collect the
   comments, send them as one message to the owning agent. The review loop already knows how to
   bounce work back ([[reviewer-verdict-signals]]); this gives the human the same channel.
3. **Usage & rate-limit meters** (#12). Read Claude/Codex usage, show per-agent bars in the
   status bar with reset times. Self-contained, visible every single session.
4. **Expand the agent registry** (#8). Turning the current **9** presets (`AI_AGENT_PRESETS`
   in `src/lib/stores/runs.ts`: claude, codex, agy, opencode, pi, omp, agent/Cursor, hermes,
   grok) into ~25 is a data edit in [[agent-spawn-picker]] plus a detection probe
   (`agent_probe.rs` already exists). Note the real per-preset cost: every entry also wants a
   brand mark in `agentBrands.tsx`, so this is 25 logo hunts, not 25 rows.
5. **Terminal theme import** (#35). Parse Warp/Ghostty theme files. The terminal is our only
   unthemed surface, and it's the surface users stare at.

**Tier 2 — clear wins, a week each**

6. **Unified jump palette** (#5) — one ⌘J across worktrees, agents, files, commands.
7. **GitHub PRs & issues in-app** (#23), with "start a worktree from this issue". Auth is done.
8. **First-work auto-rename** (#11) — branch/folder/title from the agent's first real work.
9. **Race one prompt across N agents** (#2) — a spawn mode plus a compare-and-keep step.
10. ~~**Notification inbox with unread** (#16)~~ — **DONE 2026-08-10**, see §12.

**Tier 3 — real projects, decide deliberately**

11. Scheduled automations (#41) — do this *with* roadmap Phase 2 (the scheduler), not before.
12. Agent hibernation (#6) — needs care against [[terminal-pane-lifetime]].
13. Session history browser (#14), worktree checkpoints (#25), scrollback persistence (#34).
14. Mobile companion (#46) — the biggest single feature here; a whole second app.
15. Plugins (#44), computer use (#45), headless server (#38), i18n (#49).

**Don't build:** browser profiles (#32), project groups (#7), telemetry (#48), and more than
one issue-tracker drawer (#24). Native chat (#13) is a genuine fork in the road — our answer to
"I don't want to type in a terminal" is voice, and that's a better answer.

---

## On open-sourcing

Recorded here because it changes the cost of half this list, not to settle it.

- Orca is MIT and free, ~24k stars, and is funded by its parent company. That model works when
  something else pays for the engineering.
- Our current position is closed-source with a one-time fee ([[licensing-and-docs]],
  [[open-source-decision]] — decided 2026-07-20).
- **The concrete engineering argument for going open:** several Tier-2/3 items (Warp theme
  parser, hook installers, usage meters, the CLI) exist in Orca's MIT tree and could be adapted
  rather than written. MIT allows that in a closed product too, as long as the notice ships —
  so open-sourcing is *not* required to take the code. It buys contributors and trust, not
  legal permission.
- **The argument against:** a one-time fee is much harder to defend once the source is public
  and a free competitor with 24k stars is one search away. If we do open-source, the money has
  to come from somewhere else first.

Nothing in the Recommended order depends on this decision, so it doesn't block anything.
