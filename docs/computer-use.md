# Computer use — design

Status: **DESIGN — not started.** Written 2026-09-23.
Companion to [agent-browser.md](agent-browser.md). Settles the "control my
laptop" pillar that [browser-pillar-spike.md](browser-pillar-spike.md) split off
and [orca-feature-gap.md](orca-feature-gap.md) #45 lists as "big, and a security
cliff".

## Summary

Let agents — CLI agents *and* the orchestrator — see and operate desktop
applications: list windows, read what is on screen, click, type, press keys,
scroll. Built natively in Rust inside the Tauri app; **no Electron move** (Orca
is Electron and still needed native helpers per OS for this).

The feature is modelled on the **emulator tools**, which already solve the same
shape of problem for a phone screen: one set of Rust handlers, served to CLI
agents over `spacron-mcp` and called in-process by the orchestrator, with
normalized coordinates and screenshots written to files.

What makes it different from the emulator is that the target is the **user's
real machine**. The consent model, scope boundary and kill switch below are not
polish — they are the feature, and they land before any input tool ships.

Scope: **Windows first** (the development machine). macOS is phase 5. Linux is
not planned (Wayland blocks input synthesis by design).

---

## Tool surface

All names are prefixed `desktop_`, served identically to CLI agents (MCP) and
the orchestrator (in-process).

### See

| Tool | Args | Returns |
|---|---|---|
| `desktop_list_windows` | — | visible top-level windows: `id`, title, process name, bounds, focused. Spacron's own windows are omitted. |
| `desktop_ui_tree` | `window`, optional `depth`, `filter` | the window's **UI Automation tree as text**: role, name, value, state, and a short ref (`e12`) per element. Password-field values are always redacted. |
| `desktop_screenshot` | `window` (or `screen: true`) | CLI agents: the image (MCP image content). Orchestrator: a file path (see "No vision"). |
| `desktop_find` | `window`, `text` or `role` | refs of matching elements, so the model does not pull the whole tree to find one button |

### Act

| Tool | Args | Notes |
|---|---|---|
| `desktop_click` | `window` + (`ref` \| `x`,`y`), `button`, `double` | `ref` preferred: uses UIA `InvokePattern`/`TogglePattern`/`SelectionItemPattern` when the element supports it (no pointer move needed, immune to DPI and overlap), else a synthesized click at the element's centre. `x`,`y` are **normalized 0–1 within the window**, like `emulator_tap`. |
| `desktop_type` | `window`, optional `ref`, `text` (≤ 4096 chars) | `ref` + `ValuePattern` sets the value directly when possible; else focus + synthesized keystrokes. Refused on password fields. |
| `desktop_key` | `window`, `keys` (e.g. `ctrl+s`, `enter`) | Refuses a small blocklist: `win+l`, `ctrl+alt+del`, `alt+f4` on windows it was not granted, and the kill-switch combo. |
| `desktop_scroll` | `window`, optional `ref`, `dx`,`dy` | `ScrollPattern` when available |
| `desktop_drag` | `window`, from/to (ref or normalized x,y) | |
| `desktop_focus_window` | `window` | brings a **granted** window to the foreground |

Deliberately **not** included in v1: launching applications (agents already have
`run_command`/shell for that, with their own approval path), clipboard read
(silent exfiltration channel), and whole-screen input without a window.

### Why window-relative, ref-first

- **DPI.** The removed native preview overlay failed at 125%/150% scaling
  because pixel maths was done in the wrong space
  ([browser-pillar-spike.md](browser-pillar-spike.md), "Bounds and DPI").
  Refs resolved through UIA never touch pixels, and window-relative normalized
  coordinates are converted in exactly one place in Rust with per-monitor DPI.
- **Scope.** Every input call names a window, so the grant check (below) is a
  lookup, not a guess about what is under a pixel.
- **Reliability.** Patterns act on the element, not on whatever happens to be
  painted at a coordinate this frame.

---

## Architecture

```
CLI agent ──MCP──► spacron-mcp (mcp/mod.rs) ─┐
                                              ├─► desktop::handlers ─► grants / lease ─► platform backend
Chat ──invoke('mcp_call_desktop_tool')───────┘        (one copy)                         (Windows: UIA, xcap, SendInput)
```

- **`src-tauri/src/desktop/`**
  - `mod.rs` — the handlers, argument parsing, and `ORCHESTRATOR_DESKTOP_TOOLS`.
  - `grants.rs` — consent state and the scope check (below).
  - `lease.rs` — the single input lease.
  - `windows.rs` — backend: window enumeration (`EnumWindows`), UI Automation
    (`IUIAutomation` via `windows-rs`; new features: `Win32_UI_Accessibility`,
    `Win32_UI_Input_KeyboardAndMouse`, `Win32_UI_WindowsAndMessaging`,
    `Win32_UI_HiDpi`), input (`SendInput` directly, or `enigo`), capture (`xcap`).
  - `macos.rs` — phase 5 (AX API, `CGEvent`, ScreenCaptureKit).
