//! Ship a chat thread's work in one action: commit everything in its worktree,
//! push the branch, and open a pull request.
//!
//! The work itself already exists by the time this runs — the agent wrote files
//! into an isolated checkout. What this adds is the "I'm done, ship it" step that
//! otherwise means three shell commands and a browser tab.
//!
//! Two deliberate choices:
//!
//! * The PR is created through the GitHub REST API with the token the rest of
//!   this app already stores, not by shelling out to `gh`. Most people do not
//!   have the GitHub CLI installed, and requiring it would make this button
//!   fail for exactly the users who never touched a terminal.
//! * Pushing and opening the PR are separate outcomes. If the push works but
//!   GitHub is not signed in, the command still succeeds and returns a compare
//!   URL instead of throwing away a successful push behind an error.

use std::path::Path;
use std::time::Duration;

use tauri::State;

use crate::commands::github::{push_with_token, read_token, SIGN_IN_EXPIRED};
use crate::commands::workspace::{
    check_git_available, classify_push_error, git_base, resolve_repo, sanitize_git_error,
};
use crate::state::AppState;

const GITHUB_API: &str = "https://api.github.com";
const MAX_TITLE: usize = 256;
const MAX_BODY: usize = 60_000;

/// What the thread row needs to render after the action, whichever parts worked.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadPullRequest {
    pub branch: String,
    /// Branch the PR targets (the repository's default branch when not given).
    pub base: String,
    /// Whether this run created a commit (false when the tree was already clean).
    pub committed: bool,
    /// Subject of the commit created by this run, if any.
    pub commit_subject: Option<String>,
    /// Full SHA of the branch tip after committing.
    pub head_sha: String,
    pub pushed: bool,
    pub pr_url: Option<String>,
    pub pr_number: Option<u64>,
    /// False when a PR for this branch was already open and got reused.
    pub pr_created: bool,
    /// Why no PR was opened, when the push still succeeded.
    pub pr_error: Option<String>,
    /// GitHub's "open a pull request" page — the manual fallback.
    pub compare_url: String,
}

/// Pull `owner` and `repo` out of a GitHub remote URL.
///
/// Remotes come in four shapes and users paste all of them; anything that is not
/// GitHub returns None so the caller can explain that instead of failing weirdly
/// halfway through a push.
fn github_owner_repo(url: &str) -> Option<(String, String)> {
    let raw = url.trim();
    let rest = if let Some(rest) = raw.strip_prefix("https://github.com/") {
        rest
    } else if let Some(rest) = raw.strip_prefix("http://github.com/") {
        rest
    } else if let Some(rest) = raw.strip_prefix("ssh://git@github.com/") {
        rest
    } else if let Some(rest) = raw.strip_prefix("git@github.com:") {
        rest
    } else if let Some(rest) = raw.strip_prefix("github.com/") {
        rest
    } else {
        return None;
    };
    let rest = rest.trim_end_matches('/');
    let rest = rest.strip_suffix(".git").unwrap_or(rest);
    let mut parts = rest.split('/');
    let owner = parts.next()?.trim();
    let repo = parts.next()?.trim();
    if owner.is_empty() || repo.is_empty() || parts.next().is_some() {
        return None;
    }
    // A remote with spaces or shell metacharacters is not a GitHub path; refuse
    // it rather than interpolating it into an API URL.
    let valid = |part: &str| {
        part.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
    };
    if !valid(owner) || !valid(repo) {
        return None;
    }
    Some((owner.to_string(), repo.to_string()))
}

/// The commit subject this action writes: the thread title, on one line.
///
/// Git treats everything after the first line as the message body, so a pasted
/// multi-line title would otherwise become an accidental body. The cap keeps the
/// subject readable in `git log --oneline`.
fn commit_subject(title: &str) -> String {
    let first = title
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("");
    let joined = first.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut subject = joined.chars().take(100).collect::<String>();
    subject = subject.trim_end_matches(|c: char| c.is_whitespace() || c == '.').to_string();
    if subject.is_empty() {
        "Spacron: agent work".to_string()
    } else {
        subject
    }
}

/// Branch name from `git symbolic-ref --short refs/remotes/origin/HEAD`.
///
/// Only the `origin/` prefix is stripped: a branch literally named `HEAD` means
/// the ref is dangling, and using it as a PR base would be nonsense.
fn base_from_symbolic_ref(stdout: &str) -> Option<String> {
    let line = stdout.lines().next()?.trim();
    let branch = line
        .strip_prefix("refs/remotes/origin/")
        .or_else(|| line.strip_prefix("origin/"))?;
    if branch.is_empty() || branch == "HEAD" {
        return None;
    }
    Some(branch.to_string())
}

