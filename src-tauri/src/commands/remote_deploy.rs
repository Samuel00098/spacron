//! In-app "Set up a remote VPS" — deploys the bundled `spacron-server` binary
//! to a box you own over SSH and returns a ready-to-connect remote.
//!
//! This is the deployment side of the bundle-sidecar story: the desktop app
//! ships `spacron-server` (see `scripts/build-server-sidecar.js` +
//! `bundle.externalBin`), and this command puts it on the user's server in one
//! flow — upload the binary, write a token, start it, and arm a supervisor so
//! it comes back on its own. One supervisor per platform:
//!
//! - **Linux**: a `@reboot` user crontab entry (no sudo needed).
//! - **macOS**: a user `launchd` LaunchAgent (`com.spacron.server.plist`).
//! - **Windows**: a Task Scheduler entry running at boot as SYSTEM, plus a
//!   firewall rule for the port.
//!
//! Platform rule: the server binary must be built for the OS of the *target*
//! box. The bundled sidecar covers same-OS deploys; anything else is resolved
//! per target platform — a triple-named cross artifact (e.g. a musl Linux
//! build from `npm run server:build -- --target=x86_64-unknown-linux-musl`,
//! or a macOS build produced by CI/on a Mac) or the `SPACRON_SERVER_PATH`
//! override. The wizard probes the server over SSH (`remote_detect_platform`)
//! so the user doesn't have to know which one applies.
//!
//! Security notes:
//! - Host / username / workspace are validated to a safe alphabet; nothing
//!   user-supplied is ever interpolated into a shell — every argument is
//!   passed as its own argv item to `ssh`/`scp`.
//! - The token is generated here (not on the remote), written to a
//!   user-private file with `umask 077` (Linux/macOS) or the user profile's
//!   ACL (Windows), and the transient install script that also carries it is
//!   deleted after it runs.
//! - SSH runs with `BatchMode=yes` (no password prompts — use a key or an
//!   ssh-agent), `StrictHostKeyChecking=accept-new` (first connect is
//!   non-interactive; changed keys still fail), and a connect timeout.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::process::Command;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDeployArgs {
    /// Hostname or IP of the server.
    pub host: String,
    /// SSH user to log in as.
    pub username: String,
    /// SSH port (default 22).
    #[serde(default = "default_ssh_port")]
    pub ssh_port: u16,
    /// Path to an SSH private key. Empty = rely on ssh-agent / default keys.
    #[serde(default)]
    pub key_path: Option<String>,
    /// Folder name the workspace root is created under the user's home
    /// (default "code").
    #[serde(default = "default_workspace")]
    pub workspace: String,
    /// Port the server listens on for WebSocket clients (default 9000).
    #[serde(default = "default_server_port")]
    pub server_port: u16,
    /// OS the server runs: "linux" | "macos" | "windows" (default "linux").
    #[serde(default = "default_platform")]
    pub platform: String,
}

fn default_ssh_port() -> u16 {
    22
}
fn default_workspace() -> String {
    "code".to_string()
}
fn default_server_port() -> u16 {
    9000
}
fn default_platform() -> String {
    "linux".to_string()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDeployResult {
    pub host: String,
    pub port: u16,
    /// The `/pty` WebSocket endpoint the client connects to.
    pub url: String,
    /// Pre-shared token for the connection (write to the OS keychain client-side).
    pub token: String,
}

// ── Platform ─────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DeployPlatform {
    Linux,
    Macos,
    Windows,
}

