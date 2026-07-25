use std::path::Path;

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct ShellConfig {
    pub program: String,
    pub args: Vec<String>,
}

/// Returns available shells on this system
pub fn available_shells() -> Vec<ShellConfig> {
    let mut shells = Vec::new();

    if cfg!(target_os = "windows") {
        // PowerShell 7 (pwsh)
        if let Some(path) = which("pwsh") {
            shells.push(ShellConfig {
                program: path,
                args: vec!["-NoLogo".into(), "-NoProfile".into()],
            });
        }
        // Windows PowerShell 5
        if let Some(path) = which("powershell").or_else(|| which("powershell.exe")) {
            shells.push(ShellConfig {
                program: path,
                args: vec!["-NoLogo".into(), "-NoProfile".into()],
            });
        }
        // CMD
        shells.push(ShellConfig {
            program: std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into()),
            args: vec![],
        });
        // Git Bash
        for git_bash in &[
            r"C:\Program Files\Git\bin\bash.exe",
            r"C:\Program Files (x86)\Git\bin\bash.exe",
        ] {
            if Path::new(git_bash).exists() {
                shells.push(ShellConfig {
                    program: git_bash.to_string(),
                    args: vec!["--login".into(), "-i".into()],
                });
                break;
            }
        }
        // WSL bash
        if which("wsl").is_some() {
            shells.push(ShellConfig {
                program: "wsl".into(),
                args: vec![],
            });
        }
    } else {
        // The user's own login shell comes first — it's what they actually use,
        // and hardcoded paths miss it constantly: a Homebrew bash on macOS lives
        // at /opt/homebrew/bin/bash, and on NixOS/Alpine/minimal containers
        // /bin/zsh and /bin/bash may not exist at all (only /bin/sh does), which
        // left this list empty and the shell picker with nothing to show.
        // `detect_shell` already honoured $SHELL; `available_shells` did not, so
        // the auto-detected default could not be re-selected by name once the
        // user switched away from it.
        if let Ok(shell) = std::env::var("SHELL") {
            if Path::new(&shell).is_file() {
                shells.push(ShellConfig {
                    program: shell,
                    args: vec!["-l".into()],
                });
            }
        }
        for sh in &["/bin/zsh", "/bin/bash", "/bin/sh"] {
            if Path::new(sh).exists() {
                shells.push(ShellConfig {
                    program: sh.to_string(),
                    args: vec!["-l".into()],
                });
            }
        }
        for shell in &["fish", "nu", "elvish", "xonsh"] {
            if let Some(p) = which(shell) {
                shells.push(ShellConfig {
                    program: p,
                    args: if *shell == "fish" {
                        vec!["-l".into()]
                    } else {
                        // Only fish shares the POSIX `-l` spelling; nu/elvish/xonsh
                        // either reject it or treat it as a file argument.
                        vec![]
                    },
                });
            }
        }
        // $SHELL frequently duplicates one of the well-known paths above.
        // Deduplicate on the program so the picker doesn't list it twice.
        let mut seen = std::collections::HashSet::new();
        shells.retain(|s| seen.insert(s.program.clone()));
    }

    shells
}

fn which(prog: &str) -> Option<String> {
    let prog_path = Path::new(prog);
    if prog_path.is_absolute() || prog_path.components().count() > 1 {
        if prog_path.is_file() {
            return Some(prog.to_string());
        }
        if cfg!(target_os = "windows") {
            for ext in &[".exe", ".cmd", ".bat"] {
                let p_ext = prog_path.with_extension(ext.trim_start_matches('.'));
                if p_ext.is_file() {
                    return Some(p_ext.to_string_lossy().to_string());
                }
            }
        }
        return None;
    }

    let path_var = std::env::var_os("PATH")?;
    let paths = std::env::split_paths(&path_var);
    for dir in paths {
        let p = dir.join(prog);
        if p.is_file() {
            return Some(p.to_string_lossy().to_string());
        }
        if cfg!(target_os = "windows") {
            for ext in &[".exe", ".cmd", ".bat"] {
                let p_ext = dir.join(format!("{}{}", prog, ext));
                if p_ext.is_file() {
                    return Some(p_ext.to_string_lossy().to_string());
                }
            }
        }
    }
    None
}

pub fn detect_shell() -> ShellConfig {
    // On Unix, honour the user's configured login shell first.
    #[cfg(not(target_os = "windows"))]
    if let Ok(shell) = std::env::var("SHELL") {
        if Path::new(&shell).is_file() {
            return ShellConfig {
                program: shell,
                args: vec!["-l".into()],
            };
        }
    }

    let shells = available_shells();

    // On Windows the auto-detected default must never be Windows PowerShell 5.1.
    // Its in-box PSReadLine 2.0.0 renders a blank prompt under the ConPTY pseudo-
    // console (cmd and PowerShell 7 are unaffected), so picking it as the default
    // shows users an empty terminal out of the box. Prefer PowerShell 7 (`pwsh`,
    // ships a modern PSReadLine that renders correctly), then fall back to cmd,
    // which is rock-solid under ConPTY. Windows PowerShell 5.1 stays in
    // `available_shells()` so users can still select it explicitly.
    #[cfg(target_os = "windows")]
    {
        if let Some(pwsh) = shells.iter().find(|s| {
            Path::new(&s.program)
                .file_stem()
                .and_then(|n| n.to_str())
                .map(|stem| stem.eq_ignore_ascii_case("pwsh"))
                .unwrap_or(false)
        }) {
            return pwsh.clone();
        }
        if let Some(cmd) = shells.iter().find(|s| {
            Path::new(&s.program)
                .file_stem()
                .and_then(|n| n.to_str())
                .map(|stem| stem.eq_ignore_ascii_case("cmd"))
                .unwrap_or(false)
        }) {
            return cmd.clone();
        }
    }

    shells.into_iter().next().unwrap_or_else(|| {
        if cfg!(target_os = "windows") {
            ShellConfig {
                program: std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into()),
                args: vec![],
            }
        } else {
            ShellConfig {
                program: "/bin/sh".into(),
                args: vec!["-l".into()],
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The picker must never come back empty — a distro without /bin/bash or
    /// /bin/zsh (NixOS, Alpine, slim containers) used to produce exactly that.
    #[test]
    fn available_shells_is_never_empty() {
        assert!(
            !available_shells().is_empty(),
            "at least one shell must always be offered"
        );
    }

    /// Whatever `detect_shell` picks has to be selectable again by name, which
    /// means it must appear in the list `terminal_create` validates against.
    /// On Unix `detect_shell` honours $SHELL, so $SHELL has to be in the list.
    #[test]
    fn detected_shell_is_offered_in_the_list() {
        let detected = detect_shell();
        let shells = available_shells();
        assert!(
            shells.iter().any(|s| s.program == detected.program),
            "detect_shell chose {:?}, which available_shells() does not offer: {:?}",
            detected.program,
            shells.iter().map(|s| &s.program).collect::<Vec<_>>()
        );
    }

    #[test]
    fn shells_are_not_listed_twice() {
        let shells = available_shells();
        let mut seen = std::collections::HashSet::new();
        for s in &shells {
            assert!(seen.insert(&s.program), "duplicate shell entry: {}", s.program);
        }
    }
}
