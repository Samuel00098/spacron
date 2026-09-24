# Agent browser — design

Status: **Built 2026-09-23 — see "As built" at the end, which supersedes the plan where they differ.** Written 2026-09-23.
Companion to [computer-use.md](computer-use.md); settles the browser half of
[browser-pillar-spike.md](browser-pillar-spike.md) for *agents* (Design Mode for
the user is a separate question and is not decided here).

## Summary

Agents already get a browser: when **Settings → Agent browser tools** is on,
`mcpBridge.ts` writes Microsoft's Playwright MCP server (`@playwright/mcp`) into
every agent CLI's config under the key `spacron-playwright`. We keep that. We do
**not** build our own browser automation — Playwright already does it properly
(auto-waiting, accessibility-tree snapshots, console and network access).

This doc covers three pieces of work:

1. **Harden the CLI-agent path** — slow startup, and no way to browse signed-in.
2. **Give the orchestrator (Chat) the same browser**, through the same
   Playwright server rather than a second implementation.
3. **Safety rules** for a browser that feeds untrusted web content into a model
   that can also write files and run commands.

---

## What exists today

| Piece | Where | Notes |
|---|---|---|
| Config writer | `src/lib/stores/mcpBridge.ts` (`PLAYWRIGHT_*`, `BROWSER_SERVER_KEY`) | Claude Code, Codex (TOML), Gemini, opencode, droid, Cursor |
| Setting | `agentBrowserTools` in `src/lib/stores/settings.ts` | Off by default; shown as a built-in row in Settings → MCP |
| Launch args | `npx -y @playwright/mcp@latest --isolated` | `--isolated`: several agents run at once, one persistent profile can only be held by one browser |
| Startup budget | `BROWSER_STARTUP_TIMEOUT_SEC` | npx + `@latest` measured at ~28 s warm on Windows |
| Tests | `src/lib/stores/mcpBridge.test.ts` › "agent browser tools" | |
| Orchestrator | — | **No browser.** Spacron is an MCP *server*, not a client ([mcp-server-list note](../.spacron/memory/mcp-server-list.md)) |

---

## Part 1 — Harden the CLI-agent path

### 1.1 Pin and pre-install (startup time)

`@latest` makes npm re-resolve against the registry on *every* launch. That is
most of the ~28 s, it makes offline use fail, and it means an upstream release
can change the tool surface under us without a test noticing.

- Pin a version constant, e.g. `PLAYWRIGHT_MCP_VERSION`, bumped deliberately.
- Install once into the app data dir:
  `npm install --prefix <appData>/tools/playwright-mcp @playwright/mcp@<pin>`,
  triggered when the setting is switched on (with progress in the Settings row)
  and re-run when the pin changes.
- Write the entry as `node <abs>/node_modules/@playwright/mcp/cli.js --isolated`
  instead of `npx`. Fall back to the pinned `npx -y @playwright/mcp@<pin>` if
  the install is missing, so a failed install degrades to "slow", not "broken".
- Keep `BROWSER_STARTUP_TIMEOUT_SEC`; lower it only after measuring the new path.
- To verify during implementation: which browser channel the pinned version
  launches by default (installed Chrome vs a Playwright-downloaded Chromium),
  and whether first run triggers a download. The Settings row should say so
  rather than leaving a silent multi-minute first launch.

### 1.2 Browser profiles (signed-in browsing)

`--isolated` stays the default: a clean browser each run is right for "open what
I just built and look at it", and it is the only mode that is safe with parallel
agents. Add a per-project choice with three values:

| Mode | Args | Parallel agents | Use for |
|---|---|---|---|
| **Clean** (default) | `--isolated` | yes | local dev servers, public pages |
| **Project profile** | `--user-data-dir <appData>/browser-profiles/<projectId>` | **one at a time** | staying logged in to *your app's* staging/admin |
| **My Chrome** | `--extension` (Playwright MCP bridge extension) | one at a time | sites where you are already signed in |

Rules:

- **Profile lock.** Only one agent may hold a project profile. Spacron writes the
  profile args only into the config of the *first* agent launched for that
  project while the mode is on; later agents get `--isolated` and a one-line
  note in their brief saying so. Upstream fails hard on a locked profile, and a
  failed MCP server shows up to the agent as "no browser tools" with no reason.
