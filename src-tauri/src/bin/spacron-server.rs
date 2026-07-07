//! Headless Spacron remote-workspace server.
//!
//! Runs the PTY core on a box you own and serves it over a WebSocket so the
//! desktop app can attach terminals that execute here. See
//! `docs/remote-workspace.md`.
//!
//! Usage:
//!   spacron-server --workspace <dir> [--port 9000] [--token <token>] [--auto-commit-ms 300000]
//!
//! The token may also come from `SPACRON_TOKEN`. Run it behind Tailscale (the
//! tailnet encrypts the link, so plain `ws://` is fine for the Step 1 spike).
//!
//! Auto-commit: pass --auto-commit-ms <millis> to periodically stage and commit
//! uncommitted changes as a safety net against VM loss. Default: disabled.

use std::path::PathBuf;

use spacron_lib::remote::{serve, ServerConfig};

fn main() -> anyhow::Result<()> {
    let cfg = parse_args()?;
    let runtime = tokio::runtime::Runtime::new()?;
    runtime.block_on(serve(cfg))
}

fn parse_args() -> anyhow::Result<ServerConfig> {
    let mut workspace: Option<PathBuf> = None;
    let mut port: u16 = 9000;
    let mut token: Option<String> = std::env::var("SPACRON_TOKEN").ok();
    let mut auto_commit_ms: Option<u64> = None;

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--workspace" | "-w" => {
                workspace = Some(PathBuf::from(
                    args.next().ok_or_else(|| anyhow::anyhow!("--workspace needs a value"))?,
                ));
            }
            "--port" | "-p" => {
                port = args
                    .next()
                    .ok_or_else(|| anyhow::anyhow!("--port needs a value"))?
                    .parse()
                    .map_err(|_| anyhow::anyhow!("--port must be a number"))?;
            }
            "--token" | "-t" => {
                token = Some(args.next().ok_or_else(|| anyhow::anyhow!("--token needs a value"))?);
            }
            "--auto-commit-ms" => {
                let val = args
                    .next()
                    .ok_or_else(|| anyhow::anyhow!("--auto-commit-ms needs a value"))?
                    .parse()
                    .map_err(|_| anyhow::anyhow!("--auto-commit-ms must be a number"))?;
                auto_commit_ms = Some(val);
            }
            "--help" | "-h" => {
                println!(
                    "spacron-server --workspace <dir> [--port {port}] [--token <token>] [--auto-commit-ms <millis>]\n\
                     The token may also be set via SPACRON_TOKEN.\n\
                     --auto-commit-ms: interval (milliseconds) to automatically stage+commit changes (default: disabled)"
                );
                std::process::exit(0);
            }
            other => return Err(anyhow::anyhow!("unknown argument: {other}")),
        }
    }

    let workspace = workspace.ok_or_else(|| anyhow::anyhow!("--workspace <dir> is required"))?;
    let token = token.filter(|t| !t.is_empty()).ok_or_else(|| {
        anyhow::anyhow!("a token is required (pass --token or set SPACRON_TOKEN)")
    })?;

    Ok(ServerConfig {
        workspace,
        port,
        token,
        auto_commit_interval: auto_commit_ms.map(|ms| std::time::Duration::from_millis(ms)),
    })
}
