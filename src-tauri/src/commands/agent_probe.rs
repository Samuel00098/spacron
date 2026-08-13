//! Does this CLI read a rules file?
//!
//! When a user adds a custom agent, Spacron has to decide how to deliver the
//! standing brief: write it into `CLAUDE.md`/`AGENTS.md` and let the CLI load it
//! itself, or paste it into the live REPL. Guessing wrong is silent — a CLI that
//! ignores rules files gets no brief at all if we take the file path — so the
//! choice used to be a checkbox the user had to know the answer to.
//!
//! This asks the binary instead, in two passes:
//!
//! 1. **Help text.** `<exe> --help` is the one interface essentially every CLI
//!    exposes. Cheap, but measured against the real CLIs this turned out to
//!    catch only Claude Code — Grok, Cursor, Codex and OpenCode all read
//!    AGENTS.md and none of them mention it in `--help`.
//! 2. **The program's own bytes.** A CLI that opens `AGENTS.md` has to carry
//!    that filename as a literal, so scanning the executable (or, for a small
//!    shim like `cursor-agent.cmd`, its siblings) for `AGENTS.md`/`CLAUDE.md`
//!    finds the ones pass 1 misses. Verified against `grok.exe` and Cursor's
//!    `cursor-agent-svc.js`, which both contain the literal.
//!
//! Both are heuristics, not proofs, so the frontend presents the result as a
//! pre-filled checkbox the user can override rather than a locked decision.
//!
//! SAFETY — this runs a binary as a side effect of typing into a text field, so
//! it is deliberately narrow:
//!
//! * Only the *executable* is taken from the entered command. The user's own
//!   arguments are never passed on, so a half-typed `mytool deploy --prod`
//!   probes `mytool --help` and nothing else.
//! * No shell. The program is exec'd directly, so shell metacharacters in the
//!   field (`;`, `&&`, backticks) are never interpreted.
//! * Resolved on `PATH` only. The executable is looked up with [`which`] and
//!   spawned by absolute path, so the platform's own search order — which on
//!   Windows also takes in the current directory — never gets to pick the
//!   binary for us.
//! * stdin is `/dev/null`, so a CLI that would prompt gets EOF instead of
//!   hanging.
//! * A hard timeout kills the child, and the captured output is capped.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::Serialize;

/// How long the probe waits before killing the child. `--help` is instant for a
/// well-behaved CLI; anything slower is a binary doing real work, which is
/// exactly what we don't want to sit through.
const PROBE_TIMEOUT: Duration = Duration::from_secs(6);

/// Cap on captured output. Help text is kilobytes; anything beyond this is a CLI
/// streaming something at us.
const MAX_OUTPUT_BYTES: u64 = 256 * 1024;

/// Strings that mean "this CLI loads instructions from a file in the repo".
/// Matched case-insensitively against the help text.
const RULES_MARKERS: &[&str] = &[
    "agents.md",
    "claude.md",
    "gemini.md",
    ".cursorrules",
    ".rules",
    "rules file",
    "rules files",
    "project instructions",
    "instructions file",
    "system prompt file",
    "context file",
    "memory file",
];

/// Rules-file names a CLI would have to carry as a literal in order to open one.
/// Matched case-insensitively against the program's bytes.
const RULES_LITERALS: &[&str] = &["agents.md", "claude.md", "gemini.md", ".cursorrules"];

/// A file at or below this size is treated as a launcher shim (`cursor-agent.cmd`
/// is 363 bytes) whose real payload lives beside it, so the scan looks at its
/// siblings too.
const SHIM_MAX_BYTES: u64 = 64 * 1024;

/// Per-file and total ceilings for the byte scan. `grok.exe` is ~138 MB, so the
/// per-file cap has to clear that comfortably; the total stops a directory full
/// of large binaries from turning one keystroke into a disk crawl.
const MAX_SCAN_FILE_BYTES: u64 = 600 * 1024 * 1024;
const MAX_SCAN_TOTAL_BYTES: u64 = 900 * 1024 * 1024;
/// How many siblings of a shim to consider, largest first.
const MAX_SIBLINGS: usize = 6;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRulesProbe {
    /// The executable actually probed, after stripping env assignments,
    /// launcher prefixes, quotes and any path.
    pub executable: String,
    /// True when the probe ran AND found a marker. False covers both "ran, found
    /// nothing" and "could not run" — `ran` distinguishes them.
    pub reads_rules_file: bool,
    /// Whether the binary was found and produced output at all.
    pub ran: bool,
    /// The marker that matched, for showing the user why.
    pub evidence: Option<String>,
    /// Why the probe could not run, when `ran` is false.
    pub error: Option<String>,
}

