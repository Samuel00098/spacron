use std::path::PathBuf;

/// A language server definition: the executable to look for and the args it
/// needs to talk LSP over stdio.
#[derive(Clone, Debug)]
pub struct ServerDef {
    /// The Spacron language id (matches `detectLanguage` on the frontend).
    pub language: &'static str,
    /// Base command name to resolve on PATH (without extension).
    pub command: &'static str,
    /// Arguments that put the server in stdio LSP mode.
    pub args: &'static [&'static str],
    /// Human-friendly install hint shown when the server isn't found.
    pub install_hint: &'static str,
    /// Program to run to install the server (e.g. "npm", "rustup", "go").
    pub install_program: &'static str,
    /// Arguments to the install program.
    pub install_args: &'static [&'static str],
}

/// The languages we ship LSP support for. Each entry is a server that speaks
/// LSP over stdin/stdout. Servers are NOT bundled — we detect them on the user's
/// PATH and surface an install hint when missing.
pub const SERVERS: &[ServerDef] = &[
    ServerDef {
        language: "typescript",
        command: "typescript-language-server",
        args: &["--stdio"],
        install_hint: "npm install -g typescript-language-server typescript",
        install_program: "npm",
        install_args: &["install", "-g", "typescript-language-server", "typescript"],
    },
    ServerDef {
        language: "javascript",
        command: "typescript-language-server",
        args: &["--stdio"],
        install_hint: "npm install -g typescript-language-server typescript",
        install_program: "npm",
        install_args: &["install", "-g", "typescript-language-server", "typescript"],
    },
    ServerDef {
        language: "rust",
        command: "rust-analyzer",
        args: &[],
        install_hint: "rustup component add rust-analyzer",
        install_program: "rustup",
        install_args: &["component", "add", "rust-analyzer"],
    },
    ServerDef {
        language: "python",
        command: "pyright-langserver",
        args: &["--stdio"],
        install_hint: "npm install -g pyright",
        install_program: "npm",
        install_args: &["install", "-g", "pyright"],
    },
    ServerDef {
        language: "go",
        command: "gopls",
        args: &[],
        install_hint: "go install golang.org/x/tools/gopls@latest",
        install_program: "go",
        install_args: &["install", "golang.org/x/tools/gopls@latest"],
    },
];

pub fn lookup(language: &str) -> Option<&'static ServerDef> {
    SERVERS.iter().find(|s| s.language == language)
}

/// A resolved, launchable command: the absolute program path plus the leading
/// args required to run it. On Windows, `.cmd`/`.bat` shims (how npm installs
/// `typescript-language-server` / `pyright-langserver`) can't be CreateProcess'd
/// directly, so they're wrapped in `cmd /c`.
#[derive(Clone, Debug)]
pub struct ResolvedCommand {
    pub program: String,
    pub args: Vec<String>,
}

/// Resolve a base command name to a concrete launchable command by searching
/// PATH (and, on Windows, PATHEXT). Returns None if nothing is found.
pub fn resolve(def: &ServerDef) -> Option<ResolvedCommand> {
    let found = find_on_path(def.command)?;
    build_command(found, def.args)
}

/// Resolve the install command (e.g. `npm install -g …`). Returns None when the
/// install tool itself (npm/rustup/go) isn't on PATH.
pub fn resolve_install(def: &ServerDef) -> Option<ResolvedCommand> {
    let found = find_on_path(def.install_program)?;
    build_command(found, def.install_args)
}

#[cfg(windows)]
fn build_command(path: PathBuf, args: &[&str]) -> Option<ResolvedCommand> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());
    let path_str = path.to_string_lossy().to_string();

    match ext.as_deref() {
        // Batch shims must run through the command interpreter.
        Some("cmd") | Some("bat") => {
            let mut full = vec!["/c".to_string(), path_str];
            full.extend(args.iter().map(|a| a.to_string()));
            Some(ResolvedCommand {
                program: "cmd".to_string(),
                args: full,
            })
        }
        _ => Some(ResolvedCommand {
            program: path_str,
            args: args.iter().map(|a| a.to_string()).collect(),
        }),
    }
}

