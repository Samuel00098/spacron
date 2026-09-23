# What the orchestrator can see of a file

Rule: every file is LISTED; secrets are never READ. A review once reported
"no .env.local" because the file was git-ignored and every listing hid it.

- `fs_glob_files` (Rust, `file_system.rs`) follows `.gitignore`. With
  `ignoredOnly: true` it returns the ignored files sitting directly in
  directories the normal walk visits (`glob_ignored_files`), so an ignored
  directory like `coverage/` cannot flood it. The remote dispatcher
  (`remote/mod.rs`) accepts the same flag; keep them in step.
- `services/orchestrator/file-visibility.ts` decides what is secret. The store's
  `read_file` returns env files names-only (`redactEnvFile`) and withholds
  credential files; neither counts as "read", so neither can be edited or
  overwritten by the orchestrator.
- `glob_files` output, the `read_project` snapshot header, and the per-turn
  project tree (`recon.ts`, which now shows dotfiles) all mark such files
  instead of dropping them. The brain prompt's EXISTENCE CLAIMS rule depends on
  that: "absent from a listing" must never mean "missing".

Related: [[orchestrator-approval-cards]].
