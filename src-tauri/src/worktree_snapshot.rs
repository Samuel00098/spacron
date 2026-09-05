//! Save agent edits before any operation that only reads committed changes.
use std::path::Path;
use std::process::{Command, Output};

pub(crate) fn snapshot(worktree: &Path, git: impl Fn() -> Command) -> Result<bool, String> {
    let run = |args: &[&str]| -> Result<Output, String> {
        let output = git()
            .args(args)
            .current_dir(worktree)
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
            .map_err(|e| format!("Could not snapshot agent work: {e}"))?;
        if !output.status.success() {
            return Err(format!(
                "Could not snapshot agent work (git {}): {}",
                args[0],
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        Ok(output)
    };
    if run(&["status", "--porcelain"])?.stdout.is_empty() {
        return Ok(false);
    }
    run(&["add", "-A"])?;
    let mut args = Vec::new();
    // Resolve name and email independently: either can be missing.
    for (key, fallback) in [
        ("user.name", "user.name=Spacron"),
        ("user.email", "user.email=agent@spacron.local"),
    ] {
        let configured = git()
            .args(["config", "--get", key])
            .current_dir(worktree)
            .output()
            .map(|o| o.status.success() && !String::from_utf8_lossy(&o.stdout).trim().is_empty())
            .unwrap_or(false);
        if !configured {
            args.extend(["-c", fallback]);
        }
    }
    // Internal snapshots need neither signing credentials nor user commit hooks.
    // The user's final commit still uses their normal signing and hook settings.
    args.extend([
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--no-verify",
        "-m",
        "spacron: snapshot uncommitted agent work",
    ]);
    run(&args)?;
    // An agent may have written again during the snapshot. Keep its checkout and
    // abort this operation rather than claiming all edits were brought in.
    if !run(&["status", "--porcelain"])?.stdout.is_empty() {
        return Err("Agent work changed while being saved. Wait for the agent to finish, then try again; its worktree was kept.".into());
    }
    Ok(true)
}

/// Removal is a separate step from committing. Never force it: Git must refuse
/// dirty, locked or otherwise unsafe checkouts, including orphan sweep targets.
/// Callers enforce the managed-worktree path boundary and hold the repo lock.
pub(crate) fn remove_clean(
    workspace: &Path,
    worktree: &Path,
    git: impl Fn() -> Command,
) -> Result<(), String> {
    let output = git()
        .args(["worktree", "remove"])
        .arg(worktree)
        .current_dir(workspace)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| format!("Could not remove worktree: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "Could not remove worktree: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    if worktree.exists() {
        return Err("Git left the worktree directory in place; cleanup will be retried.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        path::PathBuf,
        sync::atomic::{AtomicUsize, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    struct Repo(PathBuf);
    fn git() -> Command {
        let mut c = Command::new("git");
        c.env("GIT_CONFIG_NOSYSTEM", "1").env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        );
        c
    }
    fn run(path: &Path, args: &[&str]) -> String {
        let o = git().args(args).current_dir(path).output().unwrap();
        assert!(
            o.status.success(),
            "{:?}: {}",
            args,
            String::from_utf8_lossy(&o.stderr)
        );
        String::from_utf8_lossy(&o.stdout).trim().to_string()
    }
    impl Repo {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "spacron-local-worktree-{}-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            run(&path, &["init", "-b", "main"]);
            run(&path, &["config", "user.name", "Test"]);
            run(&path, &["config", "user.email", "test@example.invalid"]);
            fs::write(path.join("app.txt"), "base\n").unwrap();
            snapshot(&path, git).unwrap();
            Self(path)
        }
        fn worker(&self, name: &str) -> PathBuf {
            let path = self.0.join(".spacron/worktrees").join(name);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            run(
                &self.0,
                &["config", "core.excludesFile", ".git/info/exclude"],
            );
            fs::write(self.0.join(".git/info/exclude"), "/.spacron/\n").unwrap();
            run(
                &self.0,
                &["worktree", "add", "-b", name, path.to_str().unwrap()],
            );
            path
        }
    }
    impl Drop for Repo {
        fn drop(&mut self) {
            assert_eq!(self.0.parent(), Some(std::env::temp_dir().as_path()));
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn snapshot_failure_keeps_uncommitted_work() {
        let repo = Repo::new();
        let worker = repo.worker("agent");
        fs::write(worker.join("app.txt"), "agent edit\n").unwrap();
        let gitdir = run(&worker, &["rev-parse", "--absolute-git-dir"]);
        fs::write(Path::new(&gitdir).join("index.lock"), "locked").unwrap();
        assert!(snapshot(&worker, git).unwrap_err().contains("index.lock"));
        assert_eq!(
            fs::read_to_string(worker.join("app.txt")).unwrap(),
            "agent edit\n"
        );
        assert_eq!(
            fs::read_to_string(repo.0.join("app.txt")).unwrap(),
            "base\n"
        );
    }
    #[test]
    fn internal_snapshot_does_not_need_a_signing_key_or_complete_identity() {
        let repo = Repo::new();
        run(&repo.0, &["config", "--unset", "user.name"]);
        run(&repo.0, &["config", "commit.gpgsign", "true"]);
        run(
            &repo.0,
            &["config", "gpg.program", "spacron-missing-signing-program"],
        );
        fs::write(repo.0.join("app.txt"), "saved\n").unwrap();
        assert!(snapshot(&repo.0, git).unwrap());
        assert_eq!(run(&repo.0, &["config", "commit.gpgsign"]), "true");
        assert!(!snapshot(&repo.0, git).unwrap());
    }
    #[test]
    fn uncommitted_agent_work_merges_locally_without_a_remote() {
        let repo = Repo::new();
        let worker = repo.worker("agent");
        fs::write(worker.join("app.txt"), "ready to test\n").unwrap();
        snapshot(&worker, git).unwrap();
        run(&repo.0, &["merge", "--no-ff", "agent", "-m", "Local merge"]);
        assert_eq!(
            fs::read_to_string(repo.0.join("app.txt")).unwrap(),
            "ready to test\n"
        );
        assert!(worker.exists());
        assert!(run(&repo.0, &["remote"]).is_empty());
    }
    // Exercise the same binary, three-way patch sequence used by Bring in.
    fn bring_in(root: &Path, worker: &Path, since: &str) -> (bool, String) {
        use std::io::Write;
        use std::process::Stdio;
        snapshot(worker, git).unwrap();
        let head = run(worker, &["rev-parse", "HEAD"]);
        let patch = git()
            .args([
                "diff",
                "--binary",
                "--no-renames",
                &format!("{since}..{head}"),
            ])
            .current_dir(root)
            .output()
            .unwrap();
        assert!(patch.status.success());
        let mut apply = git()
            .args(["apply", "--3way", "--index"])
            .current_dir(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        apply
            .stdin
            .take()
            .unwrap()
            .write_all(&patch.stdout)
            .unwrap();
        let applied = apply.wait_with_output().unwrap();
        (applied.status.success(), head)
    }
    #[test]
    fn bring_in_supports_repeated_turns_and_multiple_agents_before_committing() {
        let repo = Repo::new();
        let base = run(&repo.0, &["rev-parse", "HEAD"]);
        let first = repo.worker("first");
        let second = repo.worker("second");
        fs::write(first.join("app.txt"), "first turn\n").unwrap();
        let (ok, tip) = bring_in(&repo.0, &first, &base);
        assert!(ok);
        fs::write(first.join("app.txt"), "second turn\n").unwrap();
        assert!(bring_in(&repo.0, &first, &tip).0);
        fs::write(second.join("image.bin"), [0u8, 255, 42]).unwrap();
        assert!(bring_in(&repo.0, &second, &base).0);
        assert_eq!(
            fs::read_to_string(repo.0.join("app.txt")).unwrap(),
            "second turn\n"
        );
        assert_eq!(fs::read(repo.0.join("image.bin")).unwrap(), [0, 255, 42]);
        assert_eq!(run(&repo.0, &["rev-parse", "HEAD"]), base);
        assert!(!repo.0.join(".git/MERGE_HEAD").exists());
        assert!(run(&repo.0, &["remote"]).is_empty());
    }
    #[test]
    fn bring_in_preserves_overlapping_unstaged_local_edits() {
        let repo = Repo::new();
        let base = run(&repo.0, &["rev-parse", "HEAD"]);
        let worker = repo.worker("agent");
        fs::write(repo.0.join("app.txt"), "my local edit\n").unwrap();
        fs::write(worker.join("app.txt"), "agent edit\n").unwrap();
        assert!(!bring_in(&repo.0, &worker, &base).0);
        assert_eq!(
            fs::read_to_string(repo.0.join("app.txt")).unwrap(),
            "my local edit\n"
        );
        assert_eq!(
            fs::read_to_string(worker.join("app.txt")).unwrap(),
            "agent edit\n"
        );
    }
    #[test]
    fn bring_in_marks_conflicts_between_agents_and_keeps_both_worktrees() {
        let repo = Repo::new();
        let base = run(&repo.0, &["rev-parse", "HEAD"]);
        let first = repo.worker("first");
        let second = repo.worker("second");
        fs::write(first.join("app.txt"), "first agent\n").unwrap();
        fs::write(second.join("app.txt"), "second agent\n").unwrap();
        assert!(bring_in(&repo.0, &first, &base).0);
        assert!(!bring_in(&repo.0, &second, &base).0);
        assert_eq!(
            run(&repo.0, &["diff", "--name-only", "--diff-filter=U"]),
            "app.txt"
        );
        assert!(first.exists() && second.exists());
    }
    #[test]
    fn cleanup_removes_checkout_and_ignored_dependencies_but_keeps_recovery_branch() {
        let repo = Repo::new();
        let worker = repo.worker("agent");
        fs::write(worker.join(".gitignore"), "node_modules/\n").unwrap();
        fs::create_dir(worker.join("node_modules")).unwrap();
        fs::write(worker.join("node_modules/cache"), "dependency data").unwrap();
        snapshot(&worker, git).unwrap();
        remove_clean(&repo.0, &worker, git).unwrap();
        assert!(!worker.exists());
        assert!(!run(&repo.0, &["rev-parse", "agent"]).is_empty());
        assert!(!run(&repo.0, &["worktree", "list", "--porcelain"]).contains("refs/heads/agent"));
    }
    #[test]
    fn cleanup_refuses_dirty_and_locked_checkouts() {
        let repo = Repo::new();
        let worker = repo.worker("agent");
        fs::write(worker.join("app.txt"), "unsaved agent work\n").unwrap();
        assert!(remove_clean(&repo.0, &worker, git).is_err());
        assert_eq!(
            fs::read_to_string(worker.join("app.txt")).unwrap(),
            "unsaved agent work\n"
        );
        snapshot(&worker, git).unwrap();
        run(&repo.0, &["worktree", "lock", worker.to_str().unwrap()]);
        assert!(remove_clean(&repo.0, &worker, git).is_err());
        assert!(worker.exists());
    }
}
