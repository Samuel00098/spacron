//! Source Control & Work Items: Issues, Pull Requests, Reviews, and Merge.
//!
//! Provides unified endpoints for inspecting and mutating issues and pull requests
//! across GitHub (and compatible providers), with full in-app detail views,
//! comment timelines, diffs, CI checks, and one-click merge with head verification.

use std::path::Path;
use std::sync::LazyLock;
use std::time::Duration;
use tauri::State;

use crate::commands::github::{gh_auth_token, read_token};
use crate::commands::workspace::{check_git_available, git_base, resolve_repo, sanitize_git_error};
use crate::state::AppState;

const GITHUB_API: &str = "https://api.github.com";

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteRepoInfo {
    pub provider: String, // "github" | "gitlab" | "bitbucket" | "other"
    pub owner: String,
    pub repo: String,
    pub current_branch: String,
    pub default_branch: String,
    pub remote_url: String,
    pub has_token: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueAuthor {
    pub login: String,
    pub avatar_url: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueLabel {
    pub name: String,
    pub color: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkItemIssue {
    pub id: u64,
    pub number: u64,
    pub title: String,
    pub body: String,
    pub state: String, // "open" | "closed"
    pub author: IssueAuthor,
    pub labels: Vec<IssueLabel>,
    pub assignees: Vec<IssueAuthor>,
    pub comments_count: u64,
    pub created_at: String,
    pub updated_at: String,
    pub closed_at: Option<String>,
    pub html_url: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkItemComment {
    pub id: u64,
    pub author: IssueAuthor,
    pub body: String,
    pub created_at: String,
    pub updated_at: String,
    pub html_url: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkItemPR {
    pub id: u64,
    pub number: u64,
    pub title: String,
    pub body: String,
    pub state: String, // "open" | "closed" | "merged"
    pub draft: bool,
    pub author: IssueAuthor,
    pub head_branch: String,
    pub base_branch: String,
    pub head_sha: String,
    pub mergeable: Option<bool>,
    pub mergeable_state: Option<String>,
    pub comments_count: u64,
    pub created_at: String,
    pub updated_at: String,
    pub closed_at: Option<String>,
    pub merged_at: Option<String>,
    pub html_url: String,
    pub additions: Option<u64>,
    pub deletions: Option<u64>,
    pub changed_files: Option<u64>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkItemFile {
    pub filename: String,
    pub status: String, // "modified" | "added" | "removed" | "renamed"
    pub additions: u64,
    pub deletions: u64,
    pub changes: u64,
    pub patch: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkItemCheck {
    pub id: u64,
    pub name: String,
    pub status: String,     // "queued" | "in_progress" | "completed"
    pub conclusion: Option<String>, // "success" | "failure" | "neutral" | "cancelled" | "timed_out"
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub html_url: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PRChecksSummary {
    pub total: u64,
    pub passed: u64,
    pub failed: u64,
    pub running: u64,
    pub checks: Vec<WorkItemCheck>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergePRResult {
    pub success: bool,
    pub sha: Option<String>,
    pub message: String,
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

/// Parse owner and repo from git remote url.
pub(crate) fn parse_remote_url(url: &str) -> Option<(String, String, String)> {
    let raw = url.trim();
    let (provider, rest) = if let Some(rest) = raw.strip_prefix("https://github.com/") {
        ("github", rest)
    } else if let Some(rest) = raw.strip_prefix("http://github.com/") {
        ("github", rest)
    } else if let Some(rest) = raw.strip_prefix("ssh://git@github.com/") {
        ("github", rest)
    } else if let Some(rest) = raw.strip_prefix("git@github.com:") {
        ("github", rest)
    } else if let Some(rest) = raw.strip_prefix("github.com/") {
        ("github", rest)
    } else if let Some(rest) = raw.strip_prefix("https://gitlab.com/") {
        ("gitlab", rest)
    } else if let Some(rest) = raw.strip_prefix("git@gitlab.com:") {
        ("gitlab", rest)
    } else if let Some(rest) = raw.strip_prefix("https://bitbucket.org/") {
        ("bitbucket", rest)
    } else if let Some(rest) = raw.strip_prefix("git@bitbucket.org:") {
        ("bitbucket", rest)
    } else {
        return None;
    };

    let rest = rest.trim_end_matches('/');
    let rest = rest.strip_suffix(".git").unwrap_or(rest);
    let mut parts = rest.split('/');
    let owner = parts.next()?.trim();
    let repo = parts.next()?.trim();
    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    Some((provider.to_string(), owner.to_string(), repo.to_string()))
}

/// Retrieve authentication token for the given provider.
/// Tries keychain first, then CLI fallback (gh / glab), and env vars.
pub(crate) fn resolve_token(provider: &str) -> Option<String> {
    if provider == "github" {
        if let Ok(token) = read_token() {
            if !token.is_empty() {
                return Some(token);
            }
        }
        if let Ok(Some(token)) = gh_auth_token() {
            if !token.is_empty() {
                return Some(token);
            }
        }
        if let Ok(token) = std::env::var("GITHUB_TOKEN").or_else(|_| std::env::var("GH_TOKEN")) {
            if !token.trim().is_empty() {
                return Some(token.trim().to_string());
            }
        }
    } else if provider == "gitlab" {
        if let Ok(token) = std::env::var("GITLAB_TOKEN").or_else(|_| std::env::var("GL_TOKEN")).or_else(|_| std::env::var("CI_JOB_TOKEN")) {
            if !token.trim().is_empty() {
                return Some(token.trim().to_string());
            }
        }
        if let Ok(output) = std::process::Command::new("glab").args(["auth", "token"]).output() {
            if output.status.success() {
                let token = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !token.is_empty() {
                    return Some(token);
                }
            }
        }
    } else if provider == "bitbucket" {
        if let Ok(token) = std::env::var("BITBUCKET_TOKEN") {
            if !token.trim().is_empty() {
                return Some(token.trim().to_string());
            }
        }
    }
    None
}

fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("Spacron-App")
        .timeout(Duration::from_secs(30))
        .build()
        .unwrap_or_default()
}

/// Get remote repo information and branch context.
#[tauri::command]
pub async fn source_control_repo_info(
    project_id: String,
    repo_path: Option<String>,
    state: State<'_, AppState>,
) -> Result<RemoteRepoInfo, String> {
    check_git_available()?;
    let repo = resolve_repo(&project_id, repo_path.as_deref(), &state)?;

    let mut remote_url = run_git(&repo, &["remote", "get-url", "origin"]).unwrap_or_default();
    if remote_url.trim().is_empty() {
        if let Ok(remotes) = run_git(&repo, &["remote"]) {
            for r in remotes.lines().map(str::trim).filter(|s| !s.is_empty()) {
                if let Ok(url) = run_git(&repo, &["remote", "get-url", r]) {
                    if !url.trim().is_empty() {
                        remote_url = url;
                        break;
                    }
                }
            }
        }
    }
    let current_branch = run_git(&repo, &["branch", "--show-current"]).unwrap_or_else(|_| "HEAD".to_string());

    let (provider, owner, repo_name) = parse_remote_url(&remote_url).ok_or_else(|| {
        "This project's origin remote is not recognized as a supported source control host.".to_string()
    })?;

    let token = resolve_token(&provider);
    let has_token = token.is_some();

    // Try finding default branch from remote HEAD symbolic-ref, or fallback to main
    let default_branch = run_git(&repo, &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
        .ok()
        .and_then(|stdout| {
            let line = stdout.lines().next()?.trim();
            line.strip_prefix("refs/remotes/origin/")
                .or_else(|| line.strip_prefix("origin/"))
                .map(|s| s.to_string())
        })
        .unwrap_or_else(|| "main".to_string());

    Ok(RemoteRepoInfo {
        provider,
        owner,
        repo: repo_name,
        current_branch,
        default_branch,
        remote_url,
        has_token,
    })
}

/// List issues for the repository.
#[tauri::command]
pub async fn source_control_list_issues(
    project_id: String,
    repo_path: Option<String>,
    state_filter: Option<String>,
    page: Option<u32>,
    per_page: Option<u32>,
    state: State<'_, AppState>,
) -> Result<Vec<WorkItemIssue>, String> {
    check_git_available()?;
    let repo = resolve_repo(&project_id, repo_path.as_deref(), &state)?;
    let remote_url = run_git(&repo, &["remote", "get-url", "origin"])
        .map_err(|_| "Project has no origin remote configured.".to_string())?;

    let (provider, owner, repo_name) = parse_remote_url(&remote_url).ok_or_else(|| {
        "Origin remote is not a recognized GitHub or GitLab repository.".to_string()
    })?;

    let token = resolve_token(&provider).ok_or_else(|| {
        "No authentication token found. Sign in via Settings or GitHub CLI (`gh auth login`).".to_string()
    })?;

    let state_val = state_filter.unwrap_or_else(|| "open".to_string());
    let page_val = page.unwrap_or(1);
    let per_page_val = per_page.unwrap_or(30);

    let client = http_client();
    let url = format!("{GITHUB_API}/repos/{owner}/{repo_name}/issues");

    let response = client
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .bearer_auth(&token)
        .query(&[
            ("state", state_val.as_str()),
            ("page", &page_val.to_string()),
            ("per_page", &per_page_val.to_string()),
        ])
        .send()
        .await
        .map_err(|e| format!("Failed to fetch issues: {}", e.without_url()))?;

    if !response.status().is_success() {
        let err_body: serde_json::Value = response.json().await.unwrap_or(serde_json::Value::Null);
        let msg = err_body.get("message").and_then(|v| v.as_str()).unwrap_or("Failed to fetch issues");
        return Err(format!("GitHub API error: {msg}"));
    }

    let items: Vec<serde_json::Value> = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse issues JSON: {e}"))?;

    let mut result = Vec::new();
    for item in items {
        // GitHub's issues endpoint returns both issues and PRs (PRs contain pull_request key)
        if item.get("pull_request").is_some() {
            continue;
        }

        let id = item.get("id").and_then(|v| v.as_u64()).unwrap_or(0);
        let number = item.get("number").and_then(|v| v.as_u64()).unwrap_or(0);
        let title = item.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let body = item.get("body").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let state_str = item.get("state").and_then(|v| v.as_str()).unwrap_or("open").to_string();
        let comments_count = item.get("comments").and_then(|v| v.as_u64()).unwrap_or(0);
        let created_at = item.get("created_at").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let updated_at = item.get("updated_at").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let closed_at = item.get("closed_at").and_then(|v| v.as_str()).map(ToString::to_string);
        let html_url = item.get("html_url").and_then(|v| v.as_str()).unwrap_or("").to_string();

        let user = item.get("user");
        let author = IssueAuthor {
            login: user.and_then(|u| u.get("login")).and_then(|v| v.as_str()).unwrap_or("unknown").to_string(),
            avatar_url: user.and_then(|u| u.get("avatar_url")).and_then(|v| v.as_str()).unwrap_or("").to_string(),
        };

        let mut labels = Vec::new();
        if let Some(lbl_arr) = item.get("labels").and_then(|v| v.as_array()) {
            for lbl in lbl_arr {
                labels.push(IssueLabel {
                    name: lbl.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    color: lbl.get("color").and_then(|v| v.as_str()).unwrap_or("888888").to_string(),
                    description: lbl.get("description").and_then(|v| v.as_str()).map(ToString::to_string),
                });
            }
        }

        let mut assignees = Vec::new();
        if let Some(asg_arr) = item.get("assignees").and_then(|v| v.as_array()) {
            for asg in asg_arr {
                assignees.push(IssueAuthor {
                    login: asg.get("login").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    avatar_url: asg.get("avatar_url").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                });
            }
        }

        result.push(WorkItemIssue {
            id,
            number,
            title,
            body,
            state: state_str,
            author,
            labels,
            assignees,
            comments_count,
            created_at,
            updated_at,
            closed_at,
            html_url,
        });
    }

    Ok(result)
}

/// Get detailed issue data including comments timeline.
#[tauri::command]
pub async fn source_control_get_issue_details(
    project_id: String,
    repo_path: Option<String>,
    issue_number: u64,
    state: State<'_, AppState>,
) -> Result<(WorkItemIssue, Vec<WorkItemComment>), String> {
    check_git_available()?;
    let repo = resolve_repo(&project_id, repo_path.as_deref(), &state)?;
    let remote_url = run_git(&repo, &["remote", "get-url", "origin"])
        .map_err(|_| "Project has no origin remote configured.".to_string())?;

    let (provider, owner, repo_name) = parse_remote_url(&remote_url).ok_or_else(|| {
        "Origin remote is not a recognized GitHub or GitLab repository.".to_string()
    })?;

    let token = resolve_token(&provider).ok_or_else(|| {
        "No authentication token found. Sign in via Settings or GitHub CLI.".to_string()
    })?;

    let client = http_client();
    let issue_url = format!("{GITHUB_API}/repos/{owner}/{repo_name}/issues/{issue_number}");
    let comments_url = format!("{GITHUB_API}/repos/{owner}/{repo_name}/issues/{issue_number}/comments");

    let issue_res = client
        .get(&issue_url)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch issue: {}", e.without_url()))?;

    if !issue_res.status().is_success() {
        return Err(format!("Issue #{} not found on {}", issue_number, owner));
    }

    let item: serde_json::Value = issue_res
        .json()
        .await
        .map_err(|e| format!("Failed to parse issue: {e}"))?;

    let id = item.get("id").and_then(|v| v.as_u64()).unwrap_or(0);
    let number = item.get("number").and_then(|v| v.as_u64()).unwrap_or(issue_number);
    let title = item.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let body = item.get("body").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let state_str = item.get("state").and_then(|v| v.as_str()).unwrap_or("open").to_string();
    let comments_count = item.get("comments").and_then(|v| v.as_u64()).unwrap_or(0);
    let created_at = item.get("created_at").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let updated_at = item.get("updated_at").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let closed_at = item.get("closed_at").and_then(|v| v.as_str()).map(ToString::to_string);
    let html_url = item.get("html_url").and_then(|v| v.as_str()).unwrap_or("").to_string();

    let user = item.get("user");
    let author = IssueAuthor {
        login: user.and_then(|u| u.get("login")).and_then(|v| v.as_str()).unwrap_or("unknown").to_string(),
        avatar_url: user.and_then(|u| u.get("avatar_url")).and_then(|v| v.as_str()).unwrap_or("").to_string(),
    };

    let mut labels = Vec::new();
    if let Some(lbl_arr) = item.get("labels").and_then(|v| v.as_array()) {
        for lbl in lbl_arr {
            labels.push(IssueLabel {
                name: lbl.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                color: lbl.get("color").and_then(|v| v.as_str()).unwrap_or("888888").to_string(),
                description: lbl.get("description").and_then(|v| v.as_str()).map(ToString::to_string),
            });
        }
    }

    let mut assignees = Vec::new();
    if let Some(asg_arr) = item.get("assignees").and_then(|v| v.as_array()) {
        for asg in asg_arr {
            assignees.push(IssueAuthor {
                login: asg.get("login").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                avatar_url: asg.get("avatar_url").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            });
        }
    }

    let issue_obj = WorkItemIssue {
        id,
        number,
        title,
        body,
        state: state_str,
        author,
        labels,
        assignees,
        comments_count,
        created_at,
        updated_at,
        closed_at,
        html_url,
    };

    // Fetch comments
    let mut comments = Vec::new();
    if let Ok(comment_res) = client
        .get(&comments_url)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .bearer_auth(&token)
        .send()
        .await
    {
        if comment_res.status().is_success() {
            if let Ok(items) = comment_res.json::<Vec<serde_json::Value>>().await {
                for c in items {
                    let cid = c.get("id").and_then(|v| v.as_u64()).unwrap_or(0);
                    let cbody = c.get("body").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let ccreated = c.get("created_at").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let cupdated = c.get("updated_at").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let curl = c.get("html_url").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let cuser = c.get("user");
                    let cauthor = IssueAuthor {
                        login: cuser.and_then(|u| u.get("login")).and_then(|v| v.as_str()).unwrap_or("unknown").to_string(),
                        avatar_url: cuser.and_then(|u| u.get("avatar_url")).and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    };
                    comments.push(WorkItemComment {
                        id: cid,
                        author: cauthor,
                        body: cbody,
                        created_at: ccreated,
                        updated_at: cupdated,
                        html_url: curl,
                    });
                }
            }
        }
    }

    Ok((issue_obj, comments))
}

/// Create a new issue on GitHub.
#[tauri::command]
pub async fn source_control_create_issue(
    project_id: String,
    repo_path: Option<String>,
    title: String,
    body: String,
    labels: Option<Vec<String>>,
    assignees: Option<Vec<String>>,
    state: State<'_, AppState>,
) -> Result<WorkItemIssue, String> {
    check_git_available()?;
    let repo = resolve_repo(&project_id, repo_path.as_deref(), &state)?;
    let remote_url = run_git(&repo, &["remote", "get-url", "origin"])
        .map_err(|_| "Project has no origin remote configured.".to_string())?;

    let (provider, owner, repo_name) = parse_remote_url(&remote_url).ok_or_else(|| {
        "Origin remote is not a recognized GitHub repository.".to_string()
    })?;

    let token = resolve_token(&provider).ok_or_else(|| {
        "No authentication token found. Sign in via Settings or GitHub CLI.".to_string()
    })?;

    let client = http_client();
    let url = format!("{GITHUB_API}/repos/{owner}/{repo_name}/issues");

    let mut payload = serde_json::json!({
        "title": title.trim(),
        "body": body,
    });
    if let Some(lbls) = labels {
        if !lbls.is_empty() {
            payload["labels"] = serde_json::json!(lbls);
        }
    }
    if let Some(asgs) = assignees {
        if !asgs.is_empty() {
            payload["assignees"] = serde_json::json!(asgs);
        }
    }

    let response = client
        .post(&url)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .bearer_auth(&token)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Failed to create issue: {}", e.without_url()))?;

    if !response.status().is_success() {
        let err: serde_json::Value = response.json().await.unwrap_or(serde_json::Value::Null);
        let msg = err.get("message").and_then(|v| v.as_str()).unwrap_or("Failed to create issue");
        return Err(format!("GitHub API error: {msg}"));
    }

    let item: serde_json::Value = response.json().await.map_err(|e| format!("JSON error: {e}"))?;
    let id = item.get("id").and_then(|v| v.as_u64()).unwrap_or(0);
    let number = item.get("number").and_then(|v| v.as_u64()).unwrap_or(0);
    let html_url = item.get("html_url").and_then(|v| v.as_str()).unwrap_or("").to_string();

    let created_at = item.get("created_at").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let updated_at = item.get("updated_at").and_then(|v| v.as_str()).unwrap_or("").to_string();

    Ok(WorkItemIssue {
        id,
        number,
        title,
        body,
        state: "open".to_string(),
        author: IssueAuthor { login: "you".to_string(), avatar_url: "".to_string() },
        labels: Vec::new(),
        assignees: Vec::new(),
        comments_count: 0,
        created_at,
        updated_at,
        closed_at: None,
        html_url,
    })
}

/// Update an issue's state (close or reopen).
#[tauri::command]
pub async fn source_control_update_issue_state(
    project_id: String,
    repo_path: Option<String>,
    issue_number: u64,
    new_state: String, // "open" | "closed"
    state: State<'_, AppState>,
) -> Result<(), String> {
    check_git_available()?;
    let repo = resolve_repo(&project_id, repo_path.as_deref(), &state)?;
    let remote_url = run_git(&repo, &["remote", "get-url", "origin"])
        .map_err(|_| "Project has no origin remote configured.".to_string())?;

    let (provider, owner, repo_name) = parse_remote_url(&remote_url).ok_or_else(|| {
        "Origin remote is not a recognized GitHub repository.".to_string()
    })?;

    let token = resolve_token(&provider).ok_or_else(|| {
        "No authentication token found.".to_string()
    })?;

    let client = http_client();
    let url = format!("{GITHUB_API}/repos/{owner}/{repo_name}/issues/{issue_number}");

    let response = client
        .patch(&url)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .bearer_auth(&token)
        .json(&serde_json::json!({ "state": new_state }))
        .send()
        .await
        .map_err(|e| format!("Failed to update issue: {}", e.without_url()))?;

    if !response.status().is_success() {
        return Err(format!("Failed to update issue state to {new_state}"));
    }
    Ok(())
}

/// Add comment to an issue.
#[tauri::command]
pub async fn source_control_add_issue_comment(
    project_id: String,
    repo_path: Option<String>,
    issue_number: u64,
    body: String,
    state: State<'_, AppState>,
) -> Result<WorkItemComment, String> {
    check_git_available()?;
    let repo = resolve_repo(&project_id, repo_path.as_deref(), &state)?;
    let remote_url = run_git(&repo, &["remote", "get-url", "origin"])
        .map_err(|_| "Project has no origin remote configured.".to_string())?;

    let (provider, owner, repo_name) = parse_remote_url(&remote_url).ok_or_else(|| {
        "Origin remote is not a recognized GitHub repository.".to_string()
    })?;

    let token = resolve_token(&provider).ok_or_else(|| {
        "No authentication token found.".to_string()
    })?;

    let client = http_client();
    let url = format!("{GITHUB_API}/repos/{owner}/{repo_name}/issues/{issue_number}/comments");

    let response = client
        .post(&url)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .bearer_auth(&token)
        .json(&serde_json::json!({ "body": body }))
        .send()
        .await
        .map_err(|e| format!("Failed to post comment: {}", e.without_url()))?;

    if !response.status().is_success() {
        return Err("Failed to post comment to GitHub.".to_string());
    }

    let c: serde_json::Value = response.json().await.map_err(|e| format!("JSON error: {e}"))?;
    let cid = c.get("id").and_then(|v| v.as_u64()).unwrap_or(0);
    let curl = c.get("html_url").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let cuser = c.get("user");
    let cauthor = IssueAuthor {
        login: cuser.and_then(|u| u.get("login")).and_then(|v| v.as_str()).unwrap_or("you").to_string(),
        avatar_url: cuser.and_then(|u| u.get("avatar_url")).and_then(|v| v.as_str()).unwrap_or("").to_string(),
    };

    let created_at = c.get("created_at").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let updated_at = c.get("updated_at").and_then(|v| v.as_str()).unwrap_or("").to_string();

    Ok(WorkItemComment {
        id: cid,
        author: cauthor,
        body,
        created_at,
        updated_at,
        html_url: curl,
    })
}

fn parse_pr_json(item: &serde_json::Value) -> WorkItemPR {
    let id = item.get("id").and_then(|v| v.as_u64()).unwrap_or(0);
    let number = item.get("number").and_then(|v| v.as_u64()).unwrap_or(0);
    let title = item.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let body = item.get("body").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let state_str = item.get("state").and_then(|v| v.as_str()).unwrap_or("open").to_string();
    let draft = item.get("draft").and_then(|v| v.as_bool()).unwrap_or(false);
    let created_at = item.get("created_at").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let updated_at = item.get("updated_at").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let closed_at = item.get("closed_at").and_then(|v| v.as_str()).map(ToString::to_string);
    let merged_at = item.get("merged_at").and_then(|v| v.as_str()).map(ToString::to_string);
    let html_url = item.get("html_url").and_then(|v| v.as_str()).unwrap_or("").to_string();

    let head = item.get("head");
    let head_branch = head.and_then(|h| h.get("ref")).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let head_sha = head.and_then(|h| h.get("sha")).and_then(|v| v.as_str()).unwrap_or("").to_string();

    let base = item.get("base");
    let base_branch = base.and_then(|b| b.get("ref")).and_then(|v| v.as_str()).unwrap_or("main").to_string();

    let user = item.get("user");
    let author = IssueAuthor {
        login: user.and_then(|u| u.get("login")).and_then(|v| v.as_str()).unwrap_or("unknown").to_string(),
        avatar_url: user.and_then(|u| u.get("avatar_url")).and_then(|v| v.as_str()).unwrap_or("").to_string(),
    };

    let mergeable = item.get("mergeable").and_then(|v| v.as_bool());
    let mergeable_state = item.get("mergeable_state").and_then(|v| v.as_str()).map(ToString::to_string);
    let comments_count = item.get("comments").and_then(|v| v.as_u64()).unwrap_or(0);
    let additions = item.get("additions").and_then(|v| v.as_u64());
    let deletions = item.get("deletions").and_then(|v| v.as_u64());
    let changed_files = item.get("changed_files").and_then(|v| v.as_u64());

    let effective_state = if merged_at.is_some() {
        "merged".to_string()
    } else {
        state_str
    };

    WorkItemPR {
        id,
        number,
        title,
        body,
        state: effective_state,
        draft,
        author,
        head_branch,
        base_branch,
        head_sha,
        mergeable,
        mergeable_state,
        comments_count,
        created_at,
        updated_at,
        closed_at,
        merged_at,
        html_url,
        additions,
        deletions,
        changed_files,
    }
}

/// Create a new Pull Request on GitHub.
#[tauri::command]
pub async fn source_control_create_pull_request(
    project_id: String,
    repo_path: Option<String>,
    title: String,
    body: String,
    head: Option<String>,
    base: String,
    draft: Option<bool>,
    state: State<'_, AppState>,
) -> Result<WorkItemPR, String> {
    check_git_available()?;
    let repo = resolve_repo(&project_id, repo_path.as_deref(), &state)?;
    let remote_url = run_git(&repo, &["remote", "get-url", "origin"])
        .map_err(|_| "Project has no origin remote configured.".to_string())?;

    let (provider, owner, repo_name) = parse_remote_url(&remote_url).ok_or_else(|| {
        "Origin remote is not a recognized GitHub repository.".to_string()
    })?;

    // Determine head branch
    let head_branch = match head {
        Some(h) if !h.trim().is_empty() => h.trim().to_string(),
        _ => run_git(&repo, &["branch", "--show-current"])
            .map_err(|_| "Could not determine current git branch.".to_string())?
            .trim()
            .to_string(),
    };

    if head_branch.is_empty() {
        return Err("Cannot create a pull request with an empty head branch.".to_string());
    }

    // Push head branch to remote so GitHub knows about it
    let _ = run_git(&repo, &["push", "-u", "origin", &head_branch]);

    let token = resolve_token(&provider);

    // Try GitHub REST API if token available
    if let Some(t) = token {
        let client = http_client();
        let url = format!("{GITHUB_API}/repos/{owner}/{repo_name}/pulls");
        let payload = serde_json::json!({
            "title": title.trim(),
            "body": body,
            "head": head_branch,
            "base": base.trim(),
            "draft": draft.unwrap_or(false),
        });

        let response = client
            .post(&url)
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .bearer_auth(&t)
            .json(&payload)
            .send()
            .await;

        if let Ok(res) = response {
            if res.status().is_success() {
                let item: serde_json::Value = res.json().await.map_err(|e| format!("JSON error: {e}"))?;
                return Ok(parse_pr_json(&item));
            } else {
                let err_body: serde_json::Value = res.json().await.unwrap_or(serde_json::Value::Null);
                if let Some(msg) = err_body.get("message").and_then(|v| v.as_str()) {
                    let detail = err_body
                        .get("errors")
                        .and_then(|v| v.as_array())
                        .and_then(|arr| arr.first())
                        .and_then(|e| e.get("message"))
                        .and_then(|v| v.as_str());
                    let full_msg = match detail {
                        Some(d) => format!("{msg}: {d}"),
                        None => msg.to_string(),
                    };
                    return Err(format!("GitHub API error: {full_msg}"));
                }
            }
        }
    }

    // Fallback: try gh CLI
    let mut args = vec![
        "pr", "create",
        "--title", title.trim(),
        "--body", &body,
        "--base", base.trim(),
        "--head", &head_branch,
    ];
    if draft.unwrap_or(false) {
        args.push("--draft");
    }

    let output = std::process::Command::new("gh")
        .args(&args)
        .current_dir(&repo)
        .output();

    match output {
        Ok(out) if out.status.success() => {
            let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
            let pr_number = stdout
                .rsplit('/')
                .next()
                .and_then(|s| s.parse::<u64>().ok())
                .unwrap_or(0);

            Ok(WorkItemPR {
                id: pr_number,
                number: pr_number,
                title: title.trim().to_string(),
                body,
                state: "open".to_string(),
                draft: draft.unwrap_or(false),
                author: IssueAuthor {
                    login: "you".to_string(),
                    avatar_url: String::new(),
                },
                head_branch,
                base_branch: base,
                head_sha: String::new(),
                mergeable: None,
                mergeable_state: None,
                comments_count: 0,
                created_at: String::new(),
                updated_at: String::new(),
                closed_at: None,
                merged_at: None,
                html_url: stdout,
                additions: None,
                deletions: None,
                changed_files: None,
            })
        }
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            Err(if stderr.is_empty() {
                "Failed to create pull request via GitHub CLI".to_string()
            } else {
                stderr
            })
        }
        Err(e) => Err(format!("Could not execute GitHub CLI or REST API: {e}")),
    }
}

/// List Pull Requests for the repository.
#[tauri::command]
pub async fn source_control_list_pull_requests(
    project_id: String,
    repo_path: Option<String>,
    state_filter: Option<String>,
    page: Option<u32>,
    per_page: Option<u32>,
    state: State<'_, AppState>,
) -> Result<Vec<WorkItemPR>, String> {
    check_git_available()?;
    let repo = resolve_repo(&project_id, repo_path.as_deref(), &state)?;
    let remote_url = run_git(&repo, &["remote", "get-url", "origin"])
        .map_err(|_| "Project has no origin remote configured.".to_string())?;

    let (provider, owner, repo_name) = parse_remote_url(&remote_url).ok_or_else(|| {
        "Origin remote is not a recognized GitHub repository.".to_string()
    })?;

    let token = resolve_token(&provider).ok_or_else(|| {
        "No authentication token found. Sign in via Settings or GitHub CLI (`gh auth login`).".to_string()
    })?;

    let state_val = state_filter.unwrap_or_else(|| "open".to_string());
    let page_val = page.unwrap_or(1);
    let per_page_val = per_page.unwrap_or(30);

    let client = http_client();
    let url = format!("{GITHUB_API}/repos/{owner}/{repo_name}/pulls");

    let response = client
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .bearer_auth(&token)
        .query(&[
            ("state", state_val.as_str()),
            ("page", &page_val.to_string()),
            ("per_page", &per_page_val.to_string()),
        ])
        .send()
        .await
        .map_err(|e| format!("Failed to fetch pull requests: {}", e.without_url()))?;

    if !response.status().is_success() {
        let err_body: serde_json::Value = response.json().await.unwrap_or(serde_json::Value::Null);
        let msg = err_body.get("message").and_then(|v| v.as_str()).unwrap_or("Failed to fetch pull requests");
        return Err(format!("GitHub API error: {msg}"));
    }

    let items: Vec<serde_json::Value> = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse pull requests JSON: {e}"))?;

    let result = items.iter().map(parse_pr_json).collect();
    Ok(result)
}

/// Get detailed Pull Request data including conversation comments.
#[tauri::command]
pub async fn source_control_get_pr_details(
    project_id: String,
    repo_path: Option<String>,
    pr_number: u64,
    state: State<'_, AppState>,
) -> Result<(WorkItemPR, Vec<WorkItemComment>), String> {
    check_git_available()?;
    let repo = resolve_repo(&project_id, repo_path.as_deref(), &state)?;
    let remote_url = run_git(&repo, &["remote", "get-url", "origin"])
        .map_err(|_| "Project has no origin remote configured.".to_string())?;

    let (provider, owner, repo_name) = parse_remote_url(&remote_url).ok_or_else(|| {
        "Origin remote is not a recognized GitHub repository.".to_string()
    })?;

    let token = resolve_token(&provider).ok_or_else(|| {
        "No authentication token found. Sign in via Settings or GitHub CLI.".to_string()
    })?;

    let client = http_client();
    let pr_url = format!("{GITHUB_API}/repos/{owner}/{repo_name}/pulls/{pr_number}");
    let comments_url = format!("{GITHUB_API}/repos/{owner}/{repo_name}/issues/{pr_number}/comments");

    let pr_res = client
        .get(&pr_url)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch PR: {}", e.without_url()))?;

    if !pr_res.status().is_success() {
        return Err(format!("Pull Request #{pr_number} not found"));
    }

    let item: serde_json::Value = pr_res.json().await.map_err(|e| format!("JSON error: {e}"))?;

    let id = item.get("id").and_then(|v| v.as_u64()).unwrap_or(0);
    let number = item.get("number").and_then(|v| v.as_u64()).unwrap_or(pr_number);
    let title = item.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let body = item.get("body").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let state_str = item.get("state").and_then(|v| v.as_str()).unwrap_or("open").to_string();
    let draft = item.get("draft").and_then(|v| v.as_bool()).unwrap_or(false);
    let created_at = item.get("created_at").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let updated_at = item.get("updated_at").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let closed_at = item.get("closed_at").and_then(|v| v.as_str()).map(ToString::to_string);
    let merged_at = item.get("merged_at").and_then(|v| v.as_str()).map(ToString::to_string);
    let html_url = item.get("html_url").and_then(|v| v.as_str()).unwrap_or("").to_string();

    let head = item.get("head");
    let head_branch = head.and_then(|h| h.get("ref")).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let head_sha = head.and_then(|h| h.get("sha")).and_then(|v| v.as_str()).unwrap_or("").to_string();

    let base = item.get("base");
    let base_branch = base.and_then(|b| b.get("ref")).and_then(|v| v.as_str()).unwrap_or("main").to_string();

    let mergeable = item.get("mergeable").and_then(|v| v.as_bool());
    let mergeable_state = item.get("mergeable_state").and_then(|v| v.as_str()).map(ToString::to_string);
    let comments_count = item.get("comments").and_then(|v| v.as_u64()).unwrap_or(0);

    let additions = item.get("additions").and_then(|v| v.as_u64());
    let deletions = item.get("deletions").and_then(|v| v.as_u64());
    let changed_files = item.get("changed_files").and_then(|v| v.as_u64());

    let user = item.get("user");
    let author = IssueAuthor {
        login: user.and_then(|u| u.get("login")).and_then(|v| v.as_str()).unwrap_or("unknown").to_string(),
        avatar_url: user.and_then(|u| u.get("avatar_url")).and_then(|v| v.as_str()).unwrap_or("").to_string(),
    };

    let effective_state = if merged_at.is_some() {
        "merged".to_string()
    } else {
        state_str
    };

    let pr_obj = WorkItemPR {
        id,
        number,
        title,
        body,
        state: effective_state,
        draft,
        author,
        head_branch,
        base_branch,
        head_sha,
        mergeable,
        mergeable_state,
        comments_count,
        created_at,
        updated_at,
        closed_at,
        merged_at,
        html_url,
        additions,
        deletions,
        changed_files,
    };

    let mut comments = Vec::new();
    if let Ok(comment_res) = client
        .get(&comments_url)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .bearer_auth(&token)
        .send()
        .await
    {
        if comment_res.status().is_success() {
            if let Ok(items) = comment_res.json::<Vec<serde_json::Value>>().await {
                for c in items {
                    let cid = c.get("id").and_then(|v| v.as_u64()).unwrap_or(0);
                    let cbody = c.get("body").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let ccreated = c.get("created_at").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let cupdated = c.get("updated_at").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let curl = c.get("html_url").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let cuser = c.get("user");
                    let cauthor = IssueAuthor {
                        login: cuser.and_then(|u| u.get("login")).and_then(|v| v.as_str()).unwrap_or("unknown").to_string(),
                        avatar_url: cuser.and_then(|u| u.get("avatar_url")).and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    };
                    comments.push(WorkItemComment {
                        id: cid,
                        author: cauthor,
                        body: cbody,
                        created_at: ccreated,
                        updated_at: cupdated,
                        html_url: curl,
                    });
                }
            }
        }
    }

    Ok((pr_obj, comments))
}

/// Fetch changed files and diff patches for a pull request.
#[tauri::command]
pub async fn source_control_get_pr_files(
    project_id: String,
    repo_path: Option<String>,
    pr_number: u64,
    state: State<'_, AppState>,
) -> Result<Vec<WorkItemFile>, String> {
    check_git_available()?;
    let repo = resolve_repo(&project_id, repo_path.as_deref(), &state)?;
    let remote_url = run_git(&repo, &["remote", "get-url", "origin"])
        .map_err(|_| "Project has no origin remote configured.".to_string())?;

    let (provider, owner, repo_name) = parse_remote_url(&remote_url).ok_or_else(|| {
        "Origin remote is not a recognized GitHub repository.".to_string()
    })?;

    let token = resolve_token(&provider).ok_or_else(|| {
        "No authentication token found.".to_string()
    })?;

    let client = http_client();
    let url = format!("{GITHUB_API}/repos/{owner}/{repo_name}/pulls/{pr_number}/files?per_page=100");

    let response = client
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch PR files: {}", e.without_url()))?;

    if !response.status().is_success() {
        return Err("GitHub returned an error while fetching PR files.".to_string());
    }

    let items: Vec<serde_json::Value> = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse files: {e}"))?;

    let mut result = Vec::new();
    for f in items {
        let filename = f.get("filename").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let status = f.get("status").and_then(|v| v.as_str()).unwrap_or("modified").to_string();
        let additions = f.get("additions").and_then(|v| v.as_u64()).unwrap_or(0);
        let deletions = f.get("deletions").and_then(|v| v.as_u64()).unwrap_or(0);
        let changes = f.get("changes").and_then(|v| v.as_u64()).unwrap_or(0);
        let patch = f.get("patch").and_then(|v| v.as_str()).map(ToString::to_string);

        result.push(WorkItemFile {
            filename,
            status,
            additions,
            deletions,
            changes,
            patch,
        });
    }

    Ok(result)
}

/// Fetch CI status / check runs for a pull request's head SHA.
#[tauri::command]
pub async fn source_control_get_pr_checks(
    project_id: String,
    repo_path: Option<String>,
    head_sha: String,
    state: State<'_, AppState>,
) -> Result<PRChecksSummary, String> {
    check_git_available()?;
    let repo = resolve_repo(&project_id, repo_path.as_deref(), &state)?;
    let remote_url = run_git(&repo, &["remote", "get-url", "origin"])
        .map_err(|_| "Project has no origin remote configured.".to_string())?;

    let (provider, owner, repo_name) = parse_remote_url(&remote_url).ok_or_else(|| {
        "Origin remote is not a recognized GitHub repository.".to_string()
    })?;

    let token = resolve_token(&provider).ok_or_else(|| {
        "No authentication token found.".to_string()
    })?;

    let client = http_client();
    let url = format!("{GITHUB_API}/repos/{owner}/{repo_name}/commits/{head_sha}/check-runs");

    let response = client
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch CI checks: {}", e.without_url()))?;

    if !response.status().is_success() {
        return Ok(PRChecksSummary {
            total: 0,
            passed: 0,
            failed: 0,
            running: 0,
            checks: Vec::new(),
        });
    }

    let payload: serde_json::Value = response.json().await.unwrap_or(serde_json::Value::Null);
    let check_runs = payload.get("check_runs").and_then(|v| v.as_array());

    let mut checks = Vec::new();
    let mut passed = 0;
    let mut failed = 0;
    let mut running = 0;

    if let Some(runs) = check_runs {
        for r in runs {
            let id = r.get("id").and_then(|v| v.as_u64()).unwrap_or(0);
            let name = r.get("name").and_then(|v| v.as_str()).unwrap_or("check").to_string();
            let status = r.get("status").and_then(|v| v.as_str()).unwrap_or("queued").to_string();
            let conclusion = r.get("conclusion").and_then(|v| v.as_str()).map(ToString::to_string);
            let started_at = r.get("started_at").and_then(|v| v.as_str()).map(ToString::to_string);
            let completed_at = r.get("completed_at").and_then(|v| v.as_str()).map(ToString::to_string);
            let html_url = r.get("html_url").and_then(|v| v.as_str()).map(ToString::to_string);

            match conclusion.as_deref() {
                Some("success") => passed += 1,
                Some("failure") | Some("timed_out") | Some("cancelled") => failed += 1,
                _ => running += 1,
            }

            checks.push(WorkItemCheck {
                id,
                name,
                status,
                conclusion,
                started_at,
                completed_at,
                html_url,
            });
        }
    }

    let total = checks.len() as u64;
    Ok(PRChecksSummary {
        total,
        passed,
        failed,
        running,
        checks,
    })
}

/// Merge a Pull Request using squash, rebase, or merge commit.
/// Verifies expected_head_sha to prevent race conditions.
#[tauri::command]
pub async fn source_control_merge_pr(
    project_id: String,
    repo_path: Option<String>,
    pr_number: u64,
    method: Option<String>, // "squash" | "merge" | "rebase"
    commit_title: Option<String>,
    commit_message: Option<String>,
    expected_head_sha: Option<String>,
    state: State<'_, AppState>,
) -> Result<MergePRResult, String> {
    check_git_available()?;
    let repo = resolve_repo(&project_id, repo_path.as_deref(), &state)?;
    let remote_url = run_git(&repo, &["remote", "get-url", "origin"])
        .map_err(|_| "Project has no origin remote configured.".to_string())?;

    let (provider, owner, repo_name) = parse_remote_url(&remote_url).ok_or_else(|| {
        "Origin remote is not a recognized GitHub repository.".to_string()
    })?;

    let token = resolve_token(&provider).ok_or_else(|| {
        "No authentication token found. Sign in via Settings or GitHub CLI.".to_string()
    })?;

    let merge_method = method.unwrap_or_else(|| "squash".to_string());

    // Fallback: If gh CLI is available and works, we can also use `gh pr merge`
    let client = http_client();
    let url = format!("{GITHUB_API}/repos/{owner}/{repo_name}/pulls/{pr_number}/merge");

    let mut payload = serde_json::json!({
        "merge_method": merge_method,
    });
    if let Some(title) = commit_title.filter(|t| !t.trim().is_empty()) {
        payload["commit_title"] = serde_json::json!(title.trim());
    }
    if let Some(msg) = commit_message.filter(|m| !m.trim().is_empty()) {
        payload["commit_message"] = serde_json::json!(msg.trim());
    }
    if let Some(sha) = expected_head_sha.filter(|s| !s.trim().is_empty()) {
        payload["sha"] = serde_json::json!(sha.trim());
    }

    let response = client
        .put(&url)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .bearer_auth(&token)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Failed to send merge request: {}", e.without_url()))?;

    let status = response.status();
    let resp_body: serde_json::Value = response.json().await.unwrap_or(serde_json::Value::Null);

    if status.is_success() {
        let sha = resp_body.get("sha").and_then(|v| v.as_str()).map(ToString::to_string);
        let msg = resp_body.get("message").and_then(|v| v.as_str()).unwrap_or("Pull Request successfully merged.").to_string();
        return Ok(MergePRResult {
            success: true,
            sha,
            message: msg,
        });
    }

    let err_msg = match status.as_u16() {
        405 => "This pull request cannot be merged right now (merge conflict, required reviews missing, or CI checks failing).".to_string(),
        409 => {
            if resp_body.to_string().contains("head branch was modified") {
                "The head branch was modified since you loaded it. Please refresh and review latest commits before merging.".to_string()
            } else {
                "Merge conflict detected on GitHub.".to_string()
            }
        }
        _ => {
            let msg = resp_body.get("message").and_then(|v| v.as_str()).unwrap_or("GitHub refused the merge request.");
            format!("Merge failed ({status}): {msg}")
        }
    };

    Err(err_msg)
}

/// Post comment on a Pull Request.
#[tauri::command]
pub async fn source_control_add_pr_comment(
    project_id: String,
    repo_path: Option<String>,
    pr_number: u64,
    body: String,
    state: State<'_, AppState>,
) -> Result<WorkItemComment, String> {
    source_control_add_issue_comment(project_id, repo_path, pr_number, body, state).await
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRun {
    pub id: u64,
    pub name: String,
    pub display_title: String,
    pub run_number: u64,
    pub event: String,
    pub status: String,
    pub conclusion: Option<String>,
    pub head_branch: String,
    pub head_sha: String,
    pub actor: IssueAuthor,
    pub created_at: String,
    pub updated_at: String,
    pub run_started_at: Option<String>,
    pub html_url: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowJobStep {
    pub name: String,
    pub status: String,
    pub conclusion: Option<String>,
    pub number: u64,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowJob {
    pub id: u64,
    pub run_id: u64,
    pub name: String,
    pub status: String,
    pub conclusion: Option<String>,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub html_url: String,
    pub steps: Vec<WorkflowJobStep>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure_reason: Option<String>,
}

/// List workflow runs (GitHub Actions CI/CD).
#[tauri::command]
pub async fn source_control_list_workflow_runs(
    project_id: String,
    repo_path: Option<String>,
    branch: Option<String>,
    status_filter: Option<String>,
    page: Option<u32>,
    state: State<'_, AppState>,
) -> Result<Vec<WorkflowRun>, String> {
    check_git_available()?;
    let repo = resolve_repo(&project_id, repo_path.as_deref(), &state)?;
    let remote_url = run_git(&repo, &["remote", "get-url", "origin"])
        .map_err(|_| "Project has no origin remote configured.".to_string())?;

    let (provider, owner, repo_name) = parse_remote_url(&remote_url).ok_or_else(|| {
        "Origin remote is not a recognized GitHub or GitLab repository.".to_string()
    })?;

    let token = resolve_token(&provider).ok_or_else(|| {
        if provider == "gitlab" {
            "No GitLab authentication token found. Set $GITLAB_TOKEN or log in via glab (`glab auth login`).".to_string()
        } else {
            "No authentication token found. Please sign in via Settings, $GITHUB_TOKEN, or GitHub CLI (`gh auth login`).".to_string()
        }
    })?;

    let client = http_client();
    let page_num = page.unwrap_or(1);

    if provider == "gitlab" {
        let project_encoded = format!("{owner}%2F{repo_name}");
        let mut url = format!("https://gitlab.com/api/v4/projects/{project_encoded}/pipelines?per_page=30&page={page_num}");
        if let Some(b) = branch.filter(|s| !s.trim().is_empty() && s != "all") {
            url.push_str(&format!("&ref={b}"));
        }
        if let Some(s) = status_filter.filter(|s| !s.trim().is_empty() && s != "all") {
            let gl_status = match s.as_str() {
                "in_progress" => "running",
                "completed" | "success" => "success",
                "failure" => "failed",
                "queued" => "pending",
                other => other,
            };
            url.push_str(&format!("&status={gl_status}"));
        }

        let response = client
            .get(&url)
            .header("PRIVATE-TOKEN", &token)
            .send()
            .await
            .map_err(|e| format!("Failed to fetch GitLab pipelines: {}", e.without_url()))?;

        if !response.status().is_success() {
            let err_text = response.text().await.unwrap_or_default();
            return Err(format!("GitLab API error fetching pipelines: {err_text}"));
        }

        let items: Vec<serde_json::Value> = response.json().await.map_err(|e| e.to_string())?;
        let mut result = Vec::new();
        for item in items {
            let id = item.get("id").and_then(|v| v.as_u64()).unwrap_or(0);
            let head_branch = item.get("ref").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let head_sha = item.get("sha").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let gl_status = item.get("status").and_then(|v| v.as_str()).unwrap_or("pending");
            let (status, conclusion) = match gl_status {
                "running" => ("in_progress".to_string(), None),
                "success" => ("completed".to_string(), Some("success".to_string())),
                "failed" => ("completed".to_string(), Some("failure".to_string())),
                "canceled" => ("completed".to_string(), Some("cancelled".to_string())),
                "skipped" => ("completed".to_string(), Some("skipped".to_string())),
                "manual" => ("queued".to_string(), Some("action_required".to_string())),
                _ => ("queued".to_string(), None),
            };
            let created_at = item.get("created_at").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let updated_at = item.get("updated_at").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let html_url = item.get("web_url").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let source = item.get("source").and_then(|v| v.as_str()).unwrap_or("pipeline").to_string();

            result.push(WorkflowRun {
                id,
                name: format!("Pipeline #{id}"),
                display_title: format!("Pipeline #{id} ({head_branch})"),
                run_number: id,
                event: source,
                status,
                conclusion,
                head_branch,
                head_sha,
                actor: IssueAuthor {
                    login: owner.clone(),
                    avatar_url: String::new(),
                },
                created_at: created_at.clone(),
                updated_at,
                run_started_at: Some(created_at),
                html_url,
            });
        }
        return Ok(result);
    }

    if provider != "github" {
        return Err(format!("CI/CD pipelines are not yet supported for provider '{provider}'. Supported hosts: GitHub Actions and GitLab CI/CD."));
    }

    let mut url = format!("{GITHUB_API}/repos/{owner}/{repo_name}/actions/runs?per_page=30&page={page_num}");
    if let Some(b) = branch.filter(|s| !s.trim().is_empty() && s != "all") {
        url.push_str(&format!("&branch={b}"));
    }
    if let Some(s) = status_filter.filter(|s| !s.trim().is_empty() && s != "all") {
        url.push_str(&format!("&status={s}"));
    }

    let response = client
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch workflow runs: {}", e.without_url()))?;

    if !response.status().is_success() {
        let err_text = response.text().await.unwrap_or_default();
        return Err(format!("GitHub API returned error fetching workflow runs: {err_text}"));
    }

    let payload: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
    let runs_arr = payload.get("workflow_runs").and_then(|v| v.as_array()).cloned().unwrap_or_default();

    let mut result = Vec::new();
    for r in runs_arr {
        let id = r.get("id").and_then(|v| v.as_u64()).unwrap_or(0);
        let name = r.get("name").and_then(|v| v.as_str()).unwrap_or("Workflow").to_string();
        let display_title = r.get("display_title").and_then(|v| v.as_str()).unwrap_or(&name).to_string();
        let run_number = r.get("run_number").and_then(|v| v.as_u64()).unwrap_or(0);
        let event = r.get("event").and_then(|v| v.as_str()).unwrap_or("push").to_string();
        let status = r.get("status").and_then(|v| v.as_str()).unwrap_or("queued").to_string();
        let conclusion = r.get("conclusion").and_then(|v| v.as_str()).map(ToString::to_string);
        let head_branch = r.get("head_branch").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let head_sha = r.get("head_sha").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let created_at = r.get("created_at").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let updated_at = r.get("updated_at").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let run_started_at = r.get("run_started_at").and_then(|v| v.as_str()).map(ToString::to_string);
        let html_url = r.get("html_url").and_then(|v| v.as_str()).unwrap_or("").to_string();

        let actor = r.get("actor").map(|a| IssueAuthor {
            login: a.get("login").and_then(|v| v.as_str()).unwrap_or("ghost").to_string(),
            avatar_url: a.get("avatar_url").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        }).unwrap_or(IssueAuthor {
            login: "ghost".to_string(),
            avatar_url: String::new(),
        });

        result.push(WorkflowRun {
            id,
            name,
            display_title,
            run_number,
            event,
            status,
            conclusion,
            head_branch,
            head_sha,
            actor,
            created_at,
            updated_at,
            run_started_at,
            html_url,
        });
    }

    Ok(result)
}

/// Fetch jobs for a workflow run.
#[tauri::command]
pub async fn source_control_get_workflow_run_jobs(
    project_id: String,
    repo_path: Option<String>,
    run_id: u64,
    state: State<'_, AppState>,
) -> Result<Vec<WorkflowJob>, String> {
    check_git_available()?;
    let repo = resolve_repo(&project_id, repo_path.as_deref(), &state)?;
    let remote_url = run_git(&repo, &["remote", "get-url", "origin"])
        .map_err(|_| "Project has no origin remote configured.".to_string())?;

    let (provider, owner, repo_name) = parse_remote_url(&remote_url).ok_or_else(|| {
        "Origin remote is not a recognized GitHub or GitLab repository.".to_string()
    })?;

    let token = resolve_token(&provider).ok_or_else(|| {
        "No authentication token found.".to_string()
    })?;

    let client = http_client();

    if provider == "gitlab" {
        let project_encoded = format!("{owner}%2F{repo_name}");
        let url = format!("https://gitlab.com/api/v4/projects/{project_encoded}/pipelines/{run_id}/jobs?per_page=100");
        let response = client
            .get(&url)
            .header("PRIVATE-TOKEN", &token)
            .send()
            .await
            .map_err(|e| format!("Failed to fetch GitLab pipeline jobs: {}", e.without_url()))?;

        if !response.status().is_success() {
            return Err(format!("Could not load GitLab pipeline jobs ({})", response.status()));
        }

        let jobs_arr: Vec<serde_json::Value> = response.json().await
            .map_err(|_| "GitLab returned an unreadable job list.")?;
        let mut result = Vec::new();
        for j in jobs_arr {
            let id = j.get("id").and_then(|v| v.as_u64()).unwrap_or(0);
            let name = j.get("name").and_then(|v| v.as_str()).unwrap_or("job").to_string();
            let gl_status = j.get("status").and_then(|v| v.as_str()).unwrap_or("pending");
            let (status, conclusion) = match gl_status {
                "running" => ("in_progress".to_string(), None),
                "success" => ("completed".to_string(), Some("success".to_string())),
                "failed" => ("completed".to_string(), Some("failure".to_string())),
                "canceled" => ("completed".to_string(), Some("cancelled".to_string())),
                "skipped" => ("completed".to_string(), Some("skipped".to_string())),
                _ => ("queued".to_string(), None),
            };
            let started_at = j.get("started_at").and_then(|v| v.as_str()).map(ToString::to_string);
            let completed_at = j.get("finished_at").and_then(|v| v.as_str()).map(ToString::to_string);
            let html_url = j.get("web_url").and_then(|v| v.as_str()).unwrap_or("").to_string();

            result.push(WorkflowJob {
                id,
                run_id,
                name,
                status,
                conclusion,
                started_at,
                completed_at,
                html_url,
                steps: Vec::new(),
                failure_reason: j.get("failure_reason").and_then(|v| v.as_str()).map(ToString::to_string),
            });
        }
        return Ok(result);
    }

    let url = format!("{GITHUB_API}/repos/{owner}/{repo_name}/actions/runs/{run_id}/jobs?per_page=100");

    let response = client
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch workflow jobs: {}", e.without_url()))?;

    if !response.status().is_success() {
        return Err(format!("Could not load GitHub workflow jobs ({})", response.status()));
    }

    let payload: serde_json::Value = response.json().await
        .map_err(|_| "GitHub returned an unreadable job list.")?;
    let jobs_arr = payload.get("jobs").and_then(|v| v.as_array())
        .ok_or("GitHub returned no workflow job list.")?;

    let mut result = Vec::new();
    for j in jobs_arr {
        let id = j.get("id").and_then(|v| v.as_u64()).unwrap_or(0);
        let name = j.get("name").and_then(|v| v.as_str()).unwrap_or("job").to_string();
        let status = j.get("status").and_then(|v| v.as_str()).unwrap_or("queued").to_string();
        let conclusion = j.get("conclusion").and_then(|v| v.as_str()).map(ToString::to_string);
        let started_at = j.get("started_at").and_then(|v| v.as_str()).map(ToString::to_string);
        let completed_at = j.get("completed_at").and_then(|v| v.as_str()).map(ToString::to_string);
        let html_url = j.get("html_url").and_then(|v| v.as_str()).unwrap_or("").to_string();

        let mut steps = Vec::new();
        if let Some(steps_arr) = j.get("steps").and_then(|v| v.as_array()) {
            for s in steps_arr {
                let s_name = s.get("name").and_then(|v| v.as_str()).unwrap_or("step").to_string();
                let s_status = s.get("status").and_then(|v| v.as_str()).unwrap_or("queued").to_string();
                let s_conclusion = s.get("conclusion").and_then(|v| v.as_str()).map(ToString::to_string);
                let s_number = s.get("number").and_then(|v| v.as_u64()).unwrap_or(0);
                let s_started = s.get("started_at").and_then(|v| v.as_str()).map(ToString::to_string);
                let s_completed = s.get("completed_at").and_then(|v| v.as_str()).map(ToString::to_string);

                steps.push(WorkflowJobStep {
                    name: s_name,
                    status: s_status,
                    conclusion: s_conclusion,
                    number: s_number,
                    started_at: s_started,
                    completed_at: s_completed,
                });
            }
        }

        result.push(WorkflowJob {
            id,
            run_id,
            name,
            status,
            conclusion,
            started_at,
            completed_at,
            html_url,
            steps,
            failure_reason: None,
        });
    }

    Ok(result)
}

/// Fetch a bounded log excerpt for the current project's job.
#[tauri::command]
pub async fn source_control_get_workflow_job_log(
    project_id: String,
    repo_path: Option<String>,
    job_id: u64,
    state: State<'_, AppState>,
) -> Result<String, String> {
    const MAX_LOG_BYTES: usize = 8 * 1024;
    static ANSI: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"\x1b\[[0-?]*[ -/]*[@-~]").unwrap());

    check_git_available()?;
    let repo = resolve_repo(&project_id, repo_path.as_deref(), &state)?;
    let remote = run_git(&repo, &["remote", "get-url", "origin"])
        .map_err(|_| "Project has no origin remote configured.")?;
    let (provider, owner, repo_name) = parse_remote_url(&remote)
        .ok_or("Origin remote is not a recognized GitHub or GitLab repository.")?;
    let url = match provider.as_str() {
        "github" => format!("{GITHUB_API}/repos/{owner}/{repo_name}/actions/jobs/{job_id}/logs"),
        "gitlab" => format!("https://gitlab.com/api/v4/projects/{owner}%2F{repo_name}/jobs/{job_id}/trace"),
        _ => return Err("Job logs are supported for GitHub Actions and GitLab CI/CD.".into()),
    };
    let token = resolve_token(&provider).ok_or("No authentication token found.")?;
    let log_error = |err: reqwest::Error| format!("Job log unavailable ({})", err.without_url());
    let mut response = http_client()
        .get(url)
        .bearer_auth(&token)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(log_error)?;

    let mut tail = Vec::new();
    let mut truncated = false;
    while let Some(chunk) = response.chunk().await.map_err(log_error)? {
        if chunk.len() >= MAX_LOG_BYTES {
            truncated |= !tail.is_empty() || chunk.len() > MAX_LOG_BYTES;
            tail.clear();
            tail.extend_from_slice(&chunk[chunk.len() - MAX_LOG_BYTES..]);
        } else {
            let overflow = (tail.len() + chunk.len()).saturating_sub(MAX_LOG_BYTES);
            truncated |= overflow > 0;
            tail.drain(..overflow);
            tail.extend_from_slice(&chunk);
        }
    }
    let text = String::from_utf8_lossy(&tail);
    let text = if truncated {
        text.split_once('\n').map_or(text.as_ref(), |(_, rest)| rest)
    } else {
        text.as_ref()
    };
    let clean = ANSI.replace_all(text, "");
    let clean = super::secrets::redact_secrets(&clean.replace(token.as_str(), "[redacted]"));
    let excerpt = clean.trim();
    if excerpt.is_empty() {
        Err("The provider returned an empty job log.".into())
    } else if truncated {
        Ok(format!("[End of job log]\n{excerpt}"))
    } else {
        Ok(excerpt.to_string())
    }
}

/// Re-run a workflow run.
#[tauri::command]
pub async fn source_control_rerun_workflow(
    project_id: String,
    repo_path: Option<String>,
    run_id: u64,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    check_git_available()?;
    let repo = resolve_repo(&project_id, repo_path.as_deref(), &state)?;
    let remote_url = run_git(&repo, &["remote", "get-url", "origin"])
        .map_err(|_| "Project has no origin remote configured.".to_string())?;

    let (provider, owner, repo_name) = parse_remote_url(&remote_url).ok_or_else(|| {
        "Origin remote is not a recognized GitHub or GitLab repository.".to_string()
    })?;

    let token = resolve_token(&provider).ok_or_else(|| {
        "No authentication token found.".to_string()
    })?;

    let client = http_client();

    if provider == "gitlab" {
        let project_encoded = format!("{owner}%2F{repo_name}");
        let url = format!("https://gitlab.com/api/v4/projects/{project_encoded}/pipelines/{run_id}/retry");
        let response = client
            .post(&url)
            .header("PRIVATE-TOKEN", &token)
            .send()
            .await
            .map_err(|e| format!("Failed to retry GitLab pipeline: {}", e.without_url()))?;

        return if response.status().is_success() || response.status().as_u16() == 201 {
            Ok(true)
        } else {
            let msg = response.text().await.unwrap_or_default();
            Err(format!("Could not retry GitLab pipeline: {msg}"))
        };
    }

    let url = format!("{GITHUB_API}/repos/{owner}/{repo_name}/actions/runs/{run_id}/rerun");

    let response = client
        .post(&url)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| format!("Failed to rerun workflow: {}", e.without_url()))?;

    if response.status().is_success() || response.status().as_u16() == 201 {
        Ok(true)
    } else {
        let msg = response.text().await.unwrap_or_default();
        Err(format!("Could not rerun workflow: {msg}"))
    }
}

/// Cancel an in-progress workflow run.
#[tauri::command]
pub async fn source_control_cancel_workflow_run(
    project_id: String,
    repo_path: Option<String>,
    run_id: u64,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    check_git_available()?;
    let repo = resolve_repo(&project_id, repo_path.as_deref(), &state)?;
    let remote_url = run_git(&repo, &["remote", "get-url", "origin"])
        .map_err(|_| "Project has no origin remote configured.".to_string())?;

    let (provider, owner, repo_name) = parse_remote_url(&remote_url).ok_or_else(|| {
        "Origin remote is not a recognized GitHub or GitLab repository.".to_string()
    })?;

    let token = resolve_token(&provider).ok_or_else(|| {
        "No authentication token found.".to_string()
    })?;

    let client = http_client();

    if provider == "gitlab" {
        let project_encoded = format!("{owner}%2F{repo_name}");
        let url = format!("https://gitlab.com/api/v4/projects/{project_encoded}/pipelines/{run_id}/cancel");
        let response = client
            .post(&url)
            .header("PRIVATE-TOKEN", &token)
            .send()
            .await
            .map_err(|e| format!("Failed to cancel GitLab pipeline: {}", e.without_url()))?;

        return if response.status().is_success() || response.status().as_u16() == 200 {
            Ok(true)
        } else {
            let msg = response.text().await.unwrap_or_default();
            Err(format!("Could not cancel GitLab pipeline: {msg}"))
        };
    }

    let url = format!("{GITHUB_API}/repos/{owner}/{repo_name}/actions/runs/{run_id}/cancel");

    let response = client
        .post(&url)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| format!("Failed to cancel workflow: {}", e.without_url()))?;

    if response.status().is_success() || response.status().as_u16() == 202 {
        Ok(true)
    } else {
        let msg = response.text().await.unwrap_or_default();
        Err(format!("Could not cancel workflow: {msg}"))
    }
}
