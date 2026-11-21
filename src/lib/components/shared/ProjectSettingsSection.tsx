import { useState, useEffect, useMemo, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { backendInvoke } from '$lib/services/backend';
import { useStore } from '$lib/react/useStore';
import { get } from '$lib/stores/storeCompat';
import {
  projects,
  activeProjectId,
  activeProject,
  activeWorkspaceId,
  isProjectSwitching,
  recentWorkspaces,
  removeProjectFromCollection,
  deleteCollection,
  switchToProject,
  openWorkspace,
  openProjectByPath,
} from '$lib/stores/workspace';
import type { Project } from '$lib/types/workspace';
import {
  getProjectConfig,
  updateProjectConfigFor,
  projectConfigFor,
  isProjectHidden,
  allProjectSettings,
  isImageUrl,
  detectProjectIcon,
  projectIconFor,
  setProjectIcon,
  type ProjectConfig,
  type ProjectCleanupRule,
} from '$lib/stores/projectSettings';
import { globalWorkspaceCleanupRule } from '$lib/stores/settings';
import { syncProjectHooksToSnippets } from '$lib/stores/snippets';
import { ensureAgentRulesFiles } from '$lib/services/orchestrator/agent-rules-file';
import { createTerminalSession, sendPromptToSession, setActiveSession } from '$lib/stores/terminal';
import { useLayoutStore } from '$lib/stores/zustand/layout';
import { setInteractionMode } from '$lib/stores/interactionMode';
import { showToast } from '$lib/stores/notification';
import {
  getWorktreeBases,
  listProjectWorktrees,
  deleteProjectWorktree,
  type WorktreeBases,
} from '$lib/services/project-worktrees';
import { refreshProjectWorktrees } from '$lib/stores/projectWorktrees';
import { cleanupStaleWorktrees, sweepAgentBranchesForProject, sweepOrphanWorktrees } from '$lib/stores/orchestrator';
import { pruneWorktrees } from '$lib/services/orchestrator/worktree-manager';
import { openFile } from '$lib/stores/editor';
import { HIDDEN_PROJECTS_KEY, loadPathSet, normalizeProjectPath } from '$lib/components/workspace/projectListPrefs';
import Dropdown, { type DropdownOption } from './Dropdown';
import SettingsDetailsToggle from './SettingsDetailsToggle';
import {
  PROJECT_SVG_ICONS,
  PROJECT_EMOJIS,
  ProjectSvgIcon,
  ProjectIconBadge,
  isProjectSvgIcon,
} from './ProjectIcons';
import './ProjectSettingsSection.css';

function GithubBrandIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
      />
    </svg>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string | React.ReactNode;
  subtitle?: string | React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="settings-card">
      <div className="settings-card-header">
        <h3>{title}</h3>
        {subtitle && <p className="settings-card-subtitle">{subtitle}</p>}
      </div>
      <div className="settings-card-body">{children}</div>
    </section>
  );
}

function SettingRow({
  title,
  detail,
  children,
  alignTop,
}: {
  title: string | React.ReactNode;
  detail?: string | React.ReactNode;
  children: React.ReactNode;
  alignTop?: boolean;
}) {
  return (
    <div className="settings-control-row" style={alignTop ? { alignItems: 'flex-start' } : undefined}>
      <div className="settings-control-copy">
        <span>{title}</span>
        {detail && <small>{detail}</small>}
      </div>
      <div className="settings-control">{children}</div>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`settings-toggle${checked ? ' active' : ''}`}
      disabled={disabled}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
    >
      <span className="settings-toggle-thumb" />
    </button>
  );
}

interface DetectedMcpServer {
  name: string;
  transport: 'HTTP' | 'STDIO' | 'SSE';
  target: string;
  status: 'enabled' | 'disabled';
}

interface DetectedMcpFile {
  relPath: string;
  fullPath: string;
  label: string;
  servers: DetectedMcpServer[];
}

interface ProjectMcpScanResult {
  detected: DetectedMcpFile[];
  checked: string[];
  totalServers: number;
}

async function scanProjectMcpConfigs(rootPath: string): Promise<ProjectMcpScanResult> {
  const normalizedRoot = rootPath.replace(/\\/g, '/').replace(/\/+$/, '');
  const candidateFiles = [
    { rel: '.mcp.json', label: 'Workspace .mcp.json' },
    { rel: '.cursor/mcp.json', label: 'Cursor .cursor/mcp.json' },
    { rel: '.claude.json', label: 'Claude .claude.json' },
    { rel: '.claude/mcp.json', label: 'Claude .claude/mcp.json' },
  ];

  const detected: DetectedMcpFile[] = [];
  const checked: string[] = [];

  for (const item of candidateFiles) {
    const fullPath = `${normalizedRoot}/${item.rel}`;
    try {
      const text = await backendInvoke<string>('fs_read_file', { path: fullPath });
      if (text && text.trim()) {
        const parsed = JSON.parse(text);
        const rawServers = parsed.mcpServers || parsed.servers || {};
        const servers: DetectedMcpServer[] = [];

        for (const [name, sDef] of Object.entries(rawServers)) {
          if (!sDef || typeof sDef !== 'object') continue;
          const s = sDef as { url?: string; command?: string; type?: string; disabled?: boolean };
          const url = typeof s.url === 'string' ? s.url : '';
          const cmd = typeof s.command === 'string' ? s.command : '';
          const type = (s.type || '').toLowerCase();
          const transport: 'HTTP' | 'STDIO' | 'SSE' = url ? (url.includes('sse') || type === 'sse' ? 'HTTP' : 'HTTP') : 'STDIO';
          let target = cmd || 'configured';
          if (url) {
            try {
              const endpoint = new URL(url);
              target = endpoint.protocol === 'http:' || endpoint.protocol === 'https:'
                ? endpoint.origin + endpoint.pathname
                : 'Configured URL';
            } catch {
              target = 'Configured URL';
            }
          }
          const status = s.disabled === true ? 'disabled' : 'enabled';
          servers.push({
            name,
            transport,
            target,
            status,
          });
        }

        detected.push({
          relPath: item.rel,
          fullPath,
          label: item.label,
          servers,
        });
      } else {
        checked.push(item.rel);
      }
    } catch {
      checked.push(item.rel);
    }
  }

  const totalServers = detected.reduce((sum, d) => sum + d.servers.length, 0);
  return { detected, checked, totalServers };
}

