# VPS deploy is now cross-platform (detect + right binary)

The "Set up a remote VPS" flow no longer requires server OS == app OS
(`src-tauri/src/commands/remote_deploy.rs`, `RemoteSetupWizard.tsx`,
`scripts/build-server-sidecar.js`).

**Detection**: `remote_detect_platform` SSHes `uname -s` (Linux/Darwin;
MINGW/MSYS/CYGWIN = Windows w/ Git Bash shell), falls back to `$env:OS` via
PowerShell when uname fails (cmd/PowerShell default shells). Parser:
`parse_probe_output` (pure, unit-tested). 30s tokio timeout per probe.
Wizard runs it debounced once host+username are filled; adopts the result
only until the user touches the picker (`platformTouchedRef`).

**Binary resolution** (`resolve_server_binary_for(platform)`):
1. `SPACRON_SERVER_PATH` override (explicit wins).
2. Triple-named artifacts `spacron-server-<triple>[.exe]` in
   `src-tauri/binaries` or next to the exe — triples per platform via
   `DeployPlatform::triples()` (linux prefers musl, macos prefers arm64).
   `.exe` suffix follows the TARGET triple (`triple.contains("windows")` —
   NOT ends_with; msvc triples end in "msvc", bit me once).
3. Host spots (sidecar next to exe, `target/{release,debug}`) only when
   platform == host.

**Cross-builds**: `npm run server:build -- --target=<triple>` stages into
binaries. Linux-musl from any host: `rustup target add x86_64-unknown-linux-musl`
+ cargo-zigbuild/zig linker. macOS CANNOT be cross-built — needs a Mac or CI
artifact dropped in by triple name.

**Not done yet**: packaged installers still ship only their own OS's sidecar,
and there is no release-download step — a fresh Windows *install* targeting
Linux needs the one-time local cross-build (or SPACRON_SERVER_PATH). Follow-up
would be CI publishing per-triple artifacts + download-with-checksum at deploy.
