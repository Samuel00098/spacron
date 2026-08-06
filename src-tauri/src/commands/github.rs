//! GitHub integration: store a personal access token in the OS keychain and use
//! it to create a new repository on the user's account, then publish the current
//! project to it. The token lives only in the keychain — it is never passed
//! through the frontend or written to `.git/config`.

use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine;
use keyring::{Entry, Error as KeyringError};
use tauri::State;

use crate::commands::workspace::{classify_push_error, git_base, sanitize_git_error};
use crate::state::AppState;
use crate::workspace::project::Project;

const KEYCHAIN_SERVICE: &str = "com.samue.spacron";
const GITHUB_TOKEN_USERNAME: &str = "github_token";
const GITHUB_API: &str = "https://api.github.com";

fn token_entry() -> Result<Entry, String> {
    Entry::new(KEYCHAIN_SERVICE, GITHUB_TOKEN_USERNAME)
        .map_err(|e| format!("Failed to access the system keychain: {e}"))
}

/// Save (or, when empty, clear) the GitHub personal access token in the keychain.
#[tauri::command]
pub fn github_token_set(token: String) -> Result<(), String> {
    let token = token.trim().to_string();
    let entry = token_entry()?;
    if token.is_empty() {
        return match entry.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
            Err(e) => Err(format!("Failed to remove the token: {e}")),
        };
    }
    if token.len() > 512 || token.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("That doesn't look like a valid token.".to_string());
    }
    entry
        .set_password(&token)
        .map_err(|e| format!("Failed to save the token: {e}"))
}

#[tauri::command]
pub fn github_token_exists() -> Result<bool, String> {
    let entry = token_entry()?;
    match entry.get_password() {
        Ok(p) => Ok(!p.trim().is_empty()),
        Err(KeyringError::NoEntry) => Ok(false),
        Err(e) => Err(format!("Failed to check the token: {e}")),
    }
}

#[tauri::command]
pub fn github_token_delete() -> Result<(), String> {
    let entry = token_entry()?;
    match entry.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(e) => Err(format!("Failed to remove the token: {e}")),
    }
}

fn read_token() -> Result<String, String> {
    let entry = token_entry()?;
    match entry.get_password() {
        Ok(p) if !p.trim().is_empty() => Ok(p.trim().to_string()),
        Ok(_) | Err(KeyringError::NoEntry) => Err(
            "No GitHub token saved. Add a personal access token in Settings to create repositories."
                .to_string(),
        ),
        Err(e) => Err(format!("Failed to read the token: {e}")),
    }
}

/// GitHub repository names allow letters, digits, '-', '_', and '.'.
fn validate_repo_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > 100 {
        return Err("Repository name must be 1–100 characters.".to_string());
    }
    if name == "." || name == ".." {
        return Err("Invalid repository name.".to_string());
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return Err(
            "Repository name may only contain letters, numbers, '-', '_', and '.'.".to_string(),
        );
    }
    Ok(())
}

/// Run a git command, mapping failure to a sanitized error string.
fn run_git(root: &Path, args: &[&str]) -> Result<(), String> {
    let out = git_base()
        .args(args)
        .current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| format!("Failed to run git: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(sanitize_git_error(&String::from_utf8_lossy(&out.stderr)))
    }
}

