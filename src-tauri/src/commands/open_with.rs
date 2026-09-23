use super::{agent_probe, clean_path_buf};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ExternalApp {
    VsCode,
    Codex,
}

impl ExternalApp {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "vscode" => Ok(Self::VsCode),
            "codex" => Ok(Self::Codex),
            _ => Err("Unsupported external app".to_string()),
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::VsCode => "VS Code",
            Self::Codex => "Codex",
        }
    }

    fn args(self, path: &Path) -> Vec<OsString> {
        match self {
            Self::VsCode => vec![
                OsString::from("--reuse-window"),
                path.as_os_str().to_owned(),
            ],
            Self::Codex => vec![OsString::from("app"), path.as_os_str().to_owned()],
        }
    }
}

fn resolve_vscode() -> Result<PathBuf, String> {
    let executable = agent_probe::which("code").ok_or_else(|| {
        "VS Code was not found. Install it and make its `code` command available.".to_string()
    })?;

    #[cfg(windows)]
    {
        if executable
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("cmd"))
        {
            let code_exe = executable
                .parent()
                .and_then(Path::parent)
                .map(|install_dir| install_dir.join("Code.exe"));
            if let Some(code_exe) = code_exe.filter(|candidate| candidate.is_file()) {
                return Ok(code_exe);
            }
            return Err(
                "VS Code's `code` command was found, but its Code.exe could not be located."
                    .to_string(),
            );
        }
    }

    Ok(executable)
}

#[cfg(windows)]
fn codex_vendor_executable(package_root: &Path) -> Option<PathBuf> {
    let (package, triple) = match std::env::consts::ARCH {
        "x86_64" => ("codex-win32-x64", "x86_64-pc-windows-msvc"),
        "aarch64" => ("codex-win32-arm64", "aarch64-pc-windows-msvc"),
        "x86" => ("codex-win32-x86", "i686-pc-windows-msvc"),
        _ => return None,
    };
    let executable = package_root
        .join("node_modules")
        .join("@openai")
        .join(package)
        .join("vendor")
        .join(triple)
        .join("bin")
        .join("codex.exe");
    executable.is_file().then_some(executable)
}

fn resolve_codex() -> Result<PathBuf, String> {
    #[cfg(windows)]
    {
        if let Some(executable) = agent_probe::which("codex.exe") {
            return Ok(executable);
        }

        // The npm launcher is a shell shim. Resolve its JavaScript entry point,
        // then launch the bundled native binary directly so a GUI-launched app
        // does not depend on Node being present in its inherited PATH.
        let shim = agent_probe::which("codex.cmd")
            .or_else(|| agent_probe::which("codex.ps1"))
            .or_else(|| agent_probe::which("codex"))
            .ok_or_else(|| {
                "Codex CLI was not found. Install Codex CLI to open projects in Codex.".to_string()
            })?;
        let entry = agent_probe::shim_targets(&shim)
            .into_iter()
            .find(|target| {
                target
                    .file_name()
                    .is_some_and(|name| name.eq_ignore_ascii_case("codex.js"))
            })
            .ok_or_else(|| {
                "Could not resolve Codex's native launcher. Reinstall Codex CLI and try again."
                    .to_string()
            })?;
        let package_root = entry.parent().and_then(Path::parent).ok_or_else(|| {
            "Could not resolve Codex's native launcher. Reinstall Codex CLI and try again."
                .to_string()
        })?;
        return codex_vendor_executable(package_root).ok_or_else(|| {
            "Could not find Codex's native Windows binary. Reinstall Codex CLI and try again."
                .to_string()
        });
    }

    #[cfg(not(windows))]
    {
        agent_probe::which("codex").ok_or_else(|| {
            "Codex CLI was not found. Install Codex CLI to open projects in Codex.".to_string()
        })
    }
}

fn quiet_command(executable: &Path) -> Command {
    let mut command = Command::new(executable);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

#[tauri::command]
pub fn workspace_open_with_app(app: String, path: String) -> Result<(), String> {
    let app = ExternalApp::parse(&app)?;
    let path = PathBuf::from(path)
        .canonicalize()
        .map(clean_path_buf)
        .map_err(|error| format!("Could not open this project folder: {error}"))?;
    if !path.is_dir() {
        return Err("Open with an external app is available for project folders only.".to_string());
    }

    let executable = match app {
        ExternalApp::VsCode => resolve_vscode(),
        ExternalApp::Codex => resolve_codex(),
    }?;
    quiet_command(&executable)
        .args(app.args(&path))
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Could not open the project in {}: {error}", app.label()))
}

#[cfg(test)]
mod tests {
    use super::ExternalApp;
    use std::ffi::OsString;
    use std::path::Path;

    #[test]
    fn only_known_external_apps_are_accepted() {
        assert_eq!(ExternalApp::parse("vscode"), Ok(ExternalApp::VsCode));
        assert_eq!(ExternalApp::parse("codex"), Ok(ExternalApp::Codex));
        assert!(ExternalApp::parse("powershell").is_err());
    }

    #[test]
    fn app_args_keep_a_spaced_folder_path_as_one_argument() {
        let path = Path::new("C:/Projects/Real Project");
        assert_eq!(
            ExternalApp::VsCode.args(path),
            vec![
                OsString::from("--reuse-window"),
                path.as_os_str().to_owned()
            ],
        );
        assert_eq!(
            ExternalApp::Codex.args(path),
            vec![OsString::from("app"), path.as_os_str().to_owned()],
        );
    }
}