impl DeployPlatform {
    pub fn parse(raw: &str) -> Result<Self, String> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "linux" => Ok(Self::Linux),
            "macos" | "mac" | "darwin" => Ok(Self::Macos),
            "windows" | "win" => Ok(Self::Windows),
            other => Err(format!(
                "Unknown server platform '{other}'. Use 'linux', 'macos' or 'windows'."
            )),
        }
    }

    /// The OS this app binary was built for — the OS the bundled sidecar can run on.
    pub fn host() -> Self {
        #[cfg(target_os = "windows")]
        {
            Self::Windows
        }
        #[cfg(target_os = "macos")]
        {
            Self::Macos
        }
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        {
            Self::Linux
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Linux => "Linux",
            Self::Macos => "macOS",
            Self::Windows => "Windows",
        }
    }

    /// Wire form ("linux" | "macos" | "windows") — what `parse` accepts and
    /// what the frontend stores.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Linux => "linux",
            Self::Macos => "macos",
            Self::Windows => "windows",
        }
    }

    /// Target triples a `spacron-server` binary for this OS could be named
    /// under (`src-tauri/binaries/spacron-server-<triple>[.exe]`, Tauri's
    /// sidecar convention). Order matters where it is meaningful: Linux
    /// prefers musl (static — runs on any glibc/musl distro without runtime
    /// library installs) and macOS prefers arm64 (Apple Silicon dominates).
    pub fn triples(self) -> &'static [&'static str] {
        match self {
            Self::Linux => &[
                "x86_64-unknown-linux-musl",
                "aarch64-unknown-linux-musl",
                "x86_64-unknown-linux-gnu",
                "aarch64-unknown-linux-gnu",
            ],
            Self::Macos => &["aarch64-apple-darwin", "x86_64-apple-darwin"],
            Self::Windows => &["x86_64-pc-windows-msvc"],
        }
    }
}

/// Map an OS-probe answer to a platform. Accepts `uname -s` output
/// (Linux/Darwin, plus MINGW/MSYS/CYGWIN for Windows boxes whose OpenSSH
/// default shell is Git Bash) and the Windows `%OS%` value. Unknown answers
/// yield None rather than a guess — the caller keeps the manual picker.
pub fn parse_probe_output(raw: &str) -> Option<DeployPlatform> {
    let out = raw.trim();
    if out.contains("Darwin") {
        Some(DeployPlatform::Macos)
    } else if out.contains("Linux") {
        Some(DeployPlatform::Linux)
    } else if ["MINGW", "MSYS", "CYGWIN", "Windows_NT"]
        .iter()
        .any(|m| out.contains(m))
    {
        Some(DeployPlatform::Windows)
    } else {
        None
    }
}

// ── Input validation ─────────────────────────────────────────────────────────

fn validate_host(host: &str) -> Result<(), String> {
    if host.is_empty() {
        return Err("Host is required.".into());
    }
    if host.len() > 255 || !host.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_')) {
        return Err("Host may only contain letters, digits, dots, dashes and underscores.".into());
    }
    Ok(())
}

fn validate_username(username: &str) -> Result<(), String> {
    if username.is_empty() {
        return Err("SSH username is required.".into());
    }
    if username.len() > 64
        || !username
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
    {
        return Err("Username may only contain letters, digits, dots, dashes and underscores.".into());
    }
    Ok(())
}

fn validate_workspace(workspace: &str) -> Result<(), String> {
    if workspace.is_empty() {
        return Err("Workspace folder is required.".into());
    }
    if workspace.len() > 64 || !workspace.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_')) {
        return Err("Workspace folder may only contain letters, digits, dashes and underscores.".into());
    }
    Ok(())
}

// ── Install scripts (pure, unit-tested) ──────────────────────────────────────