#[cfg(not(windows))]
fn build_command(path: PathBuf, args: &[&str]) -> Option<ResolvedCommand> {
    Some(ResolvedCommand {
        program: path.to_string_lossy().to_string(),
        args: args.iter().map(|a| a.to_string()).collect(),
    })
}

/// Search the PATH for `command`, honouring Windows executable extensions.
///
/// Candidates are grouped into passes: every extension-bearing name is tried
/// across the whole PATH before the extensionless fallback is tried anywhere.
/// Without that, a directory early on PATH holding only the bare MSYS shell
/// script (Node's `npm`, npm's `typescript-language-server`) shadows the
/// `.cmd` shim that Windows can actually execute.
fn find_on_path(command: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    let dirs: Vec<PathBuf> = std::env::split_paths(&path_var).collect();

    for candidates in candidate_passes(command) {
        for dir in &dirs {
            for candidate in &candidates {
                let full = dir.join(candidate);
                if full.is_file() {
                    return Some(full);
                }
            }
        }
    }
    None
}

/// Split `extension_candidates` into priority passes: extension-bearing names
/// first, the extensionless name (if any) as a separate, lower-priority pass.
fn candidate_passes(command: &str) -> Vec<Vec<String>> {
    let all = extension_candidates(command);
    let (bare, with_ext): (Vec<String>, Vec<String>) =
        all.into_iter().partition(|c| c == command);
    [with_ext, bare]
        .into_iter()
        .filter(|pass| !pass.is_empty())
        .collect()
}

#[cfg(windows)]
fn extension_candidates(command: &str) -> Vec<String> {
    // If the caller already gave an extension, trust it.
    if PathBuf::from(command).extension().is_some() {
        return vec![command.to_string()];
    }
    let pathext = std::env::var("PATHEXT")
        .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
    let mut candidates = Vec::new();
    for ext in pathext.split(';') {
        let ext = ext.trim();
        if ext.is_empty() {
            continue;
        }
        // PATHEXT entries include the leading dot.
        candidates.push(format!("{command}{}", ext.to_ascii_lowercase()));
    }
    // Extensionless LAST. Node ships both `npm` (a bash script for MSYS/Cygwin)
    // and `npm.cmd` in the same directory, and npm's global bin does the same for
    // `typescript-language-server` / `pyright-langserver`. CreateProcess can only
    // run the `.cmd`; handing it the bare script fails with
    // "%1 is not a valid Win32 application" (os error 193).
    candidates.push(command.to_string());
    candidates
}

#[cfg(not(windows))]
fn extension_candidates(command: &str) -> Vec<String> {
    vec![command.to_string()]
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn executable_extensions_outrank_the_bare_name() {
        let passes = candidate_passes("npm");
        assert_eq!(passes.len(), 2, "expected an ext pass and a bare pass");
        assert!(
            passes[0].iter().any(|c| c == "npm.cmd"),
            "npm.cmd must be in the first pass, got {:?}",
            passes[0]
        );
        assert!(
            !passes[0].iter().any(|c| c == "npm"),
            "the extensionless MSYS script must not be in the first pass"
        );
        assert_eq!(passes[1], vec!["npm".to_string()]);
    }

    #[test]
    fn an_explicit_extension_is_taken_as_given() {
        assert_eq!(candidate_passes("npm.cmd"), vec![vec!["npm.cmd".to_string()]]);
    }

    #[test]
    fn cmd_shims_are_wrapped_in_the_command_interpreter() {
        let resolved = build_command(PathBuf::from(r"C:\bin\npm.cmd"), &["install"]).unwrap();
        assert_eq!(resolved.program, "cmd");
        assert_eq!(resolved.args, vec!["/c", r"C:\bin\npm.cmd", "install"]);
    }
}

