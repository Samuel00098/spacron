use crate::state::AppState;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use sysinfo::{Pid, ProcessesToUpdate, System};
use tauri::State;

/// Persistent process sampler owned by `AppState`.
///
/// sysinfo's CPU numbers are *deltas*: `System::global_cpu_usage()` and
/// `Process::cpu_usage()` only become meaningful once the same `System`
/// instance has been refreshed twice. Recreating a `System` per command call
/// would therefore always read garbage. Keeping one here — and letting the
/// frontend poll it every ~2s — makes each call's refresh the previous call's
/// baseline, so the numbers settle after the first warm-up poll.
pub struct ResourceSampler {
    sys: Mutex<System>,
    /// False until the first snapshot has run. sysinfo needs one refresh to
    /// establish a baseline before `*_cpu_usage()` reports a delta, so the
    /// first call returns `None` CPU values instead of the bogus "usage since
    /// boot" reading.
    warmed: AtomicBool,
}

impl Default for ResourceSampler {
    fn default() -> Self {
        Self {
            sys: Mutex::new(System::new()),
            warmed: AtomicBool::new(false),
        }
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemResources {
    pub cpu_percent: Option<f32>,
    pub mem_used_bytes: u64,
    pub mem_total_bytes: u64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionResources {
    /// Backend pty session id — the join key to the frontend's session list.
    pub session_id: u32,
    pub pid: Option<u32>,
    pub cpu_percent: Option<f32>,
    pub mem_bytes: u64,
    /// Number of live processes in the session's process tree (shell + every
    /// descendant). The panel shows this as "N processes" per terminal so the
    /// user can see how much work an agent actually fans out.
    pub process_count: u32,
    /// Whether the OS still knows the root process. A session whose shell
    /// exited is listed as dead rather than dropped, so the frontend can keep
    /// its row (greyed) until the session bookkeeping catches up.
    pub alive: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceSnapshot {
    pub system: SystemResources,
    pub sessions: Vec<SessionResources>,
}

/// Sum CPU + RAM + process count over a process tree rooted at `pid` (the
/// process itself plus every descendant). The session's PTY child is the
/// *shell*; the agent runs inside it as a child, so measuring only the shell
/// would read ~0% for the exact sessions the monitor exists for. A children
/// map built from `Process::parent()` lets one pass sum the whole subtree.
fn sum_tree(pid: u32, sys: &System, children: &HashMap<u32, Vec<u32>>) -> (f32, u64, u32) {
    let mut cpu = 0.0f32;
    let mut mem = 0u64;
    let mut process_count = 0u32;
    let mut stack = vec![pid];
    while let Some(current) = stack.pop() {
        if let Some(process) = sys.process(Pid::from_u32(current)) {
            cpu += process.cpu_usage();
            mem += process.memory();
            process_count += 1;
        }
        // A fresh process's first `cpu_usage()` after refresh reads as its
        // total CPU since spawn — a one-poll spike, self-correcting on the
        // next tick. Deliberately not clamped here; see the `warmed` note.
        if let Some(kids) = children.get(&current) {
            stack.extend(kids.iter().copied());
        }
    }
    (cpu, mem, process_count)
}

/// Live CPU/RAM for the machine and for every open pty session.
///
/// The frontend polls this while the titlebar resource chip is mounted. It is
/// deliberately read-only — killing a session stays on the existing
/// `terminal_close` path so the kill goes through the same reclaim/cleanup
/// bookkeeping as every other close.
#[tauri::command]
pub fn resource_snapshot(state: State<AppState>) -> Result<ResourceSnapshot, String> {
    let sampler = &state.resource_sampler;
    let mut sys = sampler.sys.lock().map_err(|e| e.to_string())?;

    sys.refresh_memory();
    sys.refresh_cpu_usage();
    // Refresh ALL processes (not just session pids): the tree sum needs the
    // parent→children map to cover the whole subtree below each shell, and
    // that requires seeing every process, not only the roots we already know.
    sys.refresh_processes(ProcessesToUpdate::All, true);

    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for (pid, process) in sys.processes() {
        if let Some(parent) = process.parent() {
            children
                .entry(parent.as_u32())
                .or_default()
                .push(pid.as_u32());
        }
    }

    let warmed = sampler.warmed.swap(true, Ordering::Relaxed);

    let system = SystemResources {
        cpu_percent: if warmed { Some(sys.global_cpu_usage()) } else { None },
        mem_used_bytes: sys.used_memory(),
        mem_total_bytes: sys.total_memory(),
    };

    let mut sessions = Vec::with_capacity(state.pty_manager.list_ids().len());
    for id in state.pty_manager.list_ids() {
        let session = state.pty_manager.get(id);
        let pid = session.as_ref().and_then(|s| s.pid);
        let (cpu_percent, mem_bytes, process_count, alive) = match pid {
            Some(pid) => {
                let alive = sys.process(Pid::from_u32(pid)).is_some();
                let (tree_cpu, tree_mem, tree_procs) = sum_tree(pid, &sys, &children);
                (
                    if warmed { Some(tree_cpu) } else { None },
                    tree_mem,
                    tree_procs,
                    alive,
                )
            }
            None => (None, 0, 0, false),
        };
        sessions.push(SessionResources {
            session_id: id,
            pid,
            cpu_percent,
            mem_bytes,
            process_count,
            alive,
        });
    }
    // Hot sessions first — the same "worst leads" ordering the usage dock uses.
    sessions.sort_by(|a, b| {
        b.cpu_percent
            .unwrap_or(0.0)
            .partial_cmp(&a.cpu_percent.unwrap_or(0.0))
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    Ok(ResourceSnapshot { system, sessions })
}

/// Per-root disk usage, cached for [`DISK_USAGE_TTL`]. Walking a project tree
/// (node_modules, build output, git objects…) is far too slow to run on every
/// 2s resource poll — the panel asks for it when it opens and on manual
/// refresh, and the cache makes repeated opens cheap.
pub struct DiskUsageCache {
    entries: Mutex<HashMap<String, (Instant, u64)>>,
}

impl Default for DiskUsageCache {
    fn default() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()), // HashMap::new() is const since 1.81, keep explicit
        }
    }
}

/// How long a scanned directory size stays fresh. Disk usage moves in
/// minutes, not seconds — a project won't grow 2 GB inside a minute.
const DISK_USAGE_TTL: Duration = Duration::from_secs(60);

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDiskUsage {
    /// The project root that was scanned (matches the input `root` key).
    pub root: String,
    pub bytes: u64,
}

/// Whether `root` is a path this command is allowed to walk: a registered
/// project's root, or something inside one (an agent worktree under
/// `.spacron/worktrees/` is the case that matters).
///
/// Every other filesystem command here refuses paths outside an open project —
/// `fs_write_file` has said so since the MCP config writers were routed away
/// from it — and this one is no different just because it only returns a total.
/// An unscoped recursive walk is both a disclosure channel (does this path
/// exist, how big is it) and a cheap way to hang a poll on `C:\`. Scoping also
/// bounds the TTL cache, which is keyed by the caller's string: with arbitrary
/// roots it grew without limit.
fn root_is_in_scope(project_roots: &[PathBuf], root: &str) -> bool {
    let cleaned = crate::commands::clean_path_buf(PathBuf::from(root));
    project_roots.iter().any(|project_root| {
        crate::commands::workspace::is_under(
            &cleaned,
            &crate::commands::clean_path_buf(project_root.clone()),
        )
    })
}

/// Total on-disk size of each requested project root (all files recursively;
/// `.git` included — the project's real footprint on the machine).
///
/// Hits served from the cache; misses walked in a blocking task so the IPC
/// thread never stalls on a slow disk. Missing paths report `bytes: 0` rather
/// than erroring, so a project that was closed mid-session degrades gracefully.
///
/// Roots outside every registered project are dropped from the result rather
/// than scanned or reported as zero — see [`root_is_in_scope`]. Omitting them
/// is what lets the panel tell "not measured" apart from "empty", and it is the
/// same answer for a path that does not exist as for one that does.
#[tauri::command]
pub async fn project_disk_usage(
    state: State<'_, AppState>,
    roots: Vec<String>,
) -> Result<Vec<ProjectDiskUsage>, String> {
    let project_roots: Vec<PathBuf> = state
        .workspace_manager
        .list_projects()
        .into_iter()
        .map(|project| project.root_path)
        .collect();
    let roots: Vec<String> = roots
        .into_iter()
        .filter(|root| root_is_in_scope(&project_roots, root))
        .collect();

    let cache = &state.disk_usage_cache;
    let now = Instant::now();

    // Read the cache first, collecting the roots that need a fresh walk.
    let mut fresh: Vec<String> = Vec::new();
    let mut result: Vec<ProjectDiskUsage> = Vec::with_capacity(roots.len());
    {
        let entries = cache.entries.lock().map_err(|e| e.to_string())?;
        for root in roots {
            match entries.get(&root) {
                Some((at, bytes)) if now.duration_since(*at) < DISK_USAGE_TTL => {
                    result.push(ProjectDiskUsage {
                        root,
                        bytes: *bytes,
                    });
                }
                _ => fresh.push(root),
            }
        }
    }

    if !fresh.is_empty() {
        let scanned = tokio::task::spawn_blocking(move || {
            fresh
                .into_iter()
                .map(|root| {
                    let bytes = dir_size(&root);
                    (root, bytes)
                })
                .collect::<Vec<_>>()
        })
        .await
        .map_err(|e| e.to_string())?;

        let mut entries = cache.entries.lock().map_err(|e| e.to_string())?;
        for (root, bytes) in scanned {
            entries.insert(root.clone(), (Instant::now(), bytes));
            result.push(ProjectDiskUsage { root, bytes });
        }
    }

    // Biggest projects first — the "what's eating my disk" ordering.
    result.sort_by(|a, b| b.bytes.cmp(&a.bytes));
    Ok(result)
}

/// Recursively sum file sizes under `root`. Symlinked dirs are not followed
/// (a node_modules → packages junction would otherwise count the same files
/// many times over, and a cycle would loop forever).
fn dir_size(root: &str) -> u64 {
    walkdir::WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().is_file())
        .filter_map(|entry| entry.metadata().ok())
        .map(|meta| meta.len())
        .sum()
}

#[cfg(test)]
mod tests {
    use super::root_is_in_scope;
    use std::path::PathBuf;

    fn projects() -> Vec<PathBuf> {
        vec![PathBuf::from("C:/work/spacron"), PathBuf::from("/home/u/api")]
    }

    #[test]
    fn a_project_root_and_its_contents_are_in_scope() {
        assert!(root_is_in_scope(&projects(), "C:/work/spacron"));
        assert!(root_is_in_scope(&projects(), "/home/u/api"));
        // Agent worktrees live inside the project and are worth measuring.
        assert!(root_is_in_scope(
            &projects(),
            "C:/work/spacron/.spacron/worktrees/spacron-neo-342ci1"
        ));
    }

    #[test]
    fn everything_outside_every_project_is_refused() {
        // The walk this gates is recursive: a root of `C:\` would hang a poll
        // for minutes and answer "how much is on this disk" to anything that
        // can invoke.
        assert!(!root_is_in_scope(&projects(), "C:/"));
        assert!(!root_is_in_scope(&projects(), "C:/Users/u/Documents"));
        assert!(!root_is_in_scope(&projects(), "/home/u"));
        assert!(!root_is_in_scope(&projects(), "/etc"));
        // A sibling that merely shares a prefix is not inside the project.
        assert!(!root_is_in_scope(&projects(), "C:/work/spacron-secrets"));
        // With no projects open there is nothing legitimate left to scan.
        assert!(!root_is_in_scope(&[], "C:/work/spacron"));
    }

    #[cfg(windows)]
    #[test]
    fn windows_paths_match_however_they_are_spelled() {
        // The frontend passes the root back exactly as `list_projects` gave it,
        // but a session cwd reaches us in whatever casing and separator the
        // shell used — and on Windows those are the same directory.
        assert!(root_is_in_scope(&projects(), r"C:\work\spacron"));
        assert!(root_is_in_scope(&projects(), r"c:\WORK\Spacron\src"));
    }
}
