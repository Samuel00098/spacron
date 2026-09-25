//! Headless Spacron remote-workspace server.
//!
//! Runs the PTY core on a box you own and serves it over a WebSocket so the
//! desktop app can attach terminals that execute here. See
//! `docs/remote-workspace.md`.
//!
//! Usage:
//!   spacron-server --workspace <dir> [--port 9000] [--token <token>] \
//!       [--auto-commit-ms 300000] [--cert <pem> --key <pem>]
//!
//! The token may also come from `SPACRON_TOKEN`.
//!
//! Transport: plain `ws://` by default — only safe behind a link that encrypts
//! for you (Tailscale/VPN; the tailnet encrypts, so this is fine there). Pass
//! `--cert <pem> --key <pem>` to serve `wss://` instead, so the link is
//! encrypted end-to-end and the box can be reached over the internet. The
//! cert must be signed by a CA the client trusts (a public CA, or a private CA
//! you install in the client's OS trust store — the app verifies upstream
//! certs against the OS store, not a hardcoded list).
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

const MIN_TOKEN_LEN: usize = 16;

fn parse_args() -> anyhow::Result<ServerConfig> {
    let mut workspace: Option<PathBuf> = None;
    let mut port: u16 = 9000;
    let mut token: Option<String> = std::env::var("SPACRON_TOKEN").ok();
    let mut auto_commit_ms: Option<u64> = None;
    let mut cert: Option<PathBuf> = None;
    let mut key: Option<PathBuf> = None;

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
            "--cert" => {
                cert = Some(PathBuf::from(
                    args.next().ok_or_else(|| anyhow::anyhow!("--cert needs a value"))?,
                ));
            }
            "--key" => {
                key = Some(PathBuf::from(
                    args.next().ok_or_else(|| anyhow::anyhow!("--key needs a value"))?,
                ));
            }
            "--help" | "-h" => {
                println!(
                    "spacron-server --workspace <dir> [--port {port}] [--token <token>] [--auto-commit-ms <millis>] [--cert <pem> --key <pem>]\n\
                     The token may also be set via SPACRON_TOKEN.\n\
                     --auto-commit-ms: interval (milliseconds) to automatically stage+commit changes (default: disabled)\n\
                     --cert/--key: PEM certificate + key pair; when both are given the server serves wss:// (TLS) instead of ws://"
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
    // The token is the only thing standing between the network and a shell on
    // this box, so a guessable one is refused outright. The app mints 32 hex chars.
    if token.chars().count() < MIN_TOKEN_LEN {
        return Err(anyhow::anyhow!(
            "the token must be at least {MIN_TOKEN_LEN} characters (try `openssl rand -hex 16`)"
        ));
    }

    let tls = match (cert, key) {
        (Some(c), Some(k)) => Some((c, k)),
        (None, None) => None,
        _ => {
            return Err(anyhow::anyhow!(
                "--cert and --key must be provided together (or not at all)"
            ))
        }
    };

    Ok(ServerConfig {
        workspace,
        port,
        token,
        auto_commit_interval: auto_commit_ms.map(|ms| std::time::Duration::from_millis(ms)),
        tls,
    })
}