fn compare_url(owner: &str, repo: &str, base: &str, branch: &str) -> String {
    format!("https://github.com/{owner}/{repo}/compare/{base}...{branch}?expand=1")
}

fn run_git(repo: &Path, args: &[&str]) -> Result<String, String> {
    let output = git_base()
        .args(args)
        .current_dir(repo)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|error| format!("Could not run git: {error}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(sanitize_git_error(&String::from_utf8_lossy(&output.stderr)))
    }
}

/// Exit status without treating a non-zero exit as an error — `git diff --quiet`
/// uses the status itself as the answer.
fn git_exit_ok(repo: &Path, args: &[&str]) -> Result<bool, String> {
    let output = git_base()
        .args(args)
        .current_dir(repo)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|error| format!("Could not run git: {error}"))?;
    match output.status.code() {
        Some(0) => Ok(true),
        Some(_) => Ok(false),
        None => Err(format!("git {} did not finish", args.first().copied().unwrap_or(""))),
    }
}

/// Commit everything in the worktree. Returns the subject when a commit was
/// actually created — a clean tree is a no-op, not an error.
///
/// Identity falls back to the same values `worktree_snapshot` uses, so a machine
/// with no `user.name` configured still commits instead of failing.
fn commit_everything(repo: &Path, title: &str) -> Result<Option<String>, String> {
    if run_git(repo, &["status", "--porcelain"])?.is_empty() {
        return Ok(None);
    }
    run_git(repo, &["add", "-A"])?;
    // `--quiet` exits 0 when nothing is staged.
    if git_exit_ok(repo, &["diff", "--cached", "--quiet"])? {
        // The tree only had ignored files removed or submodule pointers moved:
        // nothing git will commit.
        return Ok(None);
    }
    let configured = |key: &str| {
        run_git(repo, &["config", "--get", key])
            .map(|value| !value.is_empty())
            .unwrap_or(false)
    };
    let mut owned: Vec<String> = Vec::new();
    if !configured("user.name") {
        owned.extend(["-c".to_string(), "user.name=Spacron".to_string()]);
    }
    if !configured("user.email") {
        owned.extend(["-c".to_string(), "user.email=agent@spacron.local".to_string()]);
    }
    let subject = commit_subject(title);
    owned.extend(["commit".to_string(), "-m".to_string(), subject.clone()]);
    let args: Vec<&str> = owned.iter().map(String::as_str).collect();
    run_git(repo, &args)?;
    Ok(Some(subject))
}

/// Resolve the base branch: an explicit request wins, then the remote's HEAD,
/// then GitHub's own `default_branch` (an empty clone often has no remote HEAD).
async fn resolve_base(
    repo: &Path,
    requested: Option<&str>,
    client: Option<(&reqwest::Client, &str, &str, &str)>,
) -> String {
    if let Some(base) = requested.map(str::trim).filter(|base| !base.is_empty()) {
        return base.to_string();
    }
    if let Ok(stdout) = run_git(repo, &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]) {
        if let Some(base) = base_from_symbolic_ref(&stdout) {
            return base;
        }
    }
    if let Some((client, token, owner, name)) = client {
        let url = format!("{GITHUB_API}/repos/{owner}/{name}");
        if let Ok(response) = client.get(&url).bearer_auth(token).send().await {
            if response.status().is_success() {
                if let Ok(body) = response.json::<serde_json::Value>().await {
                    if let Some(base) = body.get("default_branch").and_then(|v| v.as_str()) {
                        if !base.trim().is_empty() {
                            return base.trim().to_string();
                        }
                    }
                }
            }
        }
    }
    "main".to_string()
}

fn pr_api_error(status: reqwest::StatusCode, body: &serde_json::Value) -> String {
    let message = body.get("message").and_then(|v| v.as_str()).unwrap_or("");
    match status.as_u16() {
        401 => SIGN_IN_EXPIRED.to_string(),
        403 => "GitHub refused the pull request (403). Your token may lack the 'repo' scope.".to_string(),
        404 => "GitHub could not find the repository, or the token cannot see it.".to_string(),
        422 => {
            if body.to_string().to_lowercase().contains("already exists") {
                "A pull request for this branch already exists.".to_string()
            } else if message.is_empty() {
                "GitHub rejected the pull request (422).".to_string()
            } else {
                format!("GitHub rejected the pull request: {message}")
            }
        }
        _ => format!(
            "GitHub returned an error ({status}): {}",
            if message.is_empty() { "unknown error" } else { message }
        ),
    }
}