impl AgentRulesProbe {
    fn failed(executable: String, error: impl Into<String>) -> Self {
        Self {
            executable,
            reads_rules_file: false,
            ran: false,
            evidence: None,
            error: Some(error.into()),
        }
    }
}

/// Tokens that wrap the real command and should be skipped when locating the
/// executable. Mirrors `COMMAND_LAUNCHER_PREFIXES` in `stores/terminal.ts`.
const LAUNCHER_PREFIXES: &[&str] = &["npx", "bunx", "pnpx", "sudo", "command", "exec", "time", "nice"];

/// Pull the executable out of a launch command: skips a leading PowerShell call
/// operator, `FOO=bar` assignments and launcher prefixes, then strips quotes,
/// any directory part and a Windows extension.
///
/// Returns `None` for input with no usable program token.
pub fn extract_executable(command: &str) -> Option<String> {
    let trimmed = command.trim().trim_start_matches('&').trim();
    let mut tokens = trimmed.split_whitespace();

    let program = loop {
        let token = tokens.next()?;
        // `FOO=bar cmd` — an env assignment, not the program.
        let is_assignment = token
            .split_once('=')
            .is_some_and(|(name, _)| {
                !name.is_empty()
                    && name.chars().next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
                    && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
            });
        if is_assignment {
            continue;
        }
        if LAUNCHER_PREFIXES.contains(&token.to_ascii_lowercase().as_str()) {
            continue;
        }
        break token;
    };

    let program = program.trim_matches(|c| c == '"' || c == '\'');
    let basename = program
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(program);
    let stem = basename
        .strip_suffix(".exe")
        .or_else(|| basename.strip_suffix(".cmd"))
        .or_else(|| basename.strip_suffix(".bat"))
        .unwrap_or(basename);

    let stem = stem.trim();
    if stem.is_empty() {
        None
    } else {
        Some(stem.to_string())
    }
}

/// Find the first rules-file marker in `haystack`, case-insensitively.
pub fn find_rules_marker(haystack: &str) -> Option<&'static str> {
    let lower = haystack.to_ascii_lowercase();
    RULES_MARKERS.iter().copied().find(|m| lower.contains(m))
}

/// Build a `Command` that never flashes a console window on Windows.
fn quiet_command(program: &str) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Run `<exe> --help` and return its combined output, or an error string.
///
/// Both pipes are drained on their own threads: a child that fills a pipe buffer
/// while we are blocked in `wait()` would deadlock, and help text is easily large
/// enough to do that.
fn capture_help(executable: &str) -> Result<String, String> {
    // Resolve on PATH ourselves and spawn the ABSOLUTE path, rather than handing
    // a bare name to the OS. Two reasons:
    //
    // * Security — the platform's own search for a bare program name is not
    //   PATH-only (on Windows it also considers the current directory), so a
    //   binary sitting next to the app could win over the real one. `which`
    //   reads `PATH` and nothing else, which makes the resolution explicit
    //   instead of something we'd have to reason about per-platform.
    // * Correctness — a bare name only picks up `.exe` on Windows, so npm's
    //   `.cmd` shims (`cursor-agent.cmd`) were never found here and pass 1
    //   silently did nothing for them. `which` honours `PATHEXT`.
    let program = which(executable)
        .ok_or_else(|| format!("`{executable}` was not found on your PATH"))?;

    let mut child = quiet_command(&program.to_string_lossy())
        .arg("--help")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                format!("`{executable}` was not found on your PATH")
            } else {
                format!("Could not run `{executable}`: {e}")
            }
        })?;

    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let drain = |pipe: Option<&mut dyn Read>| -> Vec<u8> {
        let mut buf = Vec::new();
        if let Some(p) = pipe {
            let _ = p.take(MAX_OUTPUT_BYTES).read_to_end(&mut buf);
        }
        buf
    };
    let out_handle = std::thread::spawn({
        let mut pipe = stdout.take();
        move || drain(pipe.as_mut().map(|p| p as &mut dyn Read))
    });
    let err_handle = std::thread::spawn({
        let mut pipe = stderr.take();
        move || drain(pipe.as_mut().map(|p| p as &mut dyn Read))
    });

    let deadline = Instant::now() + PROBE_TIMEOUT;
    let timed_out = loop {
        match child.try_wait() {
            Ok(Some(_)) => break false,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    break true;
                }
                std::thread::sleep(Duration::from_millis(40));
            }
            Err(e) => return Err(format!("Could not run `{executable}`: {e}")),
        }
    };

    // The drains end when the child's pipes close, which the kill above forces.
    let out = out_handle.join().unwrap_or_default();
    let err = err_handle.join().unwrap_or_default();

    if timed_out {
        return Err(format!("`{executable} --help` did not finish in time"));
    }

    let mut text = String::from_utf8_lossy(&out).into_owned();
    text.push('\n');
    text.push_str(&String::from_utf8_lossy(&err));
    Ok(text)
}