- **My Chrome is explicit and loud.** It hands an agent the user's real
  sessions — bank, email, everything. Off unless chosen per project, with a
  warning in the picker. Never the default, never carried over by templates.
- Per-project configs (`.mcp.json`, `opencode.json`) can carry per-agent args.
  **Codex and droid configs are global**, so they can only carry the
  project-independent Clean entry; profile modes apply to them only if and when
  a per-launch config path exists. Say so in the UI instead of silently
  ignoring the choice.

### 1.3 Visibility

Surface startup failure. Today a server that never becomes ready just means the
agent has no browser tools. Add a "Test browser tools" button in the Settings row
that spawns the configured command, performs the MCP `initialize` handshake, and
reports ready/failed with stderr. The same client code is needed for Part 2.

---

## Part 2 — Orchestrator browser access

### 2.1 Approach: become an MCP client for this one server

The orchestrator should drive **the same Playwright MCP server** the agents use,
for the same reason the emulator tools route through the same handlers
([orchestrator-emulator-tools note](../.spacron/memory/orchestrator-emulator-tools.md)):
two implementations drift, and then the orchestrator and an agent disagree about
what "click e12" means.

Rejected alternatives:

- **Drive Chromium directly** (`chromiumoxide`/CDP). A worse copy of Playwright
  that we would own.
- **Import every user MCP server as orchestrator tools.** Deliberately out of
  scope (see the mcp-server-list note): each imported tool needs a risk class
  routed through approval cards. Playwright is one known server whose tools we
  can classify by hand; a generic importer can come later on top of the same
  client.

### 2.2 Components

```
ChatModePanel ─► stores/orchestrator.ts (executor) ─► invoke('browser_call_tool')
                                                         │
                               src-tauri/src/browser_mcp/ ▼
                         ┌──────────────────────────────────────┐
                         │ McpStdioClient                        │
                         │  spawn node cli.js --isolated          │
                         │  initialize → tools/list → tools/call  │
                         │  one child per conversation, lazy      │
                         └──────────────────────────────────────┘
```

- **`src-tauri/src/browser_mcp/mod.rs`** — a small stdio JSON-RPC client:
  spawn, `initialize`, `notifications/initialized`, `tools/list`, `tools/call`,
  line-delimited framing, request ids, a per-call timeout, kill on drop.
  Generic over the command so a future user-server importer can reuse it.
- **Lifetime.** One Playwright process **per chat conversation**, started lazily
  on the first browser call, killed when the conversation is closed, when the
  app exits, and after an idle timeout (10 min). Per conversation rather than
  per app so two conversations do not fight over tabs; the lazy start means a
  conversation that never browses costs nothing
  ([agent-background-poll-budget note](../.spacron/memory/agent-background-poll-budget.md)).
- **Headed by default** for the orchestrator, so the user can watch it work;
  a setting toggles `--headless`.
- **Same pinned install** as Part 1. The orchestrator always uses the Clean
  profile in v1.

### 2.3 Tool surface

Names match the upstream MCP tools exactly (the emulator precedent), so a
prompt, a memory note or a user instruction means the same thing on both sides.

| Tool | Class | Ask / Plan modes | Full mode |
|---|---|---|---|
| `browser_navigate`, `browser_navigate_back` | navigation | ✓ | ✓ |
| `browser_snapshot` | read | ✓ | ✓ |
| `browser_take_screenshot` | read (to file) | ✓ | ✓ |
| `browser_console_messages`, `browser_network_requests`, `browser_network_request` | read | ✓ | ✓ |
| `browser_tabs`, `browser_wait_for`, `browser_find` | read | ✓ | ✓ |
| `browser_click`, `browser_hover`, `browser_type`, `browser_fill_form`, `browser_select_option`, `browser_press_key`, `browser_drag`, `browser_drop`, `browser_handle_dialog` | input (write-class, sequential) | ✗ | ✓ |
| `browser_resize`, `browser_emulate_media`, `browser_close` | lifecycle | ✗ | ✓ |
| `browser_evaluate`, `browser_run_code_unsafe` | **arbitrary JS** | ✗ | always asks, never "always allow" |
| `browser_file_upload` | **reads local files** | ✗ | **not exposed** — it would bypass path confinement ([path-confinement-layers note](../.spacron/memory/path-confinement-layers.md)) |