/// Open a PR, or reuse the one already open for this branch. `created` is false
/// on the reuse path, which is how the UI avoids saying "opened" twice.
async fn open_or_reuse_pull_request(
    client: &reqwest::Client,
    token: &str,
    owner: &str,
    name: &str,
    branch: &str,
    base: &str,
    title: &str,
    body: &str,
) -> Result<(String, u64, bool), String> {
    let url = format!("{GITHUB_API}/repos/{owner}/{name}/pulls");
    let head = format!("{owner}:{branch}");
    let existing = client
        .get(&url)
        .query(&[("state", "open"), ("head", head.as_str())])
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .bearer_auth(token)
        .send()
        .await
        .map_err(|error| format!("Failed to contact GitHub: {}", error.without_url()))?;
    if existing.status().is_success() {
        if let Ok(serde_json::Value::Array(items)) = existing.json::<serde_json::Value>().await {
            if let Some((pr_url, number)) = items.iter().find_map(|item| {
                let pr_url = item.get("html_url").and_then(|v| v.as_str())?.to_string();
                let number = item.get("number").and_then(|v| v.as_u64())?;
                Some((pr_url, number))
            }) {
                return Ok((pr_url, number, false));
            }
        }
    }

    let response = client
        .post(&url)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .bearer_auth(token)
        .json(&serde_json::json!({
            "title": title,
            "head": branch,
            "base": base,
            "body": body,
        }))
        .send()
        .await
        .map_err(|error| format!("Failed to contact GitHub: {}", error.without_url()))?;
    let status = response.status();
    let payload: serde_json::Value = response.json().await.unwrap_or(serde_json::Value::Null);
    if !status.is_success() {
        return Err(pr_api_error(status, &payload));
    }
    let pr_url = payload
        .get("html_url")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let number = payload.get("number").and_then(|v| v.as_u64()).unwrap_or(0);
    if pr_url.is_empty() || number == 0 {
        return Err("GitHub created the pull request but returned no link.".to_string());
    }
    Ok((pr_url, number, true))
}

