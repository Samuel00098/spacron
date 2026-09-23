# DeepSeek Harness (`dsh`) as an agent

Design lives in the module docs of `src-tauri/src/commands/deepseek_harness.rs`
and `src/lib/services/deepseek-harness.ts`. What they cannot tell you:

- **npm dist-tags were broken (2026-09-22).** `latest` (0.1.5-alpha.2) and
  `next` (0.1.5-rc.x) failed with ETARGET on an unpublished
  `dsh-client-ui-sidebar-documentpreview@^0.1.5-rc.3`. Only `0.1.7-alpha.1`
  installed. Re-check before bumping `PINNED_VERSION`.
- **Why not the preview proxy alone:** tried and measured. dsh's WebSocket
  needs its `SameSite=Strict` cookie and a `127.0.0.1` Origin; a cross-site
  iframe never sends the cookie, and the local-dev WS bridge forwards neither.
  `--trusted-host localhost:<port>` does NOT make dsh accept a `localhost`
  Origin (403 either way).
- **`failOnStartupError: true` on the MCP row hangs the web profile** (no
  readiness line, no exit) instead of failing, so the row leaves it false.
- **Verified without a key only.** Protocol, MCP connection (good token boots,
  bad token 401s), token exchange, the task-file wrapper and its FAILED turn
  line are real. Untested until someone runs it with `DEEPSEEK_API_KEY`: a
  successful turn (DONE line), the panel rendering through the gateway inside
  the app, and whether a worker in a worktree may write its report file into
  the main checkout's `.spacron/reports/`.

- **Other providers' keys** go through dsh's `dsh-llm-pi-ai` row (`llm-pi-ai`,
  empty by default). A patch naming the route plus `agent-default-model` was
  verified to reach Anthropic (fake key → Anthropic's own 401). The patch
  replaces that row's whole config, so routes a user adds in dsh's own Models
  page are hidden while Spacron launches it. Default model ids must exist in
  the bundled pi-ai catalog — re-check them when bumping dsh.

- **Opening on the project** needs BOTH the workspace plugin and per-project
  data. Registering the project in the shared dsh home was tried: with more
  than one Workspace the UI starts on "Choose workspace" (checked in a browser).
  dsh has no URL/config for the startup Workspace. With one Workspace per data
  folder it opens straight on the project, first launch and relaunch.

- **Never override the user's model choice.** dsh saves it as an
  `agent-default-model` row in `~/.dsh/profiles/web/cordis.patch.yml`, and a
  `--patch` overlay beats that file — so an unconditional default silently
  reset their pick on every launch (reported as "why is it GPT-5.5"). Worse,
  dsh REFUSES a settings-UI write that a `--patch` overlay covers, so any row
  Spacron overlays is locked in dsh's UI. That is wanted for Full access
  (`permission` row + `DSH_PERMISSION_MODE`), not for the model: the default
  model is seeded once INTO the profile file (only after dsh created it), and
  workers copy the row.

- **An isolated panel's worktree has no session or task**, so it lives in
  `deepSeekPlacements` (deepseek-harness.ts). `trackedWorktrees`,
  `persistWorktreePatch`, the cleanup paths and `sweepOrphanWorktrees` in
  orchestrator.ts must all consult it — miss the sweep and the orphan pass
  deletes the panel's checkout out from under it.

- **Only the headless worker can raise a completion notification.** Verified
  (2026-09-22, by wiring not by a live key): the worker's PTY gets a status
  channel (terminal.ts `agentPreset` → `prepareStatusChannel`) and the worker
  script writes `SPACRON-TURN-DONE`/`SPACRON-TURN-FAILED` on exit, so the
  orchestrator's watcher resolves a *declared* turn end → card + chime + OS
  notification, exactly like every other agent. The **web panel is not wired
  for this**: dsh's browser sessions are not Spacron PTYs, have no per-session
  token, and are never watched, so a panel completion surfaces only if the dsh
  model happens to call Spacron's `report_status` MCP tool — and then only as an
  unattributed card (no task/turn, name "An agent"). This asymmetry is why the
  panel shows the "cannot send completion cards" warning when MCP is down.

Related: [[agent-turn-reporting]], [[preview-iframe-bridge]], [[windows-pathext-shims]]