/// Locate `program` on PATH, trying `PATHEXT` suffixes on Windows so `grok`
/// finds `grok.exe` and `cursor-agent` finds `cursor-agent.cmd`.
///
/// The search is deliberately broader than the process environment. A desktop
/// app's `PATH` is frozen at launch, so a CLI installed *after* Spacron
/// started (`npm i -g`, winget, a native installer, …) is visible to a fresh
/// terminal but invisible to us — the classic "it works in my shell but the
/// app says not installed". On Windows the current registry `Path` (machine
/// then user, `%VAR%` refs expanded) is merged in and searched after the
/// process PATH, so detection reflects what a new terminal would find rather
/// than what the parent process happened to have. (GUI-launched apps also get
/// a PATH that can be truncated relative to the registry, so this closes that
/// gap too.) On macOS/Linux there is no equivalent registry; the process PATH
/// is the honest scope there.
pub fn which(program: &str) -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&path));
    }
    #[cfg(windows)]
    dirs.extend(registry_path_dirs());

    // The same directory frequently appears in the process PATH and the
    // registry merge; search each directory once.
    let mut seen = std::collections::HashSet::new();
    dirs.retain(|dir| seen.insert(dir.clone()));

    #[cfg(windows)]
    let extensions: Vec<String> = std::env::var("PATHEXT")
        .unwrap_or_else(|_| ".EXE;.CMD;.BAT;.COM".to_string())
        .split(';')
        .filter(|e| !e.is_empty())
        .map(|e| e.to_ascii_lowercase())
        .collect();
    #[cfg(not(windows))]
    let extensions: Vec<String> = Vec::new();

    for dir in dirs {
        let direct = dir.join(program);
        if direct.is_file() {
            return Some(direct);
        }
        for ext in &extensions {
            let candidate = dir.join(format!("{program}{ext}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// Directories from the current registry `Path` — machine (HKLM) first, then
/// user (HKCU), which is the order Windows merges them into a process
/// environment. `%VAR%` references are expanded the same way a fresh shell
/// would. An empty or missing value contributes nothing.
///
/// The two hives keep `Path` under **different** subkeys, and that asymmetry is
/// the whole reason this function exists rather than one lookup: the user's
/// PATH is `HKCU\Environment`, but the machine's is under Session Manager —
/// `HKLM\Environment` is not a key Windows creates at all. Reading `Environment`
/// under both hives therefore made the HKLM half a silent no-op, and a CLI
/// installed machine-wide (an MSI, `winget` with `--scope machine`) stayed
/// invisible to detection until the app was restarted.
#[cfg(windows)]
fn registry_path_dirs() -> Vec<PathBuf> {
    use std::collections::HashSet;
    use windows::core::{w, PCWSTR};
    use windows::Win32::System::Registry::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};

    let hives = [
        (
            HKEY_LOCAL_MACHINE,
            PCWSTR(w!(r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment").as_ptr()),
        ),
        (HKEY_CURRENT_USER, PCWSTR(w!("Environment").as_ptr())),
    ];

    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for (hkey, subkey) in hives {
        if let Some(value) = registry_path_value(hkey, subkey) {
            for dir in std::env::split_paths(&value) {
                if seen.insert(dir.clone()) {
                    out.push(dir);
                }
            }
        }
    }
    out
}

/// Read the current `Path` value under `hkey\subkey` and expand its `%VAR%`
/// references. Returns `None` when the key or value is missing or empty — which
/// is the ordinary answer for a hive that has no `Path` of its own, not an
/// error worth surfacing.
#[cfg(windows)]
fn registry_path_value(
    hkey: windows::Win32::System::Registry::HKEY,
    subkey: windows::core::PCWSTR,
) -> Option<String> {
    use windows::core::{w, PCWSTR};
    use windows::Win32::System::Environment::ExpandEnvironmentStringsW;
    use windows::Win32::System::Registry::{
        RegGetValueW, RRF_RT_REG_EXPAND_SZ, RRF_RT_REG_SZ,
    };

    // 32 KiB matches the maximum size Windows returns for an environment
    // value; anything beyond that is not a PATH anyone can use.
    let mut buffer = [0u16; 32768];
    let mut len = (buffer.len() * 2) as u32;
    let result = unsafe {
        RegGetValueW(
            hkey,
            subkey,
            PCWSTR(w!("Path").as_ptr()),
            RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ,
            None,
            Some(buffer.as_mut_ptr().cast()),
            Some(&mut len),
        )
    };
    if result.is_err() {
        return None;
    }
    let chars = (len as usize / 2).min(buffer.len());
    let text = String::from_utf16_lossy(&buffer[..chars]);
    let text = text.trim_end_matches('\0');
    if text.is_empty() {
        return None;
    }

    let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    let mut expanded = vec![0u16; 32768];
    let written = unsafe { ExpandEnvironmentStringsW(PCWSTR(wide.as_ptr()), Some(&mut expanded)) };
    if written == 0 {
        return Some(text.to_string());
    }
    // `written` is chars including the NUL. When the result outgrows the
    // buffer the API returns the *required* size rather than the copied count,
    // so clamp before slicing — a PATH beyond 32 KiB is absurd, but a panic
    // in a GUI app is not the right answer to it either.
    let end = (written as usize - 1).min(expanded.len());
    Some(String::from_utf16_lossy(&expanded[..end]))
}

/// Stream `path` looking for any of `RULES_LITERALS`, case-insensitively.
///
/// Chunked with an overlap of `needle - 1` bytes so a literal straddling a chunk
/// boundary is still found — the whole point of streaming is not holding a
/// 138 MB binary in memory, and a naive chunk loop would silently miss matches.
fn file_contains_literal(path: &Path) -> Option<&'static str> {
    let size = std::fs::metadata(path).ok()?.len();
    if size == 0 || size > MAX_SCAN_FILE_BYTES {
        return None;
    }
    let mut file = std::fs::File::open(path).ok()?;

    const CHUNK: usize = 1024 * 1024;
    let overlap = RULES_LITERALS.iter().map(|l| l.len()).max().unwrap_or(0).saturating_sub(1);
    let finders: Vec<(memchr::memmem::Finder<'_>, &'static str)> = RULES_LITERALS
        .iter()
        .map(|l| (memchr::memmem::Finder::new(l.as_bytes()), *l))
        .collect();
    let mut buf = vec![0u8; CHUNK + overlap];
    let mut carry = 0usize;

    loop {
        let read = match file.read(&mut buf[carry..]) {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) => break,
        };
        let filled = carry + read;
        buf[..filled].make_ascii_lowercase();
        let window = &buf[..filled];
        for (finder, literal) in &finders {
            if finder.find(window).is_some() {
                return Some(literal);
            }
        }
        // Keep the tail so a literal spanning the boundary still matches.
        carry = overlap.min(filled);
        buf.copy_within(filled - carry..filled, 0);
    }
    None
}

/// Files a launcher shim points at.
///
/// npm installs a CLI as a tiny `.cmd`/`.ps1`/sh trio that just execs the real
/// entry point — `codex.cmd` is nine lines ending in
/// `"%dp0%\node_modules\@openai\codex\bin\codex.js"`. Scanning the shim finds
/// nothing, so the referenced path is what has to be read. Placeholders for the
/// shim's own directory (`%dp0%`, `%~dp0`, `$basedir`) resolve against it.
fn shim_targets(shim: &Path) -> Vec<PathBuf> {
    let Ok(text) = std::fs::read_to_string(shim) else {
        return Vec::new();
    };
    let Some(dir) = shim.parent() else {
        return Vec::new();
    };

    let mut out: Vec<PathBuf> = Vec::new();
    for raw in text.split(['"', '\'', '\n', '\r', ' ', '\t', '(', ')']) {
        let token = raw.trim();
        if token.is_empty() {
            continue;
        }
        let lower = token.to_ascii_lowercase();
        let interesting = lower.contains("node_modules")
            || lower.ends_with(".js")
            || lower.ends_with(".mjs")
            || lower.ends_with(".cjs");
        if !interesting {
            continue;
        }
        let cleaned = token
            .replace("%~dp0", "")
            .replace("%dp0%", "")
            .replace("${basedir}", "")
            .replace("$basedir", "")
            .replace('\\', "/");
        let cleaned = cleaned.trim_start_matches('/');
        if cleaned.is_empty() {
            continue;
        }
        let candidate = dir.join(cleaned);
        if candidate.is_file() && !out.contains(&candidate) {
            out.push(candidate);
        }
    }
    out
}

/// Files in `dir` and its subdirectories, bounded in both count and depth so
/// following a shim into `node_modules` can never turn into a full tree walk.
///
/// The depth has to be generous: npm packages bury the real binary a long way
/// down. Codex's is seven levels below its package root, at
/// `@openai/codex/node_modules/@openai/codex-win32-x64/vendor/<triple>/bin/codex.exe`,
/// and a shallower sweep silently reported "no rules file" for it. The file
/// count cap, not the depth, is what keeps this cheap — and only *reading* files
/// costs real time, which the caller caps separately.
fn nearby_files(dir: &Path, depth: usize, out: &mut Vec<(u64, PathBuf)>) {
    if depth == 0 || out.len() > 200 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_file() {
            if meta.len() <= MAX_SCAN_FILE_BYTES {
                out.push((meta.len(), path));
            }
        } else if meta.is_dir() {
            nearby_files(&path, depth - 1, out);
        }
    }
}

/// Scan the program's own file for a rules-file literal, following a small shim
/// to its siblings. Returns the file that matched and the literal found.
fn scan_program_bytes(executable: &str) -> Option<(String, &'static str)> {
    let path = which(executable)?;
    let name = |p: &Path| p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();

    if let Some(literal) = file_contains_literal(&path) {
        return Some((name(&path), literal));
    }

    // Only a launcher shim sends us looking elsewhere. A real binary that does
    // not name a rules file simply does not read one.
    let is_shim = std::fs::metadata(&path).map(|m| m.len() <= SHIM_MAX_BYTES).unwrap_or(false);
    if !is_shim {
        return None;
    }

    let mut budget = MAX_SCAN_TOTAL_BYTES;
    let scan = |candidate: &Path, budget: &mut u64| -> Option<&'static str> {
        let len = std::fs::metadata(candidate).ok()?.len();
        if len > *budget {
            return None;
        }
        *budget -= len;
        file_contains_literal(candidate)
    };

    // What the shim itself points at — `codex.cmd` → `.../codex/bin/codex.js`.
    let targets = shim_targets(&path);
    for target in &targets {
        if let Some(literal) = scan(target, &mut budget) {
            return Some((name(target), literal));
        }
    }

    // That entry point is often another launcher (`codex.js` spawns a platform
    // binary in a sibling `vendor/` dir), so sweep the package it lives in.
    let mut candidates: Vec<(u64, PathBuf)> = Vec::new();
    for target in &targets {
        if let Some(package_dir) = target.parent().and_then(|d| d.parent()) {
            nearby_files(package_dir, 8, &mut candidates);
        }
    }
    // `cursor-agent.cmd` is a 363-byte launcher whose bundle simply sits beside
    // it, named nowhere in the shim.
    if let Some(dir) = path.parent() {
        nearby_files(dir, 1, &mut candidates);
    }
    candidates.sort_by_key(|c| std::cmp::Reverse(c.0));
    candidates.dedup_by(|a, b| a.1 == b.1);

    for (_, candidate) in candidates.into_iter().take(MAX_SIBLINGS) {
        if candidate == path {
            continue;
        }
        if let Some(literal) = scan(&candidate, &mut budget) {
            return Some((name(&candidate), literal));
        }
    }
    None
}

/// Probe a launch command for rules-file support. Never fails the caller: a
/// binary we cannot find or run comes back as `ran: false`, which the UI reports
/// as "couldn't check" rather than "does not read rules files".
#[tauri::command(async)]
pub fn agent_probe_rules_file(command: String) -> AgentRulesProbe {
    let Some(executable) = extract_executable(&command) else {
        return AgentRulesProbe::failed(String::new(), "No launch command to check");
    };

    // Pass 1: help text. Cheap, and when it hits it is the most legible evidence
    // to show the user.
    let help = capture_help(&executable);
    if let Ok(text) = &help {
        if let Some(marker) = find_rules_marker(text) {
            return AgentRulesProbe {
                executable: executable.clone(),
                reads_rules_file: true,
                ran: true,
                evidence: Some(format!("{executable} --help mentions “{marker}”")),
                error: None,
            };
        }
    }

    // Pass 2: the program's own bytes.
    if let Some((file, literal)) = scan_program_bytes(&executable) {
        return AgentRulesProbe {
            executable,
            reads_rules_file: true,
            ran: true,
            evidence: Some(format!("{file} contains the name “{literal}”")),
            error: None,
        };
    }

    match help {
        // Ran the CLI, scanned its bytes, found nothing either way.
        Ok(_) => AgentRulesProbe {
            executable,
            reads_rules_file: false,
            ran: true,
            evidence: None,
            error: None,
        },
        // Could not even run it — say so rather than claiming "no support".
        Err(error) => AgentRulesProbe::failed(executable, error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The machine hive really does yield a PATH.
    ///
    /// This is the regression guard for reading `Path` out of the wrong subkey.
    /// `HKLM\Environment` — the key this used to query — does not exist on
    /// Windows, so the old code took the `None` branch on every machine and
    /// quietly contributed nothing: anything installed machine-wide stayed
    /// undetected. Asserting on the *presence* of a directory list rather than
    /// on any particular entry keeps this true on any Windows box, while still
    /// failing outright if the subkey regresses.
    #[cfg(windows)]
    #[test]
    fn the_machine_hive_contributes_real_directories() {
        use windows::core::{w, PCWSTR};
        use windows::Win32::System::Registry::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};

        let machine = registry_path_value(
            HKEY_LOCAL_MACHINE,
            PCWSTR(w!(r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment").as_ptr()),
        )
        .expect("machine PATH is readable from the Session Manager subkey");
        assert!(
            std::env::split_paths(&machine).any(|dir| dir.is_dir()),
            "machine PATH held no existing directory: {machine}"
        );

        // The user hive keeps its PATH somewhere else, and both must resolve —
        // reading one subkey for both hives is the bug this pair pins down.
        let user = registry_path_value(HKEY_CURRENT_USER, PCWSTR(w!("Environment").as_ptr()));
        assert!(user.is_some(), "user PATH is readable from HKCU\\Environment");

        // And the merge that `which` searches carries the machine entries.
        assert!(!registry_path_dirs().is_empty());
    }

    #[test]
    fn extracts_a_plain_program() {
        assert_eq!(extract_executable("claude").as_deref(), Some("claude"));
        assert_eq!(extract_executable("  aider  ").as_deref(), Some("aider"));
    }

    #[test]
    fn ignores_the_users_arguments() {
        assert_eq!(
            extract_executable("mytool deploy --prod --force").as_deref(),
            Some("mytool")
        );
    }

    #[test]
    fn skips_env_assignments_and_launchers() {
        assert_eq!(extract_executable("FOO=bar codex").as_deref(), Some("codex"));
        assert_eq!(extract_executable("npx opencode").as_deref(), Some("opencode"));
        assert_eq!(extract_executable("sudo NICE=1 aider").as_deref(), Some("aider"));
    }

    #[test]
    fn strips_paths_quotes_and_windows_extensions() {
        assert_eq!(
            extract_executable(r#""C:\Users\me\.grok\bin\grok.exe" --resume"#).as_deref(),
            Some("grok")
        );
        assert_eq!(
            extract_executable("/usr/local/bin/cursor-agent").as_deref(),
            Some("cursor-agent")
        );
        assert_eq!(extract_executable("agent.cmd").as_deref(), Some("agent"));
    }

    #[test]
    fn rejects_empty_input() {
        assert!(extract_executable("").is_none());
        assert!(extract_executable("   ").is_none());
    }

    #[test]
    fn finds_markers_case_insensitively() {
        assert_eq!(
            find_rules_marker("Reads AGENTS.md from the project root"),
            Some("agents.md")
        );
        assert_eq!(
            find_rules_marker("--rules <RULES>  Extra rules to append"),
            None,
            "a bare --rules flag is not a rules *file*"
        );
        assert_eq!(
            find_rules_marker("Loads project instructions at startup"),
            Some("project instructions")
        );
    }

    fn temp_file(name: &str, contents: &[u8]) -> PathBuf {
        let path = std::env::temp_dir().join(format!("spacron-probe-{name}"));
        std::fs::write(&path, contents).expect("write temp file");
        path
    }

    #[test]
    fn finds_a_literal_in_a_files_bytes() {
        let path = temp_file("hit.bin", b"\x00\x01binary junk AGENTS.md more junk\xff");
        assert_eq!(file_contains_literal(&path), Some("agents.md"));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn finds_a_literal_split_across_a_chunk_boundary() {
        // 1 MB of filler puts the literal astride the 1 MB read boundary, which
        // a chunk loop without overlap would miss entirely.
        let mut bytes = vec![b'x'; 1024 * 1024 - 4];
        bytes.extend_from_slice(b"CLAUDE.md");
        bytes.extend_from_slice(&[b'y'; 128]);
        let path = temp_file("boundary.bin", &bytes);
        assert_eq!(file_contains_literal(&path), Some("claude.md"));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn reports_no_literal_for_an_unrelated_file() {
        let path = temp_file("miss.bin", b"just some ordinary program bytes");
        assert_eq!(file_contains_literal(&path), None);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn ignores_an_empty_file() {
        let path = temp_file("empty.bin", b"");
        assert_eq!(file_contains_literal(&path), None);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn reports_a_missing_binary_without_claiming_no_support() {
        let probe = agent_probe_rules_file("spacron-no-such-binary-xyz".to_string());
        assert!(!probe.ran);
        assert!(!probe.reads_rules_file);
        assert!(probe.error.is_some());
    }

    /// Measures the heuristic against whichever agent CLIs are installed here.
    /// Ignored by default — the result depends on the machine, so it is a tool
    /// for re-checking accuracy, not a gate:
    ///
    /// ```text
    /// cargo test --lib agent_probe -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore = "depends on which CLIs are installed on this machine"]
    fn measure_against_installed_clis() {
        // The first group reads AGENTS.md/CLAUDE.md; the second must not be
        // mistaken for an agent CLI. The registry agents added 2026-08 live in
        // the first group so the probe's help-text + byte-scan heuristics can be
        // re-measured against real installs as this machine changes — read the
        // output, don't gate on it (known oddity: `copilot` is a legitimate
        // false negative, its file discovery happens server-side).
        let expected_true = [
            "claude", "codex", "cursor-agent", "grok", "opencode",
            // Wider registry (added 2026-08): droid and devin carry the
            // AGENTS.md literal in their native binaries; kilo / omp /
            // command-code resolve through shims the scan follows.
            "droid", "copilot", "devin", "kilo", "omp", "command-code",
            // codebuff/freebuff added 2026-08-12 (AGENTS.md/CLAUDE.md knowledge
            // files, verified in CodebuffAI/codebuff source). Caveat: the npm
            // shim the probe follows is a launcher with no literals — the
            // authoritative scan is the downloaded binary under
            // `~/.config/manicode/` (freebuff.exe carries both literals), so a
            // probe miss here is a shim limitation, same class as copilot.
            "codebuff", "freebuff",
            // pi/omp added 2026-08-12 (AGENTS.md/CLAUDE.md context files,
            // verified in the installed bundles). Caveat: `omp` resolves through
            // Bun's `omp.bunx` shim, which is UTF-16LE — `shim_targets` only
            // reads UTF-8 text, so the probe reports reads=false for omp even
            // though the real bundle loads AGENTS.md/CLAUDE.md. Same class as
            // copilot/freebuff: the installed bundle is the authority.
            "pi", "omp",
        ];
        let expected_false = ["git", "node"];

        for exe in expected_true.iter().chain(expected_false.iter()) {
            if which(exe).is_none() {
                println!("{exe:>14}  (not installed)");
                continue;
            }
            let probe = agent_probe_rules_file((*exe).to_string());
            println!(
                "{exe:>14}  reads={:<5} ran={:<5} {}",
                probe.reads_rules_file,
                probe.ran,
                probe.evidence.or(probe.error).unwrap_or_default()
            );
        }
    }
}