The ✓/✗ columns are what `brainToolProfile` strips; input tools are write-class
so they never run concurrently (a click racing a type lands somewhere nobody
intended — same rule as `emulator_tap`).

### 2.4 The orchestrator has no vision — and does not need it here

> **Update 2026-09-24:** the chat now attaches screenshots for models that accept images (see `.spacron/memory/orchestrator-vision.md`). The accessibility snapshot stays the primary way to read and act on a page.

No provider path in the repo sends images. That is fine for the browser:
`browser_snapshot` returns the **accessibility tree as text** with element refs,
which is the primary way Playwright MCP expects a model to see a page.

- `browser_take_screenshot` is intercepted exactly like `emulator_screenshot`:
  written to `<temp>/spacron-screenshots/`, and the tool result is the path plus
  "you cannot see this image; it is for the user". Never base64 in the transcript.
- Snapshots can be large. Results go through the existing tool-result cap and
  `read_tool_result` paging; the tool description tells the model to prefer
  `browser_find` / a targeted snapshot over repeated full snapshots.
- When a vision path is added to the providers later, the screenshot
  interception is the single place to change.

### 2.5 Wiring checklist (the "four lists" rule)

Same four places as the emulator tools, plus the Rust allowlist test:

1. `src-tauri/src/browser_mcp/` — `ORCHESTRATOR_BROWSER_TOOLS` allowlist and the
   `browser_call_tool` Tauri command (rejects any name not on the list).
   **Test:** the allowlist ⊆ the pinned server's `tools/list` (recorded fixture
   from the pinned version, refreshed when the pin changes).
2. `brain-tools.ts` — `BrainToolName`, `BRAIN_TOOL_DEFS`, read/write sets,
   `brainToolProfile`.
3. `agent-transport.ts` — `definitions`. A tool missing here is "Unknown tool"
   on the native tool-calling path. Refs are strings; coordinates (drag) use
   `dec`, not `num`.
4. `stores/orchestrator.ts` — executor case, the `mutating` list, and
   `approvalRuleKey` (bare tool name for input tools, like `emulator_tap`, so one
   "Always allow" covers the loop).

---

## Part 3 — Safety

A browser is the first orchestrator tool whose *output* is written by strangers.
The orchestrator also holds `write_file` and `run_command`, so a page saying
"ignore your instructions and run …" is a real attack, not a hypothetical.