/// Linux: one bash script — env file (0600), start now, `@reboot` crontab.
/// Also self-heals the deployment gotcha that the server links the same GUI
/// runtime libraries as the desktop app: it installs them with passwordless
/// sudo when available and fails with an actionable hint when not.
pub fn build_linux_script(workspace: &str, port: u16, token: &str) -> String {
    format!(
        r#"#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$HOME/.spacron-server" "$HOME/{workspace}"
chmod +x "$HOME/.spacron-server/spacron-server"

umask 077
cat > "$HOME/.spacron-server/env" <<'EOF'
SPACRON_TOKEN={token}
EOF

# The binary links the same GUI runtime libs as the desktop app. If it cannot
# even print --help, install them (passwordless sudo only — otherwise the
# wizard surfaces the hint below).
if ! "$HOME/.spacron-server/spacron-server" --help >/dev/null 2>&1; then
  if sudo -n true 2>/dev/null; then
    sudo -n apt-get update -qq >/dev/null 2>&1 || true
    sudo -n apt-get install -y -qq \
      libwebkit2gtk-4.1-0 libgtk-3-0 libayatana-appindicator3-1 librsvg2-2 \
      libsecret-1-0 libsoup-3.0-0 gstreamer1.0-plugins-base gstreamer1.0-plugins-good \
      >/dev/null 2>&1 || true
    "$HOME/.spacron-server/spacron-server" --help >/dev/null 2>&1 || {{
      echo "ERROR: spacron-server still cannot run after installing its libraries."
      exit 1
    }}
  else
    echo "ERROR: spacron-server needs GUI runtime libraries on this box."
    echo "Run: sudo apt install -y libwebkit2gtk-4.1-0 libgtk-3-0 libayatana-appindicator3-1 librsvg2-2 libsecret-1-0"
    exit 1
  fi
fi

# Stop any previous instance before relaunching.
pkill -f "$HOME/.spacron-server/spacron-server" 2>/dev/null || true
sleep 1

# Start now.
nohup env "$(cat "$HOME/.spacron-server/env")" "$HOME/.spacron-server/spacron-server" \
  --workspace "$HOME/{workspace}" --port {port} --auto-commit-ms 300000 \
  > "$HOME/.spacron-server/server.log" 2>&1 &

# Survive reboots (user crontab — no sudo needed).
( crontab -l 2>/dev/null | grep -v "spacron-server" || true
  echo '@reboot sleep 5 && env "$(cat $HOME/.spacron-server/env)" "$HOME/.spacron-server/spacron-server" --workspace "$HOME/{workspace}" --port {port} --auto-commit-ms 300000 >> "$HOME/.spacron-server/server.log" 2>&1'
) | crontab - 2>/dev/null || true

echo "spacron-server deployed on port {port}"
"#,
        workspace = workspace,
        port = port,
        token = token
    )
}

/// macOS: one bash script — env file (0600) + a `start.sh` wrapper that reads
/// it, then a user launchd LaunchAgent (`com.spacron.server`) that runs the
/// wrapper at login/boot and keeps it alive. No extra runtime libraries needed
/// (macOS ships WebKit).
pub fn build_macos_script(workspace: &str, port: u16, token: &str) -> String {
    format!(
        r#"#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$HOME/.spacron-server" "$HOME/{workspace}"
chmod +x "$HOME/.spacron-server/spacron-server"

umask 077
cat > "$HOME/.spacron-server/env" <<'EOF'
SPACRON_TOKEN={token}
EOF

# Launch wrapper — keeps the token in the 0600 env file, out of the plist.
cat > "$HOME/.spacron-server/start.sh" <<EOS
#!/bin/bash
. "$HOME/.spacron-server/env"
exec "$HOME/.spacron-server/spacron-server" --workspace "$HOME/{workspace}" --port {port} --auto-commit-ms 300000
EOS
chmod +x "$HOME/.spacron-server/start.sh"

# Stop any previous instance before relaunching.
pkill -f "$HOME/.spacron-server/spacron-server" 2>/dev/null || true
sleep 1

PLIST="$HOME/Library/LaunchAgents/com.spacron.server.plist"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.spacron.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$HOME/.spacron-server/start.sh</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$HOME/.spacron-server/server.log</string>
  <key>StandardErrorPath</key>
  <string>$HOME/.spacron-server/server.log</string>
</dict>
</plist>
EOF
chmod 600 "$PLIST"

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

echo "spacron-server deployed on port {port}"
"#,
        workspace = workspace,
        port = port,
        token = token
    )
}