/// Commit the thread's checkout, push its branch, and open a pull request.
#[tauri::command]
pub async fn workspace_git_commit_and_open_pr(
    project_id: String,
    repo_path: Option<String>,
    title: String,
    body: Option<String>,
    base: Option<String>,
    state: State<'_, AppState>,
) -> Result<ThreadPullRequest, String> {
    check_git_available()?;
    let repo = resolve_repo(&project_id, repo_path.as_deref(), &state)?;

    if run_git(&repo, &["rev-parse", "--verify", "HEAD"]).is_err() {
        return Err("This branch has no commits yet, so there is nothing to open a pull request for.".to_string());
    }

    let branch = run_git(&repo, &["branch", "--show-current"])?;
    if branch.is_empty() {
        return Err("The checkout is on a detached HEAD. Switch to a branch before opening a pull request.".to_string());
    }

    let remote = run_git(&repo, &["remote", "get-url", "origin"])
        .map_err(|_| "This project has no 'origin' remote, so there is nowhere to push.".to_string())?;
    let (owner, name) = github_owner_repo(&remote).ok_or_else(|| {
        "Pull requests are only created for github.com remotes. Push this branch yourself, then open one on your host.".to_string()
    })?;

    let subject = commit_subject(&title);
    let committed_subject = commit_everything(&repo, &title)?;
    let committed = committed_subject.is_some();
    let head_sha = run_git(&repo, &["rev-parse", "HEAD"])?;

    let token = read_token().ok();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent("Spacron")
        .build()
        .map_err(|error| format!("Failed to prepare the request: {error}"))?;

    // Push first: a PR cannot exist for a branch GitHub has never seen.
    let pushed = match token.as_deref() {
        Some(token) => push_with_token(&repo, token, &branch)
            .map(|()| true)
            .map_err(|error| format!("The commit is saved locally, but the push failed: {error}"))?,
        None => {
            let output = git_base()
                .args(["push", "-u", "origin", "--", &branch])
                .current_dir(&repo)
                .env("GIT_TERMINAL_PROMPT", "0")
                .output()
                .map_err(|error| format!("Could not run git push: {error}"))?;
            if !output.status.success() {
                return Err(format!(
                    "The commit is saved locally, but the push failed: {}",
                    classify_push_error(&String::from_utf8_lossy(&output.stderr))
                ));
            }
            true
        }
    };

    let base_branch = resolve_base(
        &repo,
        base.as_deref(),
        token.as_deref().map(|token| (&client, token, owner.as_str(), name.as_str())),
    )
    .await;
    if base_branch == branch {
        return Err(format!(
            "This branch is '{base_branch}', which is also the pull request base. Switch the thread to its own branch first."
        ));
    }

    let compare = compare_url(&owner, &name, &base_branch, &branch);
    let body_text = body
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .unwrap_or("Created with Spacron.")
        .chars()
        .take(MAX_BODY)
        .collect::<String>();
    let pr_title = subject.chars().take(MAX_TITLE).collect::<String>();

    let (pr_url, pr_number, pr_created, pr_error) = match token.as_deref() {
        None => (
            None,
            None,
            false,
            Some("Sign in to GitHub in Settings to open the pull request from here.".to_string()),
        ),
        Some(token) => match open_or_reuse_pull_request(
            &client,
            token,
            &owner,
            &name,
            &branch,
            &base_branch,
            &pr_title,
            &body_text,
        )
        .await
        {
            Ok((url, number, created)) => (Some(url), Some(number), created, None),
            // The branch is pushed; report the PR problem without hiding that.
            Err(error) => (None, None, false, Some(error)),
        },
    };

    Ok(ThreadPullRequest {
        branch,
        base: base_branch,
        committed,
        commit_subject: committed_subject,
        head_sha,
        pushed,
        pr_url,
        pr_number,
        pr_created,
        pr_error,
        compare_url: compare,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn github_remotes_parse_in_every_shape_users_paste() {
        for url in [
            "https://github.com/Samuel00098/spacron.git",
            "https://github.com/Samuel00098/spacron",
            "git@github.com:Samuel00098/spacron.git",
            "ssh://git@github.com/Samuel00098/spacron.git",
            "github.com/Samuel00098/spacron/",
        ] {
            assert_eq!(
                github_owner_repo(url),
                Some(("Samuel00098".to_string(), "spacron".to_string())),
                "{url} did not parse"
            );
        }
    }

    #[test]
    fn non_github_and_malformed_remotes_are_refused() {
        for url in [
            "https://gitlab.com/o/r.git",
            "https://github.com/onlyowner",
            "https://github.com/o/r/extra",
            "https://github.com/o/r?x=1",
            "git@bitbucket.org:o/r.git",
            "",
        ] {
            assert_eq!(github_owner_repo(url), None, "{url} should not parse");
        }
    }

    #[test]
    fn commit_subject_keeps_one_readable_line() {
        assert_eq!(commit_subject("  Fix login redirect\n\nmore detail"), "Fix login redirect");
        // Tabs and repeated spaces collapse: a subject is a line, not a layout.
        assert_eq!(commit_subject("Add   worktree\tsupport"), "Add worktree support");
        // A trailing period reads like a sentence in `git log --oneline`.
        assert_eq!(commit_subject("Ship it."), "Ship it");
        // Nothing nameable still produces a commit, never an empty message.
        assert_eq!(commit_subject("   \n\t\n"), "Spacron: agent work");
    }

    #[test]
    fn commit_subject_is_capped_but_never_empty() {
        let subject = commit_subject(&"x".repeat(400));
        assert_eq!(subject.chars().count(), 100);
    }

    #[test]
    fn base_branch_comes_from_the_remote_head_ref() {
        assert_eq!(
            base_from_symbolic_ref("refs/remotes/origin/main\n"),
            Some("main".to_string())
        );
        assert_eq!(
            base_from_symbolic_ref("origin/develop\n"),
            Some("develop".to_string())
        );
        // Dangling ref and unrelated refs give no answer at all.
        assert_eq!(base_from_symbolic_ref("refs/remotes/origin/HEAD\n"), None);
        assert_eq!(base_from_symbolic_ref("refs/heads/main\n"), None);
        assert_eq!(base_from_symbolic_ref(""), None);
    }

    #[test]
    fn compare_url_points_at_githubs_pr_form() {
        assert_eq!(
            compare_url("o", "r", "main", "spacron/fix-abc123"),
            "https://github.com/o/r/compare/main...spacron/fix-abc123?expand=1"
        );
    }

    #[test]
    fn pull_request_errors_say_something_actionable() {
        let expired = pr_api_error(
            reqwest::StatusCode::UNAUTHORIZED,
            &serde_json::json!({ "message": "Bad credentials" }),
        );
        assert_eq!(expired, SIGN_IN_EXPIRED);
        let exists = pr_api_error(
            reqwest::StatusCode::UNPROCESSABLE_ENTITY,
            &serde_json::json!({ "message": "A pull request already exists for o:branch." }),
        );
        assert!(exists.contains("already exists"), "{exists}");
        let denied = pr_api_error(reqwest::StatusCode::FORBIDDEN, &serde_json::Value::Null);
        assert!(denied.contains("repo"), "{denied}");
    }
}