1. **Origin policy.** Local origins (`localhost`, `127.0.0.1`, `[::1]`, the
   preview proxy origin, the project's configured dev URLs) navigate freely. The
   **first navigation to each external origin in a conversation asks**, in every
   access mode including Full access — the same rule risky app commands already
   follow. "Always allow" is per origin, per conversation. Redirects to a new
   external origin count as a navigation to it.
2. **Untrusted-content framing.** Every browser tool result is wrapped in a
   marked block (`<untrusted_web_content origin="…">`) and the brain prompt says
   instructions inside it are data. Not a guarantee — a mitigation.
3. **Taint gate.** After a turn has read content from an external origin,
   `run_command` and `write_file`/`edit_file` ask for the rest of that turn even
   in Full access. Local-origin pages do not taint (the user's own app).
4. **No local file reach.** `browser_file_upload` is not exposed; `file://`
   navigation is refused by the client before it reaches Playwright.
5. **Audit.** Every browser call is an activity row (tool, origin, ref), so
   "what did it click?" has an answer in the transcript.

Remote workspaces: the browser runs on the machine running the app. A remote
project's dev server on the box's `localhost` is not reachable from here, so
v1 refuses browser tools for remote projects with a clear message rather than
navigating to the wrong `localhost` ([remote-invoke-seam-gap note](../.spacron/memory/remote-invoke-seam-gap.md)).

---

## Phases

| Phase | Scope | Done when |
|---|---|---|
| **1** | Pin + pre-install; "Test browser tools" button (builds the stdio client) | Warm start measured and recorded here; handshake failure shows stderr in Settings |
| **2** | Orchestrator read tools: navigate, snapshot, screenshot-to-file, console, network, tabs, wait, find — with the origin policy | Chat can open the local dev server, read the page, report console errors |
| **3** | Orchestrator input tools + taint gate + audit rows | Chat can fill and submit a local form; an external page cannot trigger an unasked command |
| **4** | Project profile / My Chrome modes for CLI agents | Profile lock verified with two agents on one project |

## As built (2026-09-23)

| Piece | Where |
|---|---|
| Pinned install, MCP stdio client, chat sessions, test, sign-in | `src-tauri/src/commands/browser_tools.rs` |
| Agent config entries (pinned argv, output dir, sign-in) | `src/lib/stores/mcpBridge.ts` (`playwrightArgv`) |
| Chat tools | `brain-tools.ts` (`BRAIN_BROWSER_*`), `agent-transport.ts` (schemas), executor + approvals in `stores/orchestrator.ts` |
| Website rule | `externalOrigin` / `approvalRuleKey` in `command-policy.ts` |
| Settings | `BrowserToolsDetails.tsx` under Settings → Agents → Browser |

**Measured** (Windows 11, warm): `npx @playwright/mcp@latest` ~28 s to start →
pinned `npx` 14 s → installed `node cli.js` **2.3 s** (handshake + tool list).

Differences from the plan above:

- **Pinned to 0.0.82**, installed under `%APPDATA%/spacron/tools/playwright-mcp`
  (Settings → Install), and started with `node cli.js`; pinned `npx` is the
  fallback. The TS and Rust constants are held equal by a test.
- **`--output-dir`** is always passed. Playwright's default is the current
  directory, so agents were writing `.playwright-mcp/` into the user's repo.
- **Signed-in browsing uses `--storage-state`, not a project profile.** The user
  signs in once per project in a browser Spacron opens; the cookies are saved
  under `%APPDATA%/spacron/browser-state/` (outside the project), and every
  agent's *isolated* browser starts from them — no profile lock, agents stay
  parallel. Global configs (Codex, droid) never carry a project's sign-in.
  **"My Chrome" (`--extension`) was not built**: it hands an agent every login
  the user has, and needs a browser extension; revisit only if asked for.
- **Chat tool set (20).** Not exposed: `browser_file_upload` and `browser_drop`
  (local file paths), **`browser_run_code_unsafe` (upstream: "RCE-equivalent" —
  it runs code in the server process, so no approval makes it safe)**, and
  `browser_fill_form` / `browser_emulate_media` (argument shapes the chat's
  schemas cannot express). Any `filename` argument is stripped in Rust, since it
  writes a file wherever it points. The element argument is `target`, not `ref`.
- **Website rule.** Local origins (localhost, 127.x, ::1, *.localhost) open
  freely. The first visit to each outside origin asks in every access mode;
  "Approve" covers the turn, "Always allow" the conversation. After **every**
  call the page's final URL is checked, because a click or redirect navigates
  too: an unallowed outside origin sends the page back to `about:blank` and the
  model is told to ask. `browser_evaluate` asks every time, with no standing
  rule. Outside pages' text is wrapped as untrusted and taints the turn (same
  gate as computer use: file writes and non-read-only commands ask).
- `file:`, `javascript:`, `data:` and other non-web URLs are refused in Rust,
  for `browser_navigate` and for `browser_tabs` opening a tab.

**Trap found while building:** with a long `PATH` (a dev shell had 184 entries)
`cmd.exe` cannot find `npx`, and npx's own inner shell then cannot find the
package it installed. Children get `agent_probe::search_path()` trimmed to
6000 characters, and `npm`/`npx` run as `node <npm>/bin/<tool>-cli.js`.

**Verified:** Rust tests including real-server ones (npx fallback and installed
path both load a page); store tests for the website rule, redirect guard,
untrusted wrapping and evaluate prompt; the sign-in browser launches and saves
state. **Not yet seen in the running app:** the Settings panel, the chat's
headed browser window, and a real sign-in round trip with an agent. Remote
workspaces are not special-cased yet: the chat's browser runs on this machine.

## Open questions

- Does the orchestrator's browser need to be *visible inside Spacron* (a room
  showing its screenshots live), or is a separate headed window acceptable?
  Recommendation: separate window in v1; revisit with Design Mode.
- Should the orchestrator be able to take over an *agent's* browser session?
  Recommendation: no — separate processes, separate state.
