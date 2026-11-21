/**
 * Per-project settings management, modeled after Orca's project / repository settings.
 *
 * Persists project-scoped settings (identity, lifecycle hooks/scripts, source control AI defaults,
 * and custom agent instructions) to local storage keyed by project id.
 */

import { writable, get } from '$lib/stores/storeCompat';
import { backendInvoke } from '$lib/services/backend';
import { normalizeProjectPath } from '$lib/utils/paths';

export interface ProjectHooks {
  setup: string;
  dev: string;
  build: string;
  test: string;
  lint: string;
  clean: string;
}

export interface ProjectSourceControlSettings {
  defaultCommitAgent: string;
  defaultCommitModel: string;
  commitAgent?: string;
  commitModel?: string;
  baseBranch: string;
  branchPrefix: string;
  autoCommitMessage: boolean;
}

export type ProjectCleanupRule = 'global' | 'merged_unchanged' | 'merged_only' | 'never';

export interface ProjectConfig {
  displayName: string;
  icon: string;
  accentColor: string;
  hooks: ProjectHooks;
  sourceControl: ProjectSourceControlSettings;
  customInstructions: string;
  worktreeBase: string;
  worktreeLocation: string;
  cleanupRule: ProjectCleanupRule;
  hideFromSidebar: boolean;
}

export const DEFAULT_PROJECT_HOOKS: ProjectHooks = {
  setup: '',
  dev: '',
  build: '',
  test: '',
  lint: '',
  clean: '',
};

export const DEFAULT_SOURCE_CONTROL_SETTINGS: ProjectSourceControlSettings = {
  defaultCommitAgent: 'codex',
  defaultCommitModel: '',
  baseBranch: 'main',
  branchPrefix: 'feature/',
  autoCommitMessage: true,
};

export const DEFAULT_PROJECT_CONFIG: ProjectConfig = {
  displayName: '',
  icon: 'icon:folder',
  accentColor: '',
  hooks: DEFAULT_PROJECT_HOOKS,
  sourceControl: DEFAULT_SOURCE_CONTROL_SETTINGS,
  customInstructions: '',
  worktreeBase: '',
  worktreeLocation: '',
  cleanupRule: 'global',
  hideFromSidebar: false,
};

const STORAGE_PREFIX = 'spacron_project_settings_v1_';
const OVERRIDE_PREFIX = 'spacron_project_overrides_v1_';
type ProjectConfigPatch = Partial<Omit<ProjectConfig, 'hooks' | 'sourceControl'>> & {
  hooks?: Partial<ProjectHooks>;
  sourceControl?: Partial<ProjectSourceControlSettings>;
};
const rootOverrides = new Map<string, ProjectConfigPatch>();