interface ProjectSettingsSectionProps {
  selectedProjectId?: string | null;
  onSelectProject?: (id: string) => void;
  onCloseSettings: () => void;
}

export default function ProjectSettingsSection({
  selectedProjectId,
  onSelectProject,
  onCloseSettings,
}: ProjectSettingsSectionProps) {
  const allProjectsMap = useStore(projects);
  const currentActiveId = useStore(activeProjectId);
  const currentProject = useStore(activeProject);
  const activeWsId = useStore(activeWorkspaceId);
  const allConfigs = useStore(allProjectSettings);
  const rawWorkspaces = useStore(recentWorkspaces);
  const globalRule = useStore(globalWorkspaceCleanupRule);

  // Compile full list of open/known projects across the loaded map and recent workspaces
  const projectList = useMemo(() => {
    const list: Project[] = Array.from(allProjectsMap.values());
    const seenPaths = new Set(list.map((p) => normalizeProjectPath(p.root_path)));

    for (const ws of rawWorkspaces) {
      const candidatePaths = [
        ...(ws.project_paths || []),
        ...(ws.active_project_path ? [ws.active_project_path] : []),
      ];
      for (const pPath of candidatePaths) {
        if (!pPath) continue;
        const norm = normalizeProjectPath(pPath);
        if (!seenPaths.has(norm)) {
          seenPaths.add(norm);
          const name = pPath.replace(/\\/g, '/').split('/').filter(Boolean).pop() || pPath;
          list.push({
            id: pPath,
            name,
            root_path: pPath,
            state: { open_files: [], active_file: null, last_modified: '' },
          });
        }
      }
    }
    return list;
  }, [allProjectsMap, rawWorkspaces]);

  // Internal selection state to support in-panel clicks
  const [internalSelectedId, setInternalSelectedId] = useState<string>(selectedProjectId || '');

  useEffect(() => {
    if (selectedProjectId) {
      setInternalSelectedId(selectedProjectId);
    }
  }, [selectedProjectId]);

  const effectiveSelectedId = internalSelectedId || selectedProjectId || currentActiveId || '';

  const targetProject: Project | undefined = useMemo(() => {
    if (effectiveSelectedId) {
      const match = projectList.find(
        (p) =>
          p.id === effectiveSelectedId ||
          normalizeProjectPath(p.root_path) === normalizeProjectPath(effectiveSelectedId)
      );
      if (match) return match;
    }
    if (currentActiveId) {
      const match = projectList.find(
        (p) =>
          p.id === currentActiveId ||
          normalizeProjectPath(p.root_path) === normalizeProjectPath(currentActiveId)
      );
      if (match) return match;
    }
    return projectList[0] || currentProject || undefined;
  }, [effectiveSelectedId, currentActiveId, projectList, currentProject]);

  const config: ProjectConfig = useMemo(() => {
    if (!targetProject) {
      return getProjectConfig('__default__');
    }
    return projectConfigFor(allConfigs, targetProject.root_path, targetProject.id);
  }, [targetProject, allConfigs]);

  const [detectingIcon, setDetectingIcon] = useState(false);
  const [fetchingGithubIcon, setFetchingGithubIcon] = useState(false);
  const [iconSubTab, setIconSubTab] = useState<'avatar' | 'icon' | 'emoji'>('icon');
  const icon = targetProject ? projectIconFor(allConfigs, targetProject.root_path, targetProject.id) : config.icon;
  const [avatarDraft, setAvatarDraft] = useState('');
  useEffect(() => {
    setAvatarDraft(isImageUrl(icon) ? icon : '');
  }, [targetProject?.id, icon]);

  // Worktree bases & search state
  const [bases, setBases] = useState<WorktreeBases | null>(null);
  const [branchSearch, setBranchSearch] = useState('');
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const branchPickerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!branchMenuOpen) return;
    const dismiss = (event: PointerEvent) => {
      if (!branchPickerRef.current?.contains(event.target as Node)) {
        setBranchMenuOpen(false);
        setBranchSearch('');
      }
    };
    document.addEventListener('pointerdown', dismiss, true);
    return () => document.removeEventListener('pointerdown', dismiss, true);
  }, [branchMenuOpen]);
  const [cleaningWorktrees, setCleaningWorktrees] = useState(false);

  // MCP inspection state
  const [mcpScan, setMcpScan] = useState<ProjectMcpScanResult | null>(null);
  const [mcpScanning, setMcpScanning] = useState(false);
  const [mcpDetailsOpen, setMcpDetailsOpen] = useState(false);
  const mcpRequest = useRef(0);

  // Load worktree bases
  useEffect(() => {
    setBranchMenuOpen(false);
    setBranchSearch('');
    setBases(null);
    if (!targetProject) return;
    let cancelled = false;
    getWorktreeBases(targetProject.id)
      .then((nextBases) => {
        if (!cancelled) setBases(nextBases);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [targetProject?.id]);

  // Scan MCP configs
  const scanMcp = async () => {
    if (!targetProject) return;
    const request = ++mcpRequest.current;
    setMcpScanning(true);
    try {
      const res = await scanProjectMcpConfigs(targetProject.root_path);
      if (request === mcpRequest.current) setMcpScan(res);
    } catch {
      if (request === mcpRequest.current) setMcpScan(null);
    } finally {
      if (request === mcpRequest.current) setMcpScanning(false);
    }
  };

  useEffect(() => {
    setMcpScan(null);
    void scanMcp();
    return () => { mcpRequest.current++; };
  }, [targetProject?.root_path]);

  const projectOptions: DropdownOption[] = projectList.map((p) => ({
    value: p.id,
    label: p.name,
  }));

  const handleSelectProject = (newId: string) => {
    const selection = projectList.find((project) => project.id === newId)?.root_path ?? newId;
    setInternalSelectedId(selection);
    onSelectProject?.(selection);
  };

  // Switch the active workspace project in Spacron
  const handleActivateProject = async (p: Project, notify = true) => {
    try {
      const norm = normalizeProjectPath(p.root_path);
      // 1. Check if it's already active in the current workspace
      if (
        (currentActiveId && currentActiveId === p.id) ||
        (currentProject && normalizeProjectPath(currentProject.root_path) === norm)
      ) {
        if (notify) showToast(`"${p.name}" is already the active project`, 'info');
        return;
      }

      // 2. Check if it is in the active workspace's live projects map
      const inCurrentWs = Array.from(allProjectsMap.values()).find(
        (proj) => normalizeProjectPath(proj.root_path) === norm || proj.id === p.id
      );
      if (inCurrentWs) {
        switchToProject(inCurrentWs.id);
        if (notify) showToast(`Switched active project to ${p.name}`, 'info');
        return;
      }

      // 3. Check if it is part of a workspace in recentWorkspaces
      const ws = rawWorkspaces.find((w) =>
        (w.project_paths || []).some((path) => normalizeProjectPath(path) === norm) ||
        (w.active_project_path && normalizeProjectPath(w.active_project_path) === norm)
      );
      if (ws) {
        recentWorkspaces.update((list) =>
          list.map((w) => (w.id === ws.id ? { ...w, active_project_path: p.root_path } : w))
        );
        await openWorkspace(ws.id);
        if (notify) showToast(`Switched workspace to ${p.name}`, 'info');
        return;
      }

      // 4. Fallback open by path
      await openProjectByPath(p.root_path);
      if (notify) showToast(`Opened project ${p.name}`, 'info');
    } catch (err) {
      showToast(`Could not switch project: ${String(err)}`, 'warning');
    }
  };

  const handleRunScript = async (scriptCommand: string, label: string) => {
    if (!targetProject || !scriptCommand.trim()) return;
    const rootPath = targetProject.root_path;
    await handleActivateProject(targetProject, false);
    if (get(isProjectSwitching)) {
      await new Promise<void>((resolve) => {
        const unsubscribe = isProjectSwitching.subscribe((switching) => {
          if (!switching) {
            unsubscribe();
            resolve();
          }
        });
      });
    }
    const owner = get(activeProject);
    if (!owner || normalizeProjectPath(owner.root_path) !== normalizeProjectPath(rootPath)) return;
    const sessionId = await createTerminalSession(owner.root_path, undefined, owner.id);
    if (sessionId === null) {
      showToast(`Could not open a terminal for ${owner.name}.`, 'warning');
      return;
    }
    setInteractionMode('cli');
    setActiveSession(sessionId);
    useLayoutStore.getState().closeSettings();
    useLayoutStore.getState().showTerminal();
    sendPromptToSession(sessionId, scriptCommand);
    showToast(`Running ${label} in ${owner.name}.`, 'info');
  };

  const saveConfig = (patch: Partial<ProjectConfig>) => {
    if (!targetProject) return;
    updateProjectConfigFor(targetProject.root_path, patch);
  };

  const saveIcon = (nextIcon: string) => {
    if (targetProject) setProjectIcon(targetProject.id, targetProject.root_path, nextIcon);
  };

  const iconIsCurrent = () => targetProject
    && projectIconFor(get(allProjectSettings), targetProject.root_path, targetProject.id) === icon;

  const handleHookChange = (key: keyof ProjectConfig['hooks'], value: string) => {
    if (!targetProject) return;
    updateProjectConfigFor(targetProject.root_path, { hooks: { [key]: value } });
    if (allProjectsMap.has(targetProject.id)) {
      const { hooks } = projectConfigFor(get(allProjectSettings), targetProject.root_path, targetProject.id);
      syncProjectHooksToSnippets(targetProject.id, hooks, targetProject.root_path);
    }
  };

  const handleDetectProjectIcon = async () => {
    if (!targetProject) return;
    setDetectingIcon(true);
    try {
      const detected = await detectProjectIcon(targetProject.root_path, targetProject.id);
      if (!iconIsCurrent()) return;
      saveIcon(detected);
      showToast(isImageUrl(detected) ? 'Detected project icon file' : `Detected project framework icon: ${detected}`, 'info');
    } catch {
      showToast('Could not scan project directory', 'warning');
    } finally {
      setDetectingIcon(false);
    }
  };

  const handleUseGithubIcon = async () => {
    if (!targetProject) return;
    setFetchingGithubIcon(true);
    try {
      let owner = '';
      try {
        const res = await backendInvoke<{ github_owner?: string | null }>('project_inspect_any', {
          path: targetProject.root_path,
        });
        if (res?.github_owner) {
          owner = res.github_owner;
        }
      } catch {
        // Fallback to source_control_repo_info
      }

      if (!owner) {
        try {
          const info = await invoke<{ provider: string; owner: string; repo: string }>('source_control_repo_info', {
            projectId: targetProject.id,
            repoPath: targetProject.root_path,
          });
          if (info && info.owner) {
            owner = info.owner;
          }
        } catch {
          // Fallback: read .git/config
          try {
            const configContent = await backendInvoke<string>('fs_read_file', {
              path: `${targetProject.root_path.replace(/\\/g, '/')}/.git/config`,
            });
            const match = configContent.match(/github\.com[:/]([^/\s]+)\/([^/\s.]+)/i);
            if (match && match[1]) {
              owner = match[1];
            }
          } catch {
            // ignore
          }
        }
      }

      if (owner) {
        const avatarUrl = `https://github.com/${owner}.png?size=64`;
        if (!iconIsCurrent()) return;
        saveIcon(avatarUrl);
        showToast(`Using GitHub avatar for @${owner}`, 'info');
        return;
      }
      showToast('No GitHub remote found for this project', 'warning');
    } catch {
      showToast('Could not inspect GitHub repository remote', 'warning');
    } finally {
      setFetchingGithubIcon(false);
    }
  };

  // Worktree base computations
  const primaryBranch = bases?.default_base || 'origin/main';
  const currentBaseBranch = config.worktreeBase || primaryBranch;

  const allBranches = useMemo(() => {
    if (!bases) return [];
    const list = [bases.default_base, ...(bases.refs || []), ...(bases.local || [])];
    return Array.from(new Set(list.filter(Boolean)));
  }, [bases]);

  const filteredBranches = useMemo(() => {
    const q = branchSearch.toLowerCase().trim();
    if (!q) return allBranches.slice(0, 8);
    return allBranches.filter((b) => b.toLowerCase().includes(q)).slice(0, 10);
  }, [allBranches, branchSearch]);

  // Cleanup detail text
  const globalLabel =
    globalRule === 'merged_only'
      ? 'Delete merged'
      : globalRule === 'never'
        ? 'Never delete'
        : 'Delete merged, Delete unchanged';

  const cleanupDetailText =
    config.cleanupRule === 'merged_unchanged'
      ? 'Delete merged, Delete unchanged'
      : config.cleanupRule === 'merged_only'
        ? 'Delete merged'
        : config.cleanupRule === 'never'
          ? 'Never delete'
          : `Using global: ${globalLabel}`;

  const handleCleanWorktreesNow = async () => {
    if (!targetProject) return;
    setCleaningWorktrees(true);
    try {
      const staleCount = await cleanupStaleWorktrees(targetProject.id);
      const orphanCount = await sweepOrphanWorktrees(targetProject.id);
      const totalBranches = await sweepAgentBranchesForProject(targetProject.id);
      await pruneWorktrees(targetProject.id);

      // Check project worktrees
      let missingCleaned = 0;
      try {
        const wts = await listProjectWorktrees(targetProject.id);
        for (const wt of wts) {
          if (!wt.is_main && wt.missing) {
            const del = await deleteProjectWorktree(targetProject.id, wt.path, true);
            if (del.ok) missingCleaned++;
          }
        }
      } catch {
        // ignore
      }

      void refreshProjectWorktrees(targetProject.id, targetProject.root_path);
      const totalWorktrees = staleCount + orphanCount + missingCleaned;
      showToast(
        `Cleanup complete: ${totalWorktrees} worktree(s) removed, ${totalBranches} branch(es) swept`,
        'info'
      );
    } catch (err) {
      showToast(`Worktree cleanup encountered an error: ${String(err)}`, 'warning');
    } finally {
      setCleaningWorktrees(false);
    }
  };

  const handleRemoveCurrentProject = async () => {
    if (!targetProject) return;
    const confirmed = window.confirm(
      `Remove "${targetProject.name}" from Spacron? Files stay on disk, so you can add it again later.`
    );
    if (!confirmed) return;

    try {
      const ws = rawWorkspaces.find((w) => (w.project_paths || []).includes(targetProject.root_path));
      if (ws) {
        if ((ws.project_paths || []).length > 1) {
          await removeProjectFromCollection(ws.id, targetProject.root_path);
        } else {
          await deleteCollection(ws.id);
        }
      }
      showToast(`Removed "${targetProject.name}" from Spacron`, 'info');
      const remaining = projectList.filter((p) => p.id !== targetProject.id);
      if (remaining.length > 0) {
        handleSelectProject(remaining[0].id);
        void handleActivateProject(remaining[0]);
      }
    } catch (err) {
      showToast(`Could not remove project: ${String(err)}`, 'warning');
    }
  };

  const isTargetProjectActive = Boolean(
    targetProject && (
      (currentActiveId && (targetProject.id === currentActiveId || normalizeProjectPath(targetProject.root_path) === normalizeProjectPath(currentActiveId))) ||
      (currentProject && normalizeProjectPath(targetProject.root_path) === normalizeProjectPath(currentProject.root_path))
    )
  );

  if (!targetProject && projectList.length === 0) {
    return (
      <Section title="Project">
        <div className="project-settings-empty">
          <div className="project-settings-empty-icon">📁</div>
          <p>No project is currently open. Open a folder or repository to configure its identity, worktrees, and lifecycle hooks.</p>
        </div>
      </Section>
    );
  }

  return (
    <>
      {/* Group 0: Open Projects In Workspace Card */}
      {projectList.length > 0 && (
        <Section
          title="Projects in workspace"
          subtitle="All projects currently open in Spacron. Click any project to inspect its settings or switch the active workspace to it."
        >
          <div className="project-items-card">
            {projectList.map((p) => {
              const pConf = projectConfigFor(allConfigs, p.root_path, p.id);
              const isViewing = targetProject && (
                targetProject.id === p.id ||
                normalizeProjectPath(targetProject.root_path) === normalizeProjectPath(p.root_path)
              );
              const isActive = (
                (currentActiveId && (p.id === currentActiveId || normalizeProjectPath(p.root_path) === normalizeProjectPath(currentActiveId))) ||
                (currentProject && normalizeProjectPath(p.root_path) === normalizeProjectPath(currentProject.root_path))
              );

              return (
                <div
                  key={p.id}
                  className={`project-workspace-item-row${isViewing ? ' viewing' : ''}${isActive ? ' active-project' : ''}`}
                  onClick={() => handleSelectProject(p.id)}
                >
                  <div className="project-workspace-item-left">
                    <div className="project-workspace-item-avatar">
                      <ProjectIconBadge icon={projectIconFor(allConfigs, p.root_path, p.id)} size={20} />
                    </div>
                    <div className="project-workspace-item-meta">
                      <div className="project-workspace-item-name-row">
                        <span className="project-workspace-item-name">{pConf.displayName || p.name}</span>
                        {isActive ? (
                          <span className="project-status-pill active" title="Active workspace project">
                            <span className="project-status-dot" />
                            Active
                          </span>
                        ) : isViewing ? (
                          <span className="project-status-pill viewing" title="Currently viewing settings">
                            Editing
                          </span>
                        ) : null}
                      </div>
                      <span className="project-workspace-item-path" title={p.root_path}>
                        {p.root_path}
                      </span>
                    </div>
                  </div>

                  <div className="project-workspace-item-actions" onClick={(e) => e.stopPropagation()}>
                    {!isActive ? (
                      <button
                        type="button"
                        className="project-action-btn project-activate-btn"
                        onClick={() => void handleActivateProject(p)}
                        title={`Switch active project to ${pConf.displayName || p.name}`}
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <polyline points="9 18 15 12 9 6" />
                        </svg>
                        Switch to project
                      </button>
                    ) : (
                      <span className="project-active-badge">Active in workspace</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </Section>
      )}

      {/* Group 1: Project Identity */}
      <Section title="Project identity">
        {!isTargetProjectActive && targetProject && (
          <div className="project-inactive-notice-bar">
            <div className="project-inactive-notice-left">
              <span className="project-inactive-indicator" />
              <span>
                Configuring <strong>{config.displayName || targetProject.name}</strong> (currently inactive)
              </span>
            </div>
            <button
              type="button"
              className="project-action-btn project-activate-btn"
              onClick={() => void handleActivateProject(targetProject)}
            >
              Switch workspace to this project
            </button>
          </div>
        )}

        {projectList.length > 1 && (
          <SettingRow
            title="Configured project"
            detail="Switch which open project's settings are currently being edited"
          >
            <Dropdown
              options={projectOptions}
              value={targetProject?.id || effectiveSelectedId}
              onChange={handleSelectProject}
              ariaLabel="Select project"
            />
          </SettingRow>
        )}

        <SettingRow
          title="Display name"
          detail="Name shown in tab headers, status bar, and sidebar"
        >
          <input
            type="text"
            className="settings-input"
            placeholder={targetProject?.name || 'Project Name'}
            value={config.displayName}
            onChange={(e) => {
              if (targetProject) {
                saveConfig({ displayName: e.target.value });
              }
            }}
          />
        </SettingRow>

        <SettingRow
          title="Project icon"
          detail="Choose an SVG icon, emoji, or project avatar"
          alignTop
        >
          <div className="project-icon-picker-layout">
            <div className="project-icon-preview" title="Current project icon">
              <ProjectIconBadge icon={icon} size={28} />
            </div>

            <div className="project-icon-controls">
              <div className="project-icon-subtabs" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={iconSubTab === 'avatar'}
                  className={`project-icon-subtab ${iconSubTab === 'avatar' ? 'active' : ''}`}
                  onClick={() => setIconSubTab('avatar')}
                >
                  Avatar
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={iconSubTab === 'icon'}
                  className={`project-icon-subtab ${iconSubTab === 'icon' ? 'active' : ''}`}
                  onClick={() => setIconSubTab('icon')}
                >
                  Icon
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={iconSubTab === 'emoji'}
                  className={`project-icon-subtab ${iconSubTab === 'emoji' ? 'active' : ''}`}
                  onClick={() => setIconSubTab('emoji')}
                >
                  Emoji
                </button>
              </div>

              {iconSubTab === 'avatar' && (
                <div className="project-icon-tab-content">
                  <div className="project-icon-actions">
                    <button
                      type="button"
                      className="project-action-btn"
                      onClick={() => void handleDetectProjectIcon()}
                      disabled={detectingIcon}
                      title="Detect icon or framework from project files"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <circle cx="11" cy="11" r="8" />
                        <line x1="21" y1="21" x2="16.65" y2="16.65" />
                      </svg>
                      {detectingIcon ? 'Detecting…' : 'Detect from project'}
                    </button>

                    <button
                      type="button"
                      className="project-action-btn"
                      onClick={() => void handleUseGithubIcon()}
                      disabled={fetchingGithubIcon}
                      title="Use GitHub owner's avatar"
                    >
                      <GithubBrandIcon />
                      {fetchingGithubIcon ? 'Checking…' : 'Use GitHub icon'}
                    </button>
                  </div>
                  <div className="project-icon-custom-row">
                    <input
                      type="text"
                      className="settings-input project-icon-custom-input"
                      placeholder="Or paste image URL (https://…)"
                      value={avatarDraft}
                      onChange={(e) => setAvatarDraft(e.target.value)}
                      onBlur={() => {
                        const nextIcon = avatarDraft.trim();
                        if (isImageUrl(nextIcon) || (!nextIcon && isImageUrl(icon))) {
                          saveIcon(nextIcon);
                        }
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') event.currentTarget.blur();
                      }}
                    />
                  </div>
                </div>
              )}

              {iconSubTab === 'icon' && (
                <div className="project-icon-tab-content">
                  <div className="project-svg-grid">
                    {PROJECT_SVG_ICONS.map((svgDef) => {
                      const isActive = (icon || 'icon:folder') === svgDef.id;
                      return (
                        <button
                          key={svgDef.id}
                          type="button"
                          className={`project-svg-btn ${isActive ? 'active' : ''}`}
                          onClick={() => saveIcon(svgDef.id)}
                          title={svgDef.name}
                        >
                          <ProjectSvgIcon name={svgDef.id} size={16} />
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {iconSubTab === 'emoji' && (
                <div className="project-icon-tab-content">
                  <div className="project-icon-palette">
                    {PROJECT_EMOJIS.map((emoji) => (
                      <button
                        key={emoji}
                        type="button"
                        className={`project-icon-btn${icon === emoji ? ' active' : ''}`}
                        onClick={() => saveIcon(emoji)}
                        title={`Set icon to ${emoji}`}
                      >
                        {emoji}
                      </button>
                    ))}
                  </div>
                  <div className="project-icon-custom-row">
                    <input
                      type="text"
                      className="settings-input project-icon-custom-input"
                      placeholder="Or type/paste any emoji..."
                      value={!isImageUrl(icon) && !isProjectSvgIcon(icon) ? icon : ''}
                      onChange={(e) => saveIcon(e.target.value)}
                    />
                  </div>
                </div>
              )}
            </div>
          </div>
        </SettingRow>

        <SettingRow
          title="Root directory"
          detail="Local file system location of this repository"
        >
          <div className="project-path-display">
            <span className="project-path-text">{targetProject?.root_path || 'No path configured'}</span>
            <button
              type="button"
              className="script-run-btn"
              onClick={() => {
                if (targetProject?.root_path) {
                  void navigator.clipboard.writeText(targetProject.root_path);
                  showToast('Path copied to clipboard', 'info');
                }
              }}
              title="Copy root path"
            >
              Copy
            </button>
          </div>
        </SettingRow>
      </Section>

      {/* Group 2: Lifecycle Scripts & Hooks */}
      <Section title="Lifecycle scripts & hooks">
        <SettingRow
          title="Setup / Install command"
          detail="Runs to bootstrap dependencies when opening or switching worktrees"
        >
          <div className="script-input-group">
            <input
              type="text"
              className="settings-input font-mono"
              placeholder="e.g. pnpm install or npm install"
              value={config.hooks.setup}
              onChange={(e) => handleHookChange('setup', e.target.value)}
            />
            {config.hooks.setup && (
              <button
                type="button"
                className="script-run-btn"
                onClick={() => handleRunScript(config.hooks.setup, 'Setup')}
              >
                Run
              </button>
            )}
          </div>
        </SettingRow>

        <SettingRow
          title="Dev / Start command"
          detail="Local development server command"
        >
          <div className="script-input-group">
            <input
              type="text"
              className="settings-input font-mono"
              placeholder="e.g. pnpm dev or npm start"
              value={config.hooks.dev}
              onChange={(e) => handleHookChange('dev', e.target.value)}
            />
            {config.hooks.dev && (
              <button
                type="button"
                className="script-run-btn"
                onClick={() => handleRunScript(config.hooks.dev, 'Dev')}
              >
                Run
              </button>
            )}
          </div>
        </SettingRow>

        <SettingRow
          title="Build command"
          detail="Production build verification script"
        >
          <div className="script-input-group">
            <input
              type="text"
              className="settings-input font-mono"
              placeholder="e.g. pnpm build or cargo build"
              value={config.hooks.build}
              onChange={(e) => handleHookChange('build', e.target.value)}
            />
            {config.hooks.build && (
              <button
                type="button"
                className="script-run-btn"
                onClick={() => handleRunScript(config.hooks.build, 'Build')}
              >
                Run
              </button>
            )}
          </div>
        </SettingRow>

        <SettingRow
          title="Test command"
          detail="Test runner executed to verify agent work and pull requests"
        >
          <div className="script-input-group">
            <input
              type="text"
              className="settings-input font-mono"
              placeholder="e.g. pnpm test or cargo test"
              value={config.hooks.test}
              onChange={(e) => handleHookChange('test', e.target.value)}
            />
            {config.hooks.test && (
              <button
                type="button"
                className="script-run-btn"
                onClick={() => handleRunScript(config.hooks.test, 'Test')}
              >
                Run
              </button>
            )}
          </div>
        </SettingRow>

        <SettingRow
          title="Clean command"
          detail="Clean build caches, node_modules, or target directory"
        >
          <div className="script-input-group">
            <input
              type="text"
              className="settings-input font-mono"
              placeholder="e.g. git clean -dfX or pnpm clean"
              value={config.hooks.clean}
              onChange={(e) => handleHookChange('clean', e.target.value)}
            />
            {config.hooks.clean && (
              <button
                type="button"
                className="script-run-btn"
                onClick={() => handleRunScript(config.hooks.clean, 'Clean')}
              >
                Run
              </button>
            )}
          </div>
        </SettingRow>
      </Section>

      {/* Group 3: Project Agent Instructions */}
      <Section title="Project agent instructions">
        <SettingRow
          title="Custom guidelines"
          detail="Specific architectural guidelines, testing conventions, or rules for agents working in this repository"
          alignTop
        >
          <textarea
            className="settings-textarea font-mono project-instructions-textarea"
            rows={8}
            placeholder="e.g. Always write unit tests before finishing tasks. Follow clean architecture. Use TypeScript strict mode. Never modify generated files."
            value={config.customInstructions}
            onChange={(e) => {
              if (targetProject) {
                const val = e.target.value;
                saveConfig({ customInstructions: val });
              }
            }}
            onBlur={() => {
              if (targetProject && allProjectsMap.has(targetProject.id)) {
                const { customInstructions } = projectConfigFor(get(allProjectSettings), targetProject.root_path, targetProject.id);
                void ensureAgentRulesFiles(targetProject.root_path, null, { customInstructions });
              }
            }}
          />
        </SettingRow>
      </Section>

      {/* Group 4: Default worktree base (Orca style) */}
      <Section title="Default worktree base">
        <div className="worktree-base-row">
          <div className="worktree-base-info">
            <span className="worktree-base-name">{currentBaseBranch}</span>
            <small className="worktree-base-desc">
              {config.worktreeBase
                ? `Custom base: ${config.worktreeBase}`
                : `Following primary branch (${primaryBranch})`}
            </small>
          </div>
          <button
            type="button"
            className="settings-secondary"
            onClick={() => {
              if (targetProject) {
                saveConfig({ worktreeBase: '' });
                showToast(`Using primary branch (${primaryBranch}) as worktree base`, 'info');
              }
            }}
            disabled={!config.worktreeBase}
          >
            Use Primary
          </button>
        </div>

        <div
          className="worktree-branch-search-container"
          ref={branchPickerRef}
          onBlur={(event) => {
            if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) {
              setBranchMenuOpen(false);
              setBranchSearch('');
            }
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Escape' || !branchMenuOpen) return;
            event.preventDefault();
            event.stopPropagation();
            branchPickerRef.current?.querySelector('input')?.focus();
            setBranchMenuOpen(false);
            setBranchSearch('');
          }}
        >
          <div className="worktree-branch-search-box">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="worktree-search-icon" aria-hidden="true">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              className="settings-input worktree-branch-search-input"
              placeholder="Search branches by name..."
              value={branchSearch}
              onFocus={() => setBranchMenuOpen(true)}
              onClick={() => setBranchMenuOpen(true)}
              onChange={(e) => {
                setBranchSearch(e.target.value);
                setBranchMenuOpen(true);
              }}
            />
          </div>
          {branchMenuOpen && filteredBranches.length > 0 && (
            <div className="worktree-branch-dropdown" role="listbox" aria-label="Worktree base branches">
              {filteredBranches.map((branch) => {
                const isSelected = branch === currentBaseBranch;
                return (
                  <button
                    key={branch}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    className={`worktree-branch-dropdown-item${isSelected ? ' selected' : ''}`}
                    onClick={() => {
                      if (targetProject) {
                        saveConfig({ worktreeBase: branch });
                        setBranchSearch('');
                        setBranchMenuOpen(false);
                        showToast(`Worktree base set to ${branch}`, 'info');
                      }
                    }}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <line x1="6" y1="3" x2="6" y2="15" />
                      <circle cx="18" cy="6" r="3" />
                      <circle cx="6" cy="18" r="3" />
                      <path d="M18 9a9 9 0 0 1-9 9" />
                    </svg>
                    <span>{branch}</span>
                    {isSelected && <span className="branch-selected-badge">Active</span>}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </Section>

      {/* Group 5: Worktree location (Orca style) */}
      <Section title="Worktree location">
        <div className="worktree-location-container">
          <input
            type="text"
            className="settings-input worktree-location-input"
            value={targetProject ? `${targetProject.root_path}/.spacron/trees` : ''}
            readOnly
          />
          <small className="worktree-location-desc">Spacron manages project worktrees inside this folder.</small>
        </div>
      </Section>

      {/* Group 6: Workspace cleanup (Orca style) */}
      <Section
        title="Workspace cleanup"
        subtitle={`Rules for ${targetProject?.name || 'this project'} only. Use global follows Settings / Workspace Cleanup.`}
      >
        <SettingRow
          title="Cleanup rules"
          detail={cleanupDetailText}
        >
          <Dropdown
            options={[
              { value: 'global', label: 'Use global' },
              { value: 'merged_unchanged', label: 'Delete merged, Delete unchanged' },
              { value: 'merged_only', label: 'Delete merged' },
              { value: 'never', label: 'Never delete' },
            ]}
            value={config.cleanupRule || 'global'}
            onChange={(val) => {
              if (targetProject) {
                saveConfig({ cleanupRule: val as ProjectCleanupRule });
              }
            }}
            ariaLabel="Cleanup rules"
          />
        </SettingRow>

        <SettingRow
          title="Clean up stale worktrees"
          detail="Prune merged, dead and unchanged worktrees and sweep empty agent branches."
        >
          <button
            type="button"
            className="settings-secondary"
            onClick={() => void handleCleanWorktreesNow()}
            disabled={cleaningWorktrees}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ marginRight: '6px' }}>
              <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
            {cleaningWorktrees ? 'Cleaning…' : 'Clean now'}
          </button>
        </SettingRow>
      </Section>

      {/* Group 7: MCP configs (Orca style) */}
      <Section
        title="MCP configs"
        subtitle="Inspect MCP server definitions that agents can use while working in this repo."
      >
        <div className="mcp-card-inner">
          <div className="mcp-scan-top-bar">
            <span className="mcp-scan-summary-text">
              {mcpScan ? `${mcpScan.detected.length} config files · ${mcpScan.totalServers} server entries` : 'Scanning repo MCP definitions…'}
            </span>
            <div className="mcp-file-actions">
              <SettingsDetailsToggle expanded={mcpDetailsOpen} controls="project-mcp-details" onToggle={() => setMcpDetailsOpen((open) => !open)} />
              <button
                type="button"
                className="section-refresh-btn"
                onClick={() => void scanMcp()}
                disabled={mcpScanning}
                title="Refresh MCP configs"
                aria-label="Refresh MCP configs"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={mcpScanning ? 'spinning' : ''} aria-hidden="true">
                  <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
                </svg>
              </button>
            </div>
          </div>

          <div id="project-mcp-details" className="mcp-configs-list" hidden={!mcpDetailsOpen}>
            {mcpScan && mcpScan.detected.length > 0 ? (
              mcpScan.detected.map((file) => (
                <div key={file.relPath} className="mcp-file-block">
                  <div className="mcp-file-header">
                    <div className="mcp-file-title-group">
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mcp-check-icon" aria-hidden="true">
                        <circle cx="12" cy="12" r="10" />
                        <path d="m9 12 2 2 4-4" />
                      </svg>
                      <span className="mcp-file-label">{file.label}</span>
                    </div>
                    <div className="mcp-file-actions">
                      <span className="mcp-badge count">{file.servers.length} servers</span>
                      <button
                        type="button"
                        className="mcp-open-btn"
                        onClick={async () => {
                          if (await openFile(file.fullPath)) onCloseSettings();
                        }}
                      >
                        Open
                      </button>
                    </div>
                  </div>

                  <div className="mcp-server-list">
                    {file.servers.map((srv) => (
                      <div key={srv.name} className="mcp-server-item">
                        <div className="mcp-server-left">
                          <div className="mcp-server-name-row">
                            <span className="mcp-server-name">{srv.name}</span>
                            <span className={`mcp-badge transport ${srv.transport.toLowerCase()}`}>{srv.transport}</span>
                          </div>
                          <div className="mcp-server-target" title={srv.target}>{srv.target}</div>
                        </div>
                        <div className="mcp-server-status">
                          <span className={`mcp-status-pill ${srv.status}`}>{srv.status}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))
            ) : (
              <div className="mcp-empty-notice">No MCP configuration files detected in this repository.</div>
            )}

            {mcpScan && mcpScan.checked.length > 0 && (
              <div className="mcp-checked-section">
                <span className="mcp-checked-label">Checked</span>
                <div className="mcp-checked-tags">
                  {mcpScan.checked.map((tag) => (
                    <span key={tag} className="mcp-checked-tag">{tag}</span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </Section>

      {/* Group 8: Sidebar (Orca style) */}
      <Section title="Sidebar">
        <SettingRow
          title="Hide from sidebar"
          detail="Hides this project in the sidebar. Its terminals, agents and automations keep running."
        >
          <Toggle
            label="Hide from sidebar"
            checked={Boolean(targetProject && isProjectHidden(
              allConfigs, targetProject.root_path, targetProject.id,
              loadPathSet(HIDDEN_PROJECTS_KEY).has(normalizeProjectPath(targetProject.root_path)),
            ))}
            onChange={(checked) => {
              if (targetProject) {
                saveConfig({ hideFromSidebar: checked });
                showToast(
                  checked
                    ? `Hidden "${targetProject.name}" from sidebar`
                    : `Restored "${targetProject.name}" to sidebar`,
                  'info'
                );
              }
            }}
          />
        </SettingRow>
      </Section>

      {/* Group 9: Remove project (Orca style) */}
      <Section title="Remove project">
        <div className="remove-project-card">
          <div className="remove-project-info">
            <span className="remove-project-title">Remove this project from Spacron on all configured hosts.</span>
            <span className="remove-project-desc">Files stay on disk, so you can add it again later.</span>
            <span className="remove-project-sub">&gt; 1 host · 1 checkout</span>
          </div>
          <button
            type="button"
            className="settings-danger-btn"
            onClick={() => void handleRemoveCurrentProject()}
          >
            Remove…
          </button>
        </div>
      </Section>
    </>
  );
}
