# DeepSeek Harness (`dsh`) as an agent

Design lives in the module docs of `src-tauri/src/commands/deepseek_harness.rs`
and `src/lib/services/deepseek-harness.ts`. What they cannot tell you:

- **npm dist-tags were broken (2026-09-22).** `latest` (0.1.5-alpha.2) and
  `next` (0.1.5-rc.x) failed with ETARGET on an unpublished
  `dsh-client-ui-sidebar-documentpreview@^0.1.5-rc.3`. Only `0.1.7-alpha.1`
  installed. Re-check before bumping `PINNED_VERSION`.
  **2026-09-24:** tags are now `latest` 0.1.5-rc.3 (still older), `next`
  0.1.7-rc.1, `alpha` 0.1.7-alpha.2, and both 0.1.7 builds install. rc.1 keeps
  `lib/bin.js`, boots the web profile with Spacron's patches, and runs the
  headless worker to a FAILED turn line on a fake key, same as alpha.1. Not
  re-checked on rc.1: the pi-ai model catalog, the rules-file names, and the
  panel in a browser, so `PINNED_VERSION` stays alpha.1. The in-app updater
  (`agent_updates.rs`) follows the highest dist-tag for prerelease installs,
  so it offers rc.1.
- **Test-installing a dsh version:** give the scratch folder its own
  `package.json` first. Without one npm walks up to the nearest folder with a
  `node_modules` (on the dev box that is the home folder) and installs there.
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

- **The panel works in one of the user's worktrees, never one of its own.**
  Placement is `deepSeekPlacements[projectId].worktreePath` (null = main
  checkout), taken from the sidebar's selected row when the panel opens, and
  its row lists under whichever worktree row owns that folder. It deliberately
  does not get an agent worktree: `.spacron/worktrees/` is invisible in the
  sidebar, and handing a user's worktree to the orchestrator as agent-owned
  would let the reconciler stage or merge it.

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