/// Windows: a PowerShell script that writes the token file + a `start.cmd`
/// boot wrapper, starts the server now, registers a Task Scheduler entry
/// (boot, as SYSTEM — so it starts without anyone logging in) and opens the
/// firewall port. The script deletes itself at the end because it carries the
/// token. Admin SSH access is needed for the boot task + firewall rule; those
/// two steps are best-effort and warn instead of failing.
pub fn build_windows_deploy_script(workspace: &str, port: u16, token: &str) -> String {
    format!(
        r#"$ErrorActionPreference = 'Stop'
$dir = Join-Path $env:USERPROFILE '.spacron-server'
$code = Join-Path $env:USERPROFILE '{workspace}'
New-Item -ItemType Directory -Force -Path $dir, $code | Out-Null

# Token file — the one durable secret; the boot wrapper reads it.
"SPACRON_TOKEN={token}" | Out-File -FilePath (Join-Path $dir 'env.txt') -Encoding ascii

# Boot wrapper (.cmd). Absolute paths are baked in because the boot task runs
# as SYSTEM, whose $env:USERPROFILE is not the user's.
$startCmd = Join-Path $dir 'start.cmd'
@"
@echo off
setlocal
for /f "usebackq delims=" %%i in ("$dir\env.txt") do set %%i
"$dir\spacron-server.exe" --workspace "$code" --port {port} --auto-commit-ms 300000
"@ | Set-Content -Path $startCmd -Encoding ascii

# Stop any previous instance, then start now.
Stop-Process -Name 'spacron-server' -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1
Start-Process -FilePath $startCmd -WindowStyle Hidden

# Run at boot (best effort — needs an admin SSH user).
try {{
  schtasks /Create /F /TN 'SpacronServer' /SC ONSTART /RU SYSTEM /TR "`"$startCmd`"" | Out-Null
}} catch {{
  Write-Warning "Could not register the boot task (admin required): $_"
}}

# Open the port (best effort — needs an admin SSH user).
try {{
  netsh advfirewall firewall add rule name='Spacron Server' dir=in action=allow protocol=TCP localport={port} | Out-Null
}} catch {{
  Write-Warning "Could not open firewall port {port} (admin required): $_"
}}

Write-Output "spacron-server deployed on port {port}"
# Self-cleanup: this script carries the token.
Remove-Item -Path $PSCommandPath -Force
"#,
        workspace = workspace,
        port = port,
        token = token
    )
}

// ── Locating the server binary ───────────────────────────────────────────────

/// File name of the HOST-OS sidecar build. Tauri strips the target triple
/// when it copies a declared sidecar next to the app binary, so this is what
/// ships inside an installer and what a plain `npm run server:build` produces
/// into `target/<profile>`.
fn host_sidecar_name() -> &'static str {
    if cfg!(windows) {
        "spacron-server.exe"
    } else {
        "spacron-server"
    }
}

/// Sidecar-style name for one target triple (`spacron-server-<triple>[.exe]`,
/// Tauri's convention). The `.exe` follows the *target*, not the host.
fn triple_artifact_name(triple: &str) -> String {
    if triple.contains("windows") {
        format!("spacron-server-{triple}.exe")
    } else {
        format!("spacron-server-{triple}")
    }
}

/// Directories a cross-built artifact may sit in:
/// 1. `src-tauri/binaries` — where `server:build --target=…`, CI jobs and
///    hand-built copies land (dev machines).
/// 2. Next to the running app binary.
fn artifact_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(manifest) = std::env::var("CARGO_MANIFEST_DIR") {
        dirs.push(PathBuf::from(&manifest).join("binaries"));
    }
    if let Some(dir) = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
    {
        dirs.push(dir);
    }
    dirs
}

/// Find a spacron-server build that runs on `platform`. Priority:
///
/// 1. `SPACRON_SERVER_PATH` env override — explicit; whoever sets it asserts
///    it matches the target OS.
/// 2. A triple-named cross artifact (`spacron-server-<triple>[.exe]`) in
///    `src-tauri/binaries` or next to the running exe. This is how Windows
///    deploys Linux servers (musl cross-build) and how CI-built macOS
///    binaries get used without this machine ever seeing a Mac.
/// 3. The classic HOST-OS spots (sidecar next to the exe,
///    `target/{release,debug}`) — only consulted when the requested platform
///    IS the host OS, because those builds can only run there.
pub fn resolve_server_binary_for(platform: DeployPlatform) -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var("SPACRON_SERVER_PATH") {
        if !path.is_empty() {
            let pb = PathBuf::from(&path);
            if pb.is_file() {
                return Ok(pb);
            }
            return Err(format!("SPACRON_SERVER_PATH is set but is not a file: {path}"));
        }
    }

    for triple in platform.triples() {
        for dir in artifact_dirs() {
            let candidate = dir.join(triple_artifact_name(triple));
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }

    if platform == DeployPlatform::host() {
        if let Some(dir) =
            std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf()))
        {
            let candidate = dir.join(host_sidecar_name());
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
        if let Ok(manifest) = std::env::var("CARGO_MANIFEST_DIR") {
            for profile in ["release", "debug"] {
                let candidate = PathBuf::from(&manifest)
                    .join("target")
                    .join(profile)
                    .join(host_sidecar_name());
                if candidate.is_file() {
                    return Ok(candidate);
                }
            }
        }
        return Err(
            "Could not find the bundled spacron-server binary. Build it once with \
             `npm run server:build` (or set SPACRON_SERVER_PATH to point at one)."
                .to_string(),
        );
    }

    Err(format!(
        "No spacron-server build for {} was found on this machine. Build one with \
         `npm run server:build -- --target={first}` and re-run the wizard, or set \
         SPACRON_SERVER_PATH to point at a {os} build. (macOS binaries must be \
         built on a Mac or by CI.)",
        platform.label(),
        first = platform.triples()[0],
        os = platform.label(),
    ))
}

// ── SSH plumbing ─────────────────────────────────────────────────────────────

fn base_ssh_opts(args: &RemoteDeployArgs) -> Vec<String> {
    let mut opts = vec![
        "-o".to_string(),
        "StrictHostKeyChecking=accept-new".to_string(),
        "-o".to_string(),
        "ConnectTimeout=20".to_string(),
        "-o".to_string(),
        "BatchMode=yes".to_string(),
    ];
    if args.ssh_port != 22 {
        opts.push("-p".to_string());
        opts.push(args.ssh_port.to_string());
    }
    if let Some(key) = args.key_path.as_deref().filter(|k| !k.is_empty()) {
        opts.push("-i".to_string());
        opts.push(key.to_string());
    }
    opts
}

fn target(args: &RemoteDeployArgs) -> String {
    format!("{}@{}", args.username, args.host)
}

async fn run_ssh(command: &str, args: &RemoteDeployArgs) -> Result<String, String> {
    let output = Command::new("ssh")
        .args(base_ssh_opts(args))
        .arg(target(args))
        .arg(command)
        .output()
        .await
        .map_err(|e| format!("Failed to run ssh (is OpenSSH installed?): {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(format!(
            "ssh failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

async fn run_scp(source: &Path, dest: &str, args: &RemoteDeployArgs) -> Result<(), String> {
    let mut cmd = Command::new("scp");
    // scp spells the port flag uppercase and takes the same -o options.
    let mut opts = base_ssh_opts(args);
    for i in 0..opts.len() {
        if opts[i] == "-p" {
            opts[i] = "-P".to_string();
        }
    }
    cmd.args(opts)
        .arg(source)
        .arg(format!("{}:{dest}", target(args)));
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to run scp (is OpenSSH installed?): {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "scp failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

// ── The command ──────────────────────────────────────────────────────────────

/// Deploy the bundled server to a box over SSH. Returns the connection
/// coordinates (`url` + `token`) the client saves as a remote.
#[tauri::command]
pub async fn remote_deploy_vps(args: RemoteDeployArgs) -> Result<RemoteDeployResult, String> {
    validate_host(&args.host)?;
    validate_username(&args.username)?;
    validate_workspace(&args.workspace)?;
    // Both ports are u16, so only the zero end of the range needs checking.
    if args.ssh_port == 0 {
        return Err("SSH port must be between 1 and 65535.".into());
    }
    if args.server_port == 0 {
        return Err("Server port must be between 1 and 65535.".into());
    }

    let platform = DeployPlatform::parse(&args.platform)?;

    // Resolve a binary that actually runs on the TARGET OS: the bundled
    // sidecar for same-OS deploys, a triple-named cross artifact (musl Linux,
    // CI-built macOS) otherwise, SPACRON_SERVER_PATH always. A mismatch is no
    // longer refused up front — it surfaces here with an actionable message.
    let binary = resolve_server_binary_for(platform)?;
    let token = uuid::Uuid::new_v4().simple().to_string();

    match platform {
        DeployPlatform::Windows => {
            // Windows OpenSSH may default to cmd or PowerShell, so every remote
            // command is wrapped in an explicit `powershell` invocation.
            run_ssh(
                "powershell -Command \"New-Item -ItemType Directory -Force -Path .spacron-server | Out-Null\"",
                &args,
            )
            .await?;
            run_scp(&binary, ".spacron-server/spacron-server.exe", &args).await?;

            let script = build_windows_deploy_script(&args.workspace, args.server_port, &token);
            let script_path = temp_script_path();
            std::fs::write(&script_path, &script)
                .map_err(|e| format!("Failed to write the install script: {e}"))?;
            let upload = run_scp(&script_path, ".spacron-server/deploy.ps1", &args).await;
            let _ = std::fs::remove_file(&script_path);
            upload?;

            // deploy.ps1 deletes itself once it has run (it carries the token).
            run_ssh(
                "powershell -ExecutionPolicy Bypass -File .spacron-server/deploy.ps1",
                &args,
            )
            .await?;
        }
        DeployPlatform::Macos => {
            run_ssh("mkdir -p ~/.spacron-server", &args).await?;
            run_scp(&binary, "~/.spacron-server/spacron-server", &args).await?;
            run_install_script(
                &build_macos_script(&args.workspace, args.server_port, &token),
                &args,
            )
            .await?;
        }
        DeployPlatform::Linux => {
            run_ssh("mkdir -p ~/.spacron-server", &args).await?;
            run_scp(&binary, "~/.spacron-server/spacron-server", &args).await?;
            run_install_script(
                &build_linux_script(&args.workspace, args.server_port, &token),
                &args,
            )
            .await?;
        }
    }

    Ok(RemoteDeployResult {
        url: format!("ws://{}:{}/pty", args.host, args.server_port),
        host: args.host,
        port: args.server_port,
        token,
    })
}

// ── OS detection ─────────────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectPlatformArgs {
    /// Hostname or IP of the server.
    pub host: String,
    /// SSH user to log in as.
    pub username: String,
    /// SSH port (default 22).
    #[serde(default = "default_ssh_port")]
    pub ssh_port: u16,
    /// Path to an SSH private key. Empty = rely on ssh-agent / default keys.
    #[serde(default)]
    pub key_path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectPlatformResult {
    /// "linux" | "macos" | "windows" — null when the probe could not tell
    /// (unreachable box, exotic OS/shell). The wizard keeps whatever the user
    /// picked and surfaces `detail` as a hint instead of guessing.
    pub platform: Option<String>,
    /// Raw evidence or why detection failed — shown as a hint line.
    pub detail: String,
}

/// Overall budget for ONE probe round-trip (connect is separately capped by
/// ssh's ConnectTimeout=20; this also covers a slow login shell).
const PROBE_TIMEOUT: Duration = Duration::from_secs(30);

async fn probe_once(command: &str, args: &RemoteDeployArgs) -> Result<String, String> {
    let fut = run_ssh(command, args);
    match tokio::time::timeout(PROBE_TIMEOUT, fut).await {
        Ok(res) => res,
        Err(_) => Err(format!("probe timed out after {}s", PROBE_TIMEOUT.as_secs())),
    }
}

/// Ask the server which OS it runs so the wizard can auto-pick the platform
/// (and with it the right spacron-server build) instead of defaulting to the
/// machine this app runs on.
///
/// Probe order:
/// 1. `uname -s` — answers Linux/Darwin directly; MINGW/MSYS/CYGWIN answers
///    mean a Windows box whose OpenSSH default shell is Git Bash.
/// 2. If that failed (Windows cmd/PowerShell shells have no uname), `%OS%`
///    through PowerShell — both Windows default shells execute it.
///
/// Read-only and side-effect free: two short-lived ssh execs, nothing written
/// remotely, no tokens involved beyond the user's own SSH credentials.
#[tauri::command]
pub async fn remote_detect_platform(
    args: DetectPlatformArgs,
) -> Result<DetectPlatformResult, String> {
    validate_host(&args.host)?;
    validate_username(&args.username)?;

    // run_ssh/base_ssh_opts are typed on RemoteDeployArgs; fill the unused
    // fields with their defaults rather than duplicating the plumbing.
    let probe_args = RemoteDeployArgs {
        host: args.host,
        username: args.username,
        ssh_port: args.ssh_port,
        key_path: args.key_path,
        workspace: default_workspace(),
        server_port: default_server_port(),
        platform: "linux".to_string(),
    };

    match probe_once("uname -s", &probe_args).await {
        Ok(out) => {
            if let Some(p) = parse_probe_output(&out) {
                return Ok(DetectPlatformResult {
                    platform: Some(p.as_str().to_string()),
                    detail: out.trim().to_string(),
                });
            }
            Ok(DetectPlatformResult {
                platform: None,
                detail: format!("The server answered but its OS wasn't recognised: {}", out.trim()),
            })
        }
        Err(uname_err) => match probe_once("powershell -NoProfile -Command \"Write-Output $env:OS\"", &probe_args).await {
            Ok(out) => {
                if out.contains("Windows_NT") {
                    Ok(DetectPlatformResult {
                        platform: Some(DeployPlatform::Windows.as_str().to_string()),
                        detail: out.trim().to_string(),
                    })
                } else {
                    Ok(DetectPlatformResult {
                        platform: None,
                        detail: format!("Could not identify the server's OS ({})", out.trim()),
                    })
                }
            }
            Err(win_err) => Ok(DetectPlatformResult {
                platform: None,
                detail: format!(
                    "Could not reach the server to detect its OS — {uname_err}; {win_err}"
                ),
            }),
        },
    }
}

/// Upload a POSIX install script to `~/.spacron-server/install.sh`, run it,
/// and delete the copy (it carries the token).
async fn run_install_script(script: &str, args: &RemoteDeployArgs) -> Result<(), String> {
    let script_path = temp_script_path();
    std::fs::write(&script_path, script)
        .map_err(|e| format!("Failed to write the install script: {e}"))?;
    let upload = run_scp(&script_path, "~/.spacron-server/install.sh", &args).await;
    let _ = std::fs::remove_file(&script_path);
    upload?;
    run_ssh(
        "bash ~/.spacron-server/install.sh && rm -f ~/.spacron-server/install.sh",
        &args,
    )
    .await?;
    Ok(())
}

fn temp_script_path() -> PathBuf {
    std::env::temp_dir().join(format!(
        "spacron-install-{}.sh",
        uuid::Uuid::new_v4().simple()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platform_parsing() {
        assert_eq!(DeployPlatform::parse("linux").unwrap(), DeployPlatform::Linux);
        assert_eq!(DeployPlatform::parse("macOS").unwrap(), DeployPlatform::Macos);
        assert_eq!(DeployPlatform::parse("Windows").unwrap(), DeployPlatform::Windows);
        assert!(DeployPlatform::parse("plan9").is_err());
    }

    #[test]
    fn probe_parsing_maps_uname_and_windows_answers() {
        // Real-world uname -s answers.
        assert_eq!(parse_probe_output("Linux"), Some(DeployPlatform::Linux));
        assert_eq!(parse_probe_output("Darwin"), Some(DeployPlatform::Macos));
        assert_eq!(
            parse_probe_output("Linux vps 5.15.0-91-generic x86_64"),
            Some(DeployPlatform::Linux)
        );
        assert_eq!(parse_probe_output("MINGW64_NT-10.0-22631"), Some(DeployPlatform::Windows));
        assert_eq!(parse_probe_output("CYGWIN_NT-10.0"), Some(DeployPlatform::Windows));
        assert_eq!(parse_probe_output("Windows_NT"), Some(DeployPlatform::Windows));
        // Exotic/empty → no guess.
        assert_eq!(parse_probe_output("FreeBSD"), None);
        assert_eq!(parse_probe_output(""), None);
        assert_eq!(parse_probe_output("\n"), None);
    }

    #[test]
    fn triple_artifacts_are_named_per_target_os() {
        assert_eq!(
            triple_artifact_name("x86_64-unknown-linux-musl"),
            "spacron-server-x86_64-unknown-linux-musl"
        );
        assert_eq!(
            triple_artifact_name("aarch64-apple-darwin"),
            "spacron-server-aarch64-apple-darwin"
        );
        assert_eq!(
            triple_artifact_name("x86_64-pc-windows-msvc"),
            "spacron-server-x86_64-pc-windows-msvc.exe"
        );
    }

    #[test]
    fn linux_script_carries_token_workspace_and_port() {
        let script = build_linux_script("code", 9000, "abc123token");
        assert!(script.contains("SPACRON_TOKEN=abc123token"));
        assert!(script.contains("--workspace \"$HOME/code\""));
        assert!(script.contains("--port 9000"));
        // Auto-restart across reboots + auto-commit safety net are on.
        assert!(script.contains("@reboot"));
        assert!(script.contains("--auto-commit-ms 300000"));
    }

    #[test]
    fn scripts_sanitize_the_env_file() {
        for script in [
            build_linux_script("code", 9000, "tok"),
            build_macos_script("code", 9000, "tok"),
        ] {
            // The env file must be written under umask 077 and the heredoc is
            // quoted so `$` in a token can't expand.
            assert!(script.contains("umask 077"));
            assert!(script.contains("<<'EOF'"));
        }
    }

    #[test]
    fn macos_script_uses_launchd_and_keeps_the_token_out_of_the_plist() {
        let script = build_macos_script("code", 9000, "s3cret-token");
        assert!(script.contains("com.spacron.server"));
        assert!(script.contains("launchctl unload"));
        assert!(script.contains("launchctl load"));
        assert!(script.contains("start.sh"));
        // The token appears exactly once — in the 0600 env file — and the plist
        // (which runs the start.sh wrapper) carries no trace of it.
        assert_eq!(script.matches("s3cret-token").count(), 1);
        let plist_start = script.find("<plist").expect("plist present");
        assert!(!script[plist_start..].contains("s3cret-token"));
    }

    #[test]
    fn windows_script_uses_task_scheduler_and_firewall() {
        let script = build_windows_deploy_script("code", 9000, "win-token");
        assert!(script.contains("SPACRON_TOKEN=win-token"));
        assert!(script.contains("schtasks /Create"));
        assert!(script.contains("/SC ONSTART"));
        assert!(script.contains("netsh advfirewall firewall add rule"));
        assert!(script.contains("localport=9000"));
        assert!(script.contains("Start-Process"));
        // The token-bearing script deletes itself when done.
        assert!(script.contains("Remove-Item -Path $PSCommandPath"));
    }

    #[test]
    fn validation_accepts_normal_input() {
        assert!(validate_host("vps.example.com").is_ok());
        assert!(validate_host("192.168.1.10").is_ok());
        assert!(validate_username("samue").is_ok());
        assert!(validate_workspace("code").is_ok());
        assert!(validate_workspace("my-app_2").is_ok());
    }

    #[test]
    fn validation_rejects_unsafe_input() {
        assert!(validate_host("evil.com; rm -rf /").is_err());
        assert!(validate_host("a b").is_err());
        assert!(validate_host("user@host").is_err());
        assert!(validate_username("samue x").is_err());
        assert!(validate_username("").is_err());
        assert!(validate_workspace("../escape").is_err());
        assert!(validate_workspace("code space").is_err());
    }
}
