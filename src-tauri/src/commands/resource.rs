use crate::state::AppState;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use sysinfo::{Pid, Process, ProcessesToUpdate, System};
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
    /// Machine-wide CPU load, 0–100.
    pub cpu_percent: Option<f32>,
    /// Logical CPUs. Published so the panel can put a session's share back into
    /// core-equivalents ("18% — 2.2 cores"), which is the number that actually
    /// tells you whether an agent is saturating something.
    pub cpu_count: u32,
    pub mem_used_bytes: u64,
    pub mem_total_bytes: u64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionResources {
    /// Backend pty session id — the join key to the frontend's session list.
    pub session_id: u32,
    pub pid: Option<u32>,
    /// The session tree's CPU load as a share of the WHOLE machine, 0–100 —
    /// the same scale as [`SystemResources::cpu_percent`], so a row and the
    /// titlebar chip can be read against each other. See [`sum_tree`] for why
    /// this is not what sysinfo hands us.
    pub cpu_percent: Option<f32>,
    /// RAM held by the session tree. See [`process_memory`] for which of the
    /// several things an OS calls "memory" this is.
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

/// Per-process RAM, in the form that answers "what is this agent costing me".
///
/// The platforms disagree about what "memory" means and sysinfo passes that
/// disagreement straight through, so this picks per platform rather than
/// letting one call mean two things:
///
/// * **Windows — `virtual_memory()`, which here is `PROCESS_MEMORY_COUNTERS_EX
///   ::PrivateUsage`: private commit, the same number Task Manager's "Commit
///   size" column shows.** `memory()` is `WorkingSetSize`, and that is wrong
///   for this panel twice over. Working sets *include shared pages*, so summing
///   a tree counts the same physical memory once per process in it. And working
///   set is only what is resident right now: an idle agent that has been paged
///   out reads as almost nothing, which is exactly the trap recorded in
///   `.spacron/memory/orphaned-agent-processes.md` — orphaned Codex trees
///   looked like ~0 MB while very much still costing the machine.
/// * **Everywhere else — `memory()` (RSS).** `virtual_memory()` on Linux and
///   macOS is the *virtual address space*, tens of gigabytes for an idle
///   process, and using it there would be far more wrong than what it fixes on
///   Windows.
fn process_memory(process: &Process) -> u64 {
    #[cfg(windows)]
    {
        process.virtual_memory()
    }
    #[cfg(not(windows))]
    {
        process.memory()
    }
}

/// Sum CPU + RAM + process count over a process tree rooted at `pid` (the
/// process itself plus every descendant). The session's PTY child is the
/// *shell*; the agent runs inside it as a child, so measuring only the shell
/// would read ~0% for the exact sessions the monitor exists for. A children
/// map built from `Process::parent()` lets one pass sum the whole subtree.
///
/// **The CPU figure returned here is on sysinfo's per-core scale, NOT 0–100.**
/// `Process::cpu_usage()` ends in `* nb_cpus` on every platform — its own docs
/// say "it might be bigger than 100 if run on a multi-core machine" — so a
/// process saturating one core of a 12-thread box reads 100, not 8.3. The
/// caller divides by the CPU count before this leaves the backend; nothing
/// downstream should ever see this scale, because `System::global_cpu_usage()`
/// (the titlebar chip) is a plain 0–100 average and the two were being rendered
/// with the same bars and the same warn/critical thresholds.
fn sum_tree(pid: u32, sys: &System, children: &HashMap<u32, Vec<u32>>) -> (f32, u64, u32) {
    let mut cpu = 0.0f32;
    let mut mem = 0u64;
    let mut process_count = 0u32;
    let mut stack = vec![pid];
    // Windows recycles PIDs, and a recycled pid whose recorded parent is one of
    // its own descendants closes a loop in the children map. Without this the
    // walk below never terminates — and it holds the sampler mutex while it
    // spins, so the whole monitor wedges rather than just reading wrong.
    let mut visited: HashSet<u32> = HashSet::new();
    while let Some(current) = stack.pop() {
        if !visited.insert(current) {
            continue;
        }
        if let Some(process) = sys.process(Pid::from_u32(current)) {
            cpu += process.cpu_usage();
            mem += process_memory(process);
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

    // The divisor that puts per-process CPU back on the machine's 0–100 scale
    // (see `sum_tree`). `max(1)` because dividing by a CPU list that somehow
    // came back empty would produce infinities, not a smaller bug.
    let cpu_count = sys.cpus().len().max(1) as u32;

    let system = SystemResources {
        cpu_percent: if warmed { Some(sys.global_cpu_usage()) } else { None },
        cpu_count,
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
                    // Per-core → share of the machine. This is the only place
                    // the conversion happens, so every consumer (row label,
                    // mini bar, severity tint, the project watchdog) is on the
                    // chip's scale by construction.
                    if warmed {
                        Some(tree_cpu / cpu_count as f32)
                    } else {
                        None
                    },
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