- **`mcp/mod.rs`** — registers the `desktop_*` tools and routes to
  `desktop::handlers`, passing the caller's agent identity (from its
  `agent_token`) so grants are per agent.
- **`call_desktop_tool`** — the in-process entry for the orchestrator, same
  pattern as `call_emulator_tool`: same handlers, JSON-RPC envelope unwrapped,
  screenshot intercepted to a file.
- **UI** — the grant card, the control indicator, the kill switch, and the
  Settings section. Frontend in `src/lib/components/…` and a small store.

Only `src-tauri` changes are platform-specific; everything above the backend
trait is shared.

---

## Safety model

An agent that can synthesize input can click anything, including Spacron's own
approval buttons, a password manager, or "Send" in the user's email. The model
below is designed to stay safe **even if the agent is adversarial** (for example
after reading a prompt-injected web page or document).

### 1. Off by default, two locks

- **Global setting** `Allow computer use` (Settings → Agents). Off by default.
  While off, the `desktop_*` tools are **not registered at all**: not in MCP
  `tools/list`, not in the orchestrator's tool defs. An agent cannot ask for
  something it cannot see.
- **Per-session grant.** Even with the setting on, the first `desktop_*` call
  from an agent session or chat conversation raises a **grant card** in Spacron
  (and an inbox entry + soft chime for background agents, styled per the
  [notification-card-design note](../.spacron/memory/notification-card-design.md)).
  The call blocks until the user answers or 120 s pass (then it fails with "not
  granted", which the agent sees as a normal tool error).

### 2. The grant is scoped to windows

The card shows the agent's name, the reason it gave (a required `reason` arg on
the first call), and a window picker:

- **This window only** (default): the window the agent asked for.
- **These windows**: multi-select from `desktop_list_windows`.
- **Read only**: see tools allowed, act tools refused.

Duration: **this turn** (default for the orchestrator) or **this session /
conversation**. Never "forever", and grants never persist across app restarts.

A grant binds to `(window handle, process id, process image path)`. If the
window closes, the grant is gone; a new window from the same app needs a new
grant. **Every** act call re-checks, just before input is injected, that:

1. the target window is granted to *this* caller;
2. it is the foreground window (after `desktop_focus_window` if needed) — if
   focus was stolen, the call fails instead of typing into whatever took focus;
3. for coordinate clicks, the window at that screen point (`WindowFromPoint`,
   root owner) *is* the target — so a popup from another app lying on top
   cannot receive the click.

**Full access does not skip the grant.** It is the same rule risky app commands
already follow: the user chose a click before these run.

### 3. Never-targetable

Refused regardless of grants, and filtered out of `desktop_list_windows`:

- **Spacron's own windows** (by process id) — otherwise an agent could approve
  its own cards.
- Credential and security surfaces: Windows Security, credential prompts
  (`CredentialUIBroker`), Task Manager, `consent.exe`, and a user-editable
  process denylist (password managers pre-filled).
- UAC and the secure desktop are unreachable by design; that stays true.

Password fields (UIA `IsPassword`) are never typed into and their values are
never returned.

### 4. One controller at a time

There is one mouse and one keyboard focus. An app-wide **input lease**:

- the first act call takes it; it is held until the grant ends or 30 s pass
  with no act call;
- a second agent's act call fails fast with "the computer is being controlled by
  <agent>" (it can retry); see tools do not need the lease;
- the lease holder is shown in the control indicator.

### 5. Visible and stoppable

- **Control indicator** while a lease is held: a click-through, always-on-top
  border around the granted window and a small banner, "<agent> is controlling
  <window> — Ctrl+Alt+Esc to stop".
- **Kill switch**: a global hotkey (default `Ctrl+Alt+Esc`, rebindable) that
  revokes *every* grant and releases the lease immediately. Also a Stop button on
  the banner and on the grant's activity row.
- **User takes over**: real (non-injected) mouse or keyboard input from the user
  while a lease is held pauses control for 5 s and fails in-flight act calls
  with "the user is using the computer". Detected with low-level hooks that
  check the `LLMHF_INJECTED` / `LLKHF_INJECTED` flags. The user should never
  have to fight an agent for the mouse.
- **Rate limit**: at most ~10 act calls per second per caller; bursts beyond
  that fail. Keeps a runaway loop from outpacing the user's reaction time.

### 6. Audit

Every act call is an activity row (orchestrator) or an agent-activity entry
(CLI agents): tool, window title, ref or coordinates, and for clicks a small
before-screenshot saved to the temp screenshot dir. "What did it click?" always
has an answer.

### 7. Untrusted screen content

Text from `desktop_ui_tree` is data written by whatever app is on screen,
including web pages and emails. Results are wrapped as untrusted content, and the
orchestrator's taint gate from [agent-browser.md](agent-browser.md) §3 applies:
after reading a window of another app, `run_command` and file writes ask for the
rest of the turn.