function loadStoredProjectConfig(projectId: string): ProjectConfig | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${projectId}`);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_PROJECT_CONFIG,
      ...parsed,
      hooks: { ...DEFAULT_PROJECT_HOOKS, ...(parsed.hooks || {}) },
      sourceControl: { ...DEFAULT_SOURCE_CONTROL_SETTINGS, ...(parsed.sourceControl || {}) },
      worktreeBase: parsed.worktreeBase || '',
      worktreeLocation: parsed.worktreeLocation || '',
      cleanupRule: parsed.cleanupRule || 'global',
      hideFromSidebar: Boolean(parsed.hideFromSidebar),
    };
  } catch {
    return undefined;
  }
}

function saveStoredProjectConfig(projectId: string, config: ProjectConfig): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(`${STORAGE_PREFIX}${projectId}`, JSON.stringify(config));
  } catch {
    // Storage quota or disabled
  }
}

function normalizeKey(p: string | null | undefined): string {
  return normalizeProjectPath(p ?? '');
}

export const allProjectSettings = writable<Record<string, ProjectConfig>>({});

function rootOverride(rootPath: string): ProjectConfigPatch {
  const key = normalizeKey(rootPath);
  if (!key) return {};
  const cached = rootOverrides.get(key);
  if (cached) return cached;
  try {
    const raw = localStorage.getItem(OVERRIDE_PREFIX + key);
    if (raw) {
      const patch = JSON.parse(raw) as ProjectConfigPatch;
      rootOverrides.set(key, patch);
      return patch;
    }
  } catch {
    // Keep working when storage is unavailable.
  }
  return {};
}

function storedConfig(settings: Record<string, ProjectConfig>, key?: string | null): ProjectConfig | undefined {
  if (!key) return undefined;
  const normalized = normalizeKey(key);
  return settings[normalized] ?? settings[key] ?? loadStoredProjectConfig(normalized) ?? loadStoredProjectConfig(key);
}

export function projectConfigFor(
  settings: Record<string, ProjectConfig>,
  rootPath: string,
  projectId?: string | null,
): ProjectConfig {
  const pathConfig = storedConfig(settings, rootPath);
  const base = storedConfig(settings, projectId) ?? pathConfig ?? DEFAULT_PROJECT_CONFIG;
  const patch = rootOverride(rootPath);
  return {
    ...base,
    ...patch,
    icon: patch.icon ?? pathConfig?.icon ?? base.icon,
    hooks: { ...base.hooks, ...patch.hooks },
    sourceControl: { ...base.sourceControl, ...patch.sourceControl },
  };
}

/** Keep explicit path-scoped edits separate from defaults synthesized for a recent project. */
export function updateProjectConfigFor(rootPath: string, patch: ProjectConfigPatch): void {
  const key = normalizeKey(rootPath);
  if (!key) return;
  const current = rootOverride(rootPath);
  const next = {
    ...current,
    ...patch,
    hooks: { ...current.hooks, ...patch.hooks },
    sourceControl: { ...current.sourceControl, ...patch.sourceControl },
  };
  rootOverrides.set(key, next);
  try {
    localStorage.setItem(OVERRIDE_PREFIX + key, JSON.stringify(next));
  } catch {
    // Keep the current session's settings.
  }
  allProjectSettings.update((settings) => ({ ...settings }));
}

/** An explicit sidebar choice wins over the old sidebar-only preference. */
export function isProjectHidden(
  settings: Record<string, ProjectConfig>,
  rootPath: string,
  projectId?: string | null,
  previouslyHidden = false,
): boolean {
  return rootOverride(rootPath).hideFromSidebar
    ?? (previouslyHidden || projectConfigFor(settings, rootPath, projectId).hideFromSidebar);
}

export function getProjectConfig(projectId: string): ProjectConfig {
  const norm = normalizeKey(projectId);
  const all = get(allProjectSettings);
  if (norm && all[norm]) return all[norm];
  if (all[projectId]) return all[projectId];
  const loaded = (norm ? loadStoredProjectConfig(norm) : undefined) ?? loadStoredProjectConfig(projectId);
  if (!loaded) return { ...DEFAULT_PROJECT_CONFIG };
  allProjectSettings.update((map) => ({ ...map, [projectId]: loaded, ...(norm ? { [norm]: loaded } : {}) }));
  return loaded;
}

/** A root path identifies the same project in recent and open workspaces. */
export function projectIconFor(
  settings: Record<string, ProjectConfig>,
  rootPath: string,
  projectId?: string | null,
): string {
  return rootOverride(rootPath).icon ?? storedConfig(settings, rootPath)?.icon
    ?? storedConfig(settings, projectId)?.icon ?? DEFAULT_PROJECT_CONFIG.icon;
}

export function setProjectIcon(projectId: string, rootPath: string, icon: string): void {
  if (rootPath) updateProjectConfigFor(rootPath, { icon: icon || DEFAULT_PROJECT_CONFIG.icon });
  else updateProjectConfig(projectId, { icon: icon || DEFAULT_PROJECT_CONFIG.icon });
}

export function updateProjectConfig(projectId: string, patch: Partial<ProjectConfig>): void {
  const current = getProjectConfig(projectId);
  const next: ProjectConfig = {
    ...current,
    ...patch,
    hooks: patch.hooks ? { ...current.hooks, ...patch.hooks } : current.hooks,
    sourceControl: patch.sourceControl ? { ...current.sourceControl, ...patch.sourceControl } : current.sourceControl,
  };
  saveStoredProjectConfig(projectId, next);
  const norm = normalizeKey(projectId);
  if (norm && norm !== projectId) {
    saveStoredProjectConfig(norm, next);
  }
  allProjectSettings.update((map) => ({
    ...map,
    [projectId]: next,
    ...(norm ? { [norm]: next } : {}),
  }));
}

export function isImageUrl(val: string | null | undefined): boolean {
  if (!val) return false;
  return (
    val.startsWith('http://') ||
    val.startsWith('https://') ||
    val.startsWith('data:') ||
    val.startsWith('asset:')
  );
}

export function uint8ArrayToBase64(bytes: Uint8Array | number[]): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  const len = arr.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(arr[i]);
  }
  if (typeof btoa !== 'undefined') {
    return btoa(binary);
  }
  return Buffer.from(arr).toString('base64');
}

export async function detectProjectIcon(rootPath: string, projectId?: string): Promise<string> {
  const normalizedRoot = rootPath.replace(/\\/g, '/').replace(/\/+$/, '');

  // 0. Fast native inspection that is not restricted to open workspace project roots
  try {
    const res = await backendInvoke<{ icon?: string | null; github_owner?: string | null }>('project_inspect_any', {
      path: rootPath,
    });
    if (res?.icon) return res.icon;
    if (res?.github_owner) return `https://github.com/${res.github_owner}.png?size=64`;
  } catch {
    // fallback to web/mocked invoke
  }

  // 1. Check for icon files
  const candidateRelativePaths = [
    'src-tauri/icons/32x32.png',
    'src-tauri/icons/64x64.png',
    'src-tauri/icons/icon.png',
    'public/favicon.svg',
    'public/favicon.png',
    'public/favicon.ico',
    'public/icon.png',
    'public/logo.svg',
    'public/logo.png',
    'static/favicon.png',
    'static/favicon.ico',
    'favicon.svg',
    'favicon.png',
    'favicon.ico',
    'icon.png',
    'logo.svg',
    'logo.png',
  ];

  for (const rel of candidateRelativePaths) {
    try {
      const fullPath = `${normalizedRoot}/${rel}`;
      const bytes = await backendInvoke<number[]>('fs_read_binary', { path: fullPath });
      if (bytes && bytes.length > 0 && bytes.length < 500_000) {
        const ext = rel.split('.').pop()?.toLowerCase();
        const mime =
          ext === 'svg'
            ? 'image/svg+xml'
            : ext === 'png'
              ? 'image/png'
              : ext === 'ico'
                ? 'image/x-icon'
                : ext === 'webp'
                  ? 'image/webp'
                  : 'image/jpeg';
        const base64 = uint8ArrayToBase64(bytes);
        return `data:${mime};base64,${base64}`;
      }
    } catch {
      // continue checking
    }
  }

  // 2. Fall back to framework / marker files
  try {
    const entries = await backendInvoke<Array<{ name: string; is_dir: boolean }>>('fs_read_dir', { path: rootPath });
    const names = new Set(entries.map((e) => e.name.toLowerCase()));

    if (names.has('tauri.conf.json') || names.has('src-tauri')) return '🦀';
    if (names.has('next.config.js') || names.has('next.config.mjs') || names.has('next.config.ts')) return '▲';
    if (names.has('svelte.config.js') || names.has('svelte.config.ts')) return '🧡';
    if (names.has('vite.config.js') || names.has('vite.config.ts') || names.has('vite.config.mjs')) return '⚡';
    if (names.has('nuxt.config.ts') || names.has('vue.config.js')) return '💚';
    if (names.has('astro.config.mjs') || names.has('astro.config.ts')) return '🚀';
    if (names.has('angular.json')) return '🅰️';
    if (names.has('cargo.toml')) return '🦀';
    if (names.has('go.mod')) return '🐹';
    if (names.has('pyproject.toml') || names.has('requirements.txt') || names.has('setup.py')) return '🐍';
    if (names.has('dockerfile') || names.has('compose.yaml') || names.has('docker-compose.yml')) return '🐳';
    if (names.has('gemfile')) return '💎';
    if (names.has('composer.json')) return '🐘';
    if (names.has('package.swift')) return '🦅';
    if (names.has('pubspec.yaml')) return '🎯';
    if (names.has('pom.xml') || names.has('build.gradle') || names.has('build.gradle.kts')) return '☕';
    if (names.has('package.json')) return 'icon:folder';
  } catch {
    // continue
  }

  // 3. Fall back to GitHub avatar if remote git info is available
  if (projectId) {
    try {
      const info = await backendInvoke<{ owner: string; repo: string }>('source_control_repo_info', {
        projectId,
        repoPath: rootPath,
      });
      if (info && info.owner) {
        return `https://github.com/${info.owner}.png?size=64`;
      }
    } catch {
      // ignore
    }
  }

  return 'icon:folder';
}

const inFlightIconDetections = new Set<string>();

export async function autoDetectProjectIcon(projectId: string, rootPath: string): Promise<string> {
  if (!projectId || !rootPath) return 'icon:folder';
  const pathKey = normalizeKey(rootPath);
  const currentIcon = projectIconFor(get(allProjectSettings), rootPath, projectId);
  if (currentIcon || inFlightIconDetections.has(pathKey)) return currentIcon || 'icon:folder';
  inFlightIconDetections.add(pathKey);
  try {
    const icon = await detectProjectIcon(rootPath, projectId);
    const latestIcon = projectIconFor(get(allProjectSettings), rootPath, projectId);
    if (latestIcon !== currentIcon) return latestIcon;
    setProjectIcon(projectId, rootPath, icon);
    return icon;
  } catch {
    return 'icon:folder';
  } finally {
    inFlightIconDetections.delete(pathKey);
  }
}

/** Pre-populate or ensure settings are loaded for a project */
export function initProjectSettings(projectId: string): void {
  const loaded = loadStoredProjectConfig(projectId) ?? { ...DEFAULT_PROJECT_CONFIG };
  allProjectSettings.update((map) => ({ ...map, [projectId]: loaded }));
}