/// True when the git command exits 0 (used as a predicate, output ignored).
fn git_ok(root: &Path, args: &[&str]) -> bool {
    git_base()
        .args(args)
        .current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Trimmed stdout of a successful git command, else None.
fn git_capture(root: &Path, args: &[&str]) -> Option<String> {
    let out = git_base()
        .args(args)
        .current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .ok()?;
    if out.status.success() {
        Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        None
    }
}

/// Push `branch` to origin authenticated with the token. The credential is
/// injected via per-invocation config env vars (GIT_CONFIG_*) rather than the
/// command line or `.git/config`, so it never persists and never appears in a
/// process listing. This guarantees the first push works even when no git
/// credential helper is configured.
fn push_with_token(root: &Path, token: &str, branch: &str) -> Result<(), String> {
    let cred = base64::engine::general_purpose::STANDARD.encode(format!("x-access-token:{token}"));
    let out = git_base()
        .args(["push", "-u", "origin", "--", branch])
        .current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_CONFIG_COUNT", "1")
        .env("GIT_CONFIG_KEY_0", "http.https://github.com/.extraheader")
        .env("GIT_CONFIG_VALUE_0", format!("AUTHORIZATION: basic {cred}"))
        .output()
        .map_err(|e| format!("Failed to run git push: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(classify_push_error(&String::from_utf8_lossy(&out.stderr)))
    }
}

fn github_api_error(status: reqwest::StatusCode, body: &serde_json::Value, name: &str) -> String {
    let msg = body.get("message").and_then(|v| v.as_str()).unwrap_or("");
    match status.as_u16() {
        401 => "GitHub rejected the token (401). Check that your personal access token is valid and not expired.".to_string(),
        403 => "GitHub denied the request (403). Your token may lack the 'repo' scope needed to create repositories.".to_string(),
        422 if body.to_string().contains("already exists") => {
            format!("A repository named '{name}' already exists on your account.")
        }
        422 => format!(
            "GitHub couldn't create the repository: {}",
            if msg.is_empty() { "validation failed" } else { msg }
        ),
        _ => format!(
            "GitHub returned an error ({status}): {}",
            if msg.is_empty() { "unknown error" } else { msg }
        ),
    }
}

#[derive(serde::Serialize)]
pub struct CreateRepoResult {
    pub html_url: String,
    pub full_name: String,
    /// Whether an initial commit was pushed (false for an empty project — the
    /// remote is wired up but there was nothing to push yet).
    pub pushed: bool,
}

/// Create a new repository on the authenticated user's GitHub account, wire it up
/// as `origin` for the project, and push the current branch (creating an initial
/// commit if the project has none yet).
#[tauri::command]
pub async fn workspace_github_create_repo(
    project_id: String,
    name: String,
    description: Option<String>,
    private: bool,
    state: State<'_, AppState>,
) -> Result<CreateRepoResult, String> {
    let name = name.trim().to_string();
    validate_repo_name(&name)?;
    let description = description.unwrap_or_default();
    if description.len() > 1000 {
        return Err("Description is too long (limit 1000 characters).".to_string());
    }

    let root_path = {
        let projects = state.workspace_manager.list_projects();
        let project = projects
            .iter()
            .find(|p| p.id == project_id)
            .ok_or_else(|| "Project not found".to_string())?;
        project.root_path.clone()
    };

    let token = read_token()?;

    // Refuse to hijack a project that already points somewhere — avoids
    // silently repointing an existing origin to a brand-new empty repo.
    if git_ok(&root_path, &["remote", "get-url", "origin"]) {
        return Err("This project already has an 'origin' remote. Remove it first if you want to publish to a new repository.".to_string());
    }

    // 1. Create the repository on GitHub.
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent("Spacron")
        .build()
        .map_err(|e| format!("Failed to prepare the request: {e}"))?;

    let resp = client
        .post(format!("{GITHUB_API}/user/repos"))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .bearer_auth(&token)
        .json(&serde_json::json!({
            "name": name,
            "description": description,
            "private": private,
            "auto_init": false,
        }))
        .send()
        .await
        .map_err(|e| format!("Failed to contact GitHub: {}", e.without_url()))?;

    let status = resp.status();
    let body: serde_json::Value = resp.json().await.unwrap_or(serde_json::Value::Null);
    if !status.is_success() {
        return Err(github_api_error(status, &body, &name));
    }

    let clone_url = body
        .get("clone_url")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let html_url = body
        .get("html_url")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let full_name = body
        .get("full_name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if clone_url.is_empty() {
        return Err("GitHub created the repository but returned no clone URL.".to_string());
    }

    // 2. Ensure a local git repository exists (default branch: main).
    if !root_path.join(".git").exists() {
        run_git(&root_path, &["init", "-b", "main"])?;
    }

    // 3. Ensure there is at least one commit so there's something to push. Only
    //    commit when files actually staged (an empty folder stays empty).
    if !git_ok(&root_path, &["rev-parse", "--verify", "HEAD"]) {
        run_git(&root_path, &["add", "-A"])?;
        // `diff --cached --quiet` exits non-zero when something is staged.
        if !git_ok(&root_path, &["diff", "--cached", "--quiet"]) {
            run_git(&root_path, &["commit", "-m", "Initial commit"])?;
        }
    }

    // 4. Point origin at the new repository.
    run_git(&root_path, &["remote", "add", "origin", &clone_url])?;

    // 5. Push the initial commit, if there is one.
    let branch = git_capture(&root_path, &["branch", "--show-current"]).unwrap_or_default();
    let mut pushed = false;
    if git_ok(&root_path, &["rev-parse", "--verify", "HEAD"]) && !branch.is_empty() {
        if let Err(e) = push_with_token(&root_path, &token, &branch) {
            // The repo was created and origin wired up; report the push problem
            // without losing that context so the user can retry the push.
            return Err(format!(
                "Repository '{full_name}' was created, but the initial push failed: {e}"
            ));
        }
        pushed = true;
    }

    Ok(CreateRepoResult {
        html_url,
        full_name,
        pushed,
    })
}

/// A GitHub repository reference parsed out of whatever the user pasted.
struct RepoRef {
    /// The URL handed to `git clone` — always normalized to HTTPS so the token
    /// header below is the only credential path and we never touch SSH keys.
    url: String,
    /// Repository name, used as the folder name for the clone.
    name: String,
}

/// Accept the forms people actually paste — the browser URL, the "clone with
/// HTTPS" string, an SSH remote, or bare `owner/repo` — and normalize them all
/// to an HTTPS github.com URL.
///
/// Deliberately strict: the host must be github.com and owner/repo must look
/// like real GitHub identifiers. That keeps this from becoming a "clone any URL"
/// primitive, which would let a pasted string reach an arbitrary host (or, via a
/// leading dash, be read by git as an option rather than a URL).
fn parse_repo_ref(input: &str) -> Result<RepoRef, String> {
    let raw = input.trim();
    if raw.is_empty() {
        return Err("Enter a GitHub repository URL.".to_string());
    }
    if raw.len() > 300 {
        return Err("That URL is too long.".to_string());
    }
    if raw.starts_with('-') {
        return Err("That doesn't look like a GitHub repository URL.".to_string());
    }

    // Strip the transport prefix, leaving `owner/repo` in every accepted form.
    let rest = if let Some(r) = raw.strip_prefix("git@github.com:") {
        r
    } else if let Some(r) = raw.strip_prefix("ssh://git@github.com/") {
        r
    } else if let Some(r) = raw.strip_prefix("https://github.com/") {
        r
    } else if let Some(r) = raw.strip_prefix("http://github.com/") {
        r
    } else if let Some(r) = raw.strip_prefix("github.com/") {
        r
    } else if raw.contains("://") || raw.contains('@') {
        // Some other host, or a userinfo@host form pointing off github.com.
        return Err("Only github.com repositories can be cloned here.".to_string());
    } else {
        raw
    };

    // Drop a trailing `.git`, any fragment/query, and trailing slashes.
    let rest = rest
        .split(['?', '#'])
        .next()
        .unwrap_or("")
        .trim_end_matches('/');
    let rest = rest.strip_suffix(".git").unwrap_or(rest);

    let mut parts = rest.split('/');
    let owner = parts.next().unwrap_or("").trim();
    let name = parts.next().unwrap_or("").trim();
    if parts.next().is_some() {
        // A deep link like /owner/repo/tree/main — the repo is still the first
        // two segments, but refuse rather than guess at what the user meant.
        return Err(
            "Use the repository's main URL, not a link to a file or branch inside it.".to_string(),
        );
    }
    if owner.is_empty() || name.is_empty() {
        return Err("That doesn't look like a GitHub repository URL.".to_string());
    }

    // GitHub owners: alphanumeric and single hyphens. Repos additionally allow
    // '_' and '.'. `validate_repo_name` already covers the repo half.
    if owner.len() > 39
        || !owner
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err("That doesn't look like a GitHub repository URL.".to_string());
    }
    validate_repo_name(name)?;

    Ok(RepoRef {
        url: format!("https://github.com/{owner}/{name}.git"),
        name: name.to_string(),
    })
}

/// Clone a GitHub repository into `parent` and open it as a project.
///
/// Auth mirrors `push_with_token`: when a token is saved we inject it as a
/// per-invocation HTTP header via `GIT_CONFIG_*`, so private repos work without
/// the credential ever reaching `.git/config`, the command line, or a process
/// listing. Without a token this still clones public repos.
#[tauri::command(async)]
pub fn workspace_clone_repo(
    url: String,
    parent: String,
    state: State<AppState>,
) -> Result<Project, String> {
    let repo = parse_repo_ref(&url)?;

    let parent_path = std::fs::canonicalize(PathBuf::from(&parent))
        .map(crate::commands::clean_path_buf)
        .map_err(|_| "The selected location does not exist.".to_string())?;
    if !parent_path.is_dir() {
        return Err("The selected location is not a folder.".to_string());
    }

    let target = crate::commands::clean_path_buf(parent_path.join(&repo.name));
    if target.exists() {
        return Err(format!(
            "A folder named \"{}\" already exists here.",
            repo.name
        ));
    }

    // A saved token is a convenience, not a requirement — public clones work
    // without one, so a missing token must not fail the whole operation.
    let token = read_token().ok();

    let mut cmd = git_base();
    cmd.args(["clone", "--progress", "--", &repo.url])
        .arg(&repo.name)
        .current_dir(&parent_path)
        // Fail fast instead of blocking forever on a credential prompt for a
        // private repo we have no token for.
        .env("GIT_TERMINAL_PROMPT", "0");
    if let Some(token) = &token {
        let cred =
            base64::engine::general_purpose::STANDARD.encode(format!("x-access-token:{token}"));
        cmd.env("GIT_CONFIG_COUNT", "1")
            .env("GIT_CONFIG_KEY_0", "http.https://github.com/.extraheader")
            .env("GIT_CONFIG_VALUE_0", format!("AUTHORIZATION: basic {cred}"));
    }

    let out = cmd
        .output()
        .map_err(|e| format!("Failed to run git: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        // git leaves a partial directory behind when a clone dies midway; clear
        // it so a retry doesn't trip the "already exists" check above.
        let _ = std::fs::remove_dir_all(&target);
        return Err(classify_clone_error(&stderr, token.is_some()));
    }

    let root_path = std::fs::canonicalize(&target)
        .map(crate::commands::clean_path_buf)
        .unwrap_or(target);

    state
        .workspace_manager
        .open_project(root_path)
        .map_err(|e| e.to_string())
}

/// Turn git's clone failure into something actionable. The "not found" case is
/// the one worth special-casing: GitHub returns 404 for a private repo you can't
/// see, so the real cause is usually a missing or under-scoped token rather than
/// a typo.
fn classify_clone_error(stderr: &str, had_token: bool) -> String {
    let s = stderr.to_lowercase();
    if s.contains("repository not found") || s.contains("could not read from remote repository") {
        return if had_token {
            "Repository not found. Check the URL, and make sure your GitHub token has access to it (private repos need the 'repo' scope).".to_string()
        } else {
            "Repository not found. If it's private, add a GitHub token in Settings first.".to_string()
        };
    }
    if s.contains("authentication failed") || s.contains("invalid username or password") {
        return "GitHub rejected the saved token. Update it in Settings.".to_string();
    }
    if s.contains("could not resolve host") || s.contains("failed to connect") {
        return "Couldn't reach github.com. Check your internet connection.".to_string();
    }
    sanitize_git_error(stderr)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parsed(input: &str) -> RepoRef {
        parse_repo_ref(input).unwrap_or_else(|e| panic!("expected {input:?} to parse, got: {e}"))
    }

    #[test]
    fn accepts_the_forms_people_paste() {
        for input in [
            "https://github.com/anthropics/claude-code",
            "https://github.com/anthropics/claude-code.git",
            "https://github.com/anthropics/claude-code/",
            "http://github.com/anthropics/claude-code",
            "github.com/anthropics/claude-code",
            "git@github.com:anthropics/claude-code.git",
            "ssh://git@github.com/anthropics/claude-code.git",
            "anthropics/claude-code",
            "  https://github.com/anthropics/claude-code  ",
        ] {
            let r = parsed(input);
            assert_eq!(r.url, "https://github.com/anthropics/claude-code.git", "{input}");
            assert_eq!(r.name, "claude-code", "{input}");
        }
    }

    #[test]
    fn strips_query_and_fragment() {
        let r = parsed("https://github.com/owner/repo?tab=readme#install");
        assert_eq!(r.url, "https://github.com/owner/repo.git");
    }

    #[test]
    fn rejects_other_hosts() {
        for input in [
            "https://gitlab.com/owner/repo",
            "https://evil.example/owner/repo",
            "https://github.com.evil.example/owner/repo",
            "git@gitlab.com:owner/repo.git",
            "file:///etc/passwd",
        ] {
            assert!(parse_repo_ref(input).is_err(), "should reject {input}");
        }
    }

    #[test]
    fn rejects_option_lookalikes() {
        // A leading dash would be read by git as a flag rather than a URL.
        for input in ["--upload-pack=touch /tmp/pwned", "-u", "--config=x"] {
            assert!(parse_repo_ref(input).is_err(), "should reject {input}");
        }
    }

    #[test]
    fn rejects_traversal_in_the_repo_name() {
        // The repo name becomes the clone directory, so it must never escape.
        for input in ["owner/..", "owner/.", "../../etc", "owner/sub/dir"] {
            assert!(parse_repo_ref(input).is_err(), "should reject {input}");
        }
    }

    #[test]
    fn rejects_deep_links_rather_than_guessing() {
        assert!(parse_repo_ref("https://github.com/owner/repo/tree/main/src").is_err());
    }

    #[test]
    fn rejects_incomplete_references() {
        for input in ["", "   ", "owner", "https://github.com/", "https://github.com/owner"] {
            assert!(parse_repo_ref(input).is_err(), "should reject {input:?}");
        }
    }

    #[test]
    fn clone_error_points_at_the_token_when_one_is_saved() {
        let with = classify_clone_error("ERROR: Repository not found.", true);
        assert!(with.contains("token has access"), "{with}");
        let without = classify_clone_error("ERROR: Repository not found.", false);
        assert!(without.contains("add a GitHub token"), "{without}");
    }
}