### Remote workspaces

Desktop tools act on the machine running the Spacron app. A CLI agent running on
a remote workspace box must not be able to drive the user's laptop through the
relay, so the tools are refused for callers whose session is remote
([remote-invoke-seam-gap note](../.spacron/memory/remote-invoke-seam-gap.md)).

---

## Orchestrator access

### No vision: the UI tree is its eyes

No provider path in this repo sends images to the model
([orchestrator-emulator-tools note](../.spacron/memory/orchestrator-emulator-tools.md)).
So for the orchestrator:

- `desktop_ui_tree` / `desktop_find` are how it *sees*. Most native Windows apps,
  Office and Electron apps expose a usable UIA tree. Games, canvas-heavy apps and
  some custom-drawn UIs do not; for those the orchestrator should say it cannot
  see the window rather than click blind.
- `desktop_screenshot` is intercepted like `emulator_screenshot`: written to
  `<temp>/spacron-screenshots/`, result is the path plus "you cannot see this;
  it is for the user". Never base64 in the transcript.
- CLI agents (Claude Code etc.) *do* have vision, so over MCP the screenshot
  returns real image content.
- Adding a vision path to the providers later would make coordinate clicking
  useful for the orchestrator too; the screenshot interception is the one place
  to change.

### Wiring (the "four lists" rule)

1. `desktop/mod.rs` — `ORCHESTRATOR_DESKTOP_TOOLS` and the match in
   `call_desktop_tool`; Rust test that the allowlist matches the served tools
   (copy of `orchestrator_allowlist_matches_the_served_emulator_tools`).
2. `brain-tools.ts` — `BrainToolName`, `BRAIN_TOOL_DEFS`, read/write sets,
   `brainToolProfile`: **ask/plan modes get the see tools only; act tools only in
   Full/Default**, and all of them only when the global setting is on.
3. `agent-transport.ts` — `definitions` (coordinates use `dec`, not `num`, or
   every non-corner click is rejected).
4. `stores/orchestrator.ts` — executor case; act tools in the `mutating` list;
   the grant card replaces the normal approval card for `desktop_*` (the grant
   *is* the approval), so `approvalRuleKey` "always allow" does not apply to
   them.

Act tools are write-class, so they run sequentially — the same reason
`emulator_tap` is.

---

## Phases

| Phase | Scope | Done when |
|---|---|---|
| **0 — Spike** (½ day, throwaway branch) | enumerate windows, UIA tree of Notepad, `InvokePattern` a button, `SendInput` a click at 100% and 150% scaling, capture a window | all five work on Windows 11; numbers noted here |
| **1 — See** | `desktop_list_windows`, `desktop_ui_tree`, `desktop_find`, `desktop_screenshot`; setting; grant card (read-only grants); never-targetable filter | an agent can describe what is in a granted Notepad window; Spacron's windows never appear |
| **2 — Act** | click/type/key/scroll/drag/focus; window-scoped grants; foreground + hit-test checks; lease; indicator; kill switch; user-takeover pause; rate limit; audit | an agent edits and saves a file in Notepad; the kill switch stops it mid-type; a second agent is refused the lease |
| **3 — Orchestrator** | the four lists; screenshot-to-file; taint gate | Chat completes the Notepad task through the UI tree only |
| **4 — Hardening** | denylist editor, grant history in the inbox, per-app notes on UIA coverage | — |
| **5 — macOS** | AX API, `CGEvent`, ScreenCaptureKit; Accessibility + Screen Recording permission onboarding | parity with phase 3 on macOS |

Security review (per [SECURITY.md](SECURITY.md)) is a gate between phase 1 and 2,
not after phase 4.

## Testing

- **Unit (Rust):** grant scope checks, lease hand-off and expiry, key blocklist,
  normalized-to-pixel conversion at 100/125/150/200% scaling, never-targetable
  filter.
- **Integration (Windows, opt-in, `#[ignore]` by default):** drive Notepad
  through the real backend; assert the file contents.
- **Adversarial checks, run by hand before phase 2 ships:** try to click a
  Spacron approval card; type while focus is stolen by a popup; click through
  an overlapping window; keep acting after the kill switch; type into a password
  field. Each must fail with a clear error.

## Open questions

- Kill-switch default `Ctrl+Alt+Esc` — check for conflicts with existing
  Spacron shortcuts ([shortcut-key-matching note](../.spacron/memory/shortcut-key-matching.md)).
- Should a grant card be answerable from the mobile companion? Useful for
  background agents, but it lets a phone approve control of the laptop.
  Recommendation: no in v1.
- `enigo` vs raw `SendInput`: `enigo` is cross-platform but we need the
  injected-flag and per-monitor DPI details anyway. Decide in the phase 0 spike.
