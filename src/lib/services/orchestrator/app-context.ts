import { get } from '$lib/stores/storeCompat';
import { layout, settingsOpen } from '$lib/stores/layout';
import { layoutSnapshot } from '$lib/stores/layoutControl';
import { openFiles, activeFile, fileCache, activeLine, activeColumn, activeSelection } from '$lib/stores/editor';
import { getTerminalProjectState, getAgentDisplayName, getSessionOutputBuffer } from '$lib/stores/terminal';
import { currentUrl, proxyStarted } from '$lib/stores/preview';
import { branchInfo } from '$lib/stores/gitBranch';
import { getPresetRuns, filterInstalledAgents } from '$lib/stores/runs';
import { usageState, installedAgentCommands, haveAgentDetection } from '$lib/stores/usage';
import { getCustomAgents } from '$lib/stores/customAgents';
import { captureTranscript } from '$lib/services/orchestrator/activity-log';
import { getAgentSettingsSnapshot } from '$lib/services/orchestrator/app-settings';
import type { LayoutState } from '$lib/types/layout';
import type { AppStateRef } from '$lib/services/orchestrator-brain';

// Caps so feeding live content every chat turn stays affordable on tokens.
const MAX_FILE_CONTENT = 4000;
const MAX_SELECTION = 1500;
const MAX_TERMINAL_TAIL = 500;

// The aux panels the assistant can reason about / navigate to, mapped from the
// layout visibility flags to the plain names the brain uses in `navigate`.
const PANEL_FLAGS: Array<{ flag: keyof LayoutState; label: string }> = [
  { flag: 'editorVisible', label: 'editor' },
  { flag: 'previewVisible', label: 'preview' },
  { flag: 'reviewVisible', label: 'review' },
  { flag: 'httpVisible', label: 'http' },
  { flag: 'tasksVisible', label: 'tasks' },
  { flag: 'dbVisible', label: 'db' },
  { flag: 'containersVisible', label: 'containers' },
  { flag: 'toolboxVisible', label: 'toolbox' },
  { flag: 'mobileVisible', label: 'mobile' },
  { flag: 'sketchVisible', label: 'sketch' },
  { flag: 'libraryVisible', label: 'library' },
  { flag: 'deepseekVisible', label: 'deepseek' },
];

/** Every view the assistant may `navigate` to (matches layout's known views). */
export const NAVIGABLE_VIEWS = [
  'editor',
  'terminal',
  'preview',
  'review',
  'http',
  'tasks',
  'db',
  'containers',
  'toolbox',
  'mobile',
  'sketch',
  'settings',
] as const;

function relativise(path: string | null | undefined, rootPath: string): string | null {
  if (!path) return null;
  const norm = path.replace(/\\/g, '/');
  const root = rootPath.replace(/\\/g, '/').replace(/\/$/, '');
  if (root && norm.startsWith(root + '/')) return norm.slice(root.length + 1);
  return norm;
}

/**
 * A full, structured read of what the user is currently looking at and working
 * with across the whole application — the active page, open editor files +
 * cursor, unsaved changes, visible panels, terminals, preview, git branch, and
 * the run presets available. Fed to the orchestrator brain so it can answer
 * questions about the app and decide which app-control action to take.
 */
export function getAppContextSnapshot(projectId: string, rootPath = '', includeProjectContent = true): AppStateRef {
  const l = get(layout);
  const cache = get(fileCache);
  const open = includeProjectContent ? get(openFiles) : [];
  const active = includeProjectContent ? get(activeFile) : null;

  const dirtyFiles = open.filter((p) => cache.get(p)?.isDirty);

  const sessions = getTerminalProjectState(projectId).sessions;
  const terminals = sessions.map((s) => {
    const tail = captureTranscript(getSessionOutputBuffer(s.id), MAX_TERMINAL_TAIL);
    return {
      label: (s.agentName?.trim() || s.role || s.title || `Terminal ${s.id}`),
      agent: s.agentPreset ? (getAgentDisplayName(s.agentPreset) ?? s.agentPreset) : null,
      cwd: relativise(s.cwd, rootPath),
      running: s.isRunning,
      busy: !!s.isExecuting,
      recentOutput: tail || null,
    };
  });

  const snap = get(layoutSnapshot);
  const isDev = snap.ambient === 'development';
  const visiblePanels = isDev
    ? (['toolbox', 'http', 'db', 'containers', 'env'].includes(l.activeView) ? [l.activeView] : [])
    : PANEL_FLAGS.filter(({ flag }) => !!l[flag]).map(({ label }) => label);

  const layoutState = {
    ambient: snap.ambient,
    rooms: snap.rooms.map((r) => ({ title: r.title, focused: r.focused, minimized: r.minimized })),
  };

  const branch = get(branchInfo)?.current ?? null;
  const previewUrl = get(currentUrl);

  // Same "installed only" rule as the spawn picker: an agent roster is a menu
  // of what the user can actually launch, so once detection has run, built-in
  // agents narrow to the ones found on PATH. Non-agent presets (Dev Server)
  // are not subject to agent detection and stay. Before the first scan — or in
  // a browser session where no scan exists — everything is kept.
  const allRuns = getPresetRuns(projectId);
  const usage = get(usageState);
  const agentRuns = filterInstalledAgents(allRuns.filter((r) => r.isAgent), {
    installedCommands: installedAgentCommands(usage),
    customCommands: new Set(getCustomAgents().map((a) => a.command)),
    haveDetection: haveAgentDetection(usage),
  });
  const availableRuns = [...agentRuns, ...allRuns.filter((r) => !r.isAgent)]
    .map((r) => ({ name: r.name, command: r.command }))
    .slice(0, 12);

  // Live content of the active file (skipped for images/binaries) + the user's
  // current selection — only while the editor is the focused view, so the
  // assistant reasons about what the user is actually looking at.
  const activeEntry = active ? get(fileCache).get(active) : undefined;
  const editorFocused = l.activeView === 'editor' && l.editorVisible;
  const rawContent = activeEntry && activeEntry.kind === 'text' ? (activeEntry.content ?? '') : '';
  const truncatedContent = rawContent.length > MAX_FILE_CONTENT;
  const selectionText = includeProjectContent && editorFocused ? get(activeSelection).trim() : '';

  return {
    activeView: l.activeView,
    settingsOpen: get(settingsOpen),
    visiblePanels,
    layout: layoutState,
    sidebar: { open: l.sidebarVisible, tab: l.sidebarTab },
    editor: {
      activeFile: relativise(active, rootPath),
      openFiles: open.map((p) => relativise(p, rootPath) ?? p),
      dirtyFiles: dirtyFiles.map((p) => relativise(p, rootPath) ?? p),
      cursor: active ? { line: get(activeLine), col: get(activeColumn) } : null,
      language: activeEntry?.language ?? null,
      content: editorFocused && rawContent ? rawContent.slice(0, MAX_FILE_CONTENT) : null,
      contentTruncated: editorFocused && truncatedContent,
      selection: selectionText ? selectionText.slice(0, MAX_SELECTION) : null,
    },
    terminals,
    preview: includeProjectContent ? { url: previewUrl || null, running: get(proxyStarted) } : undefined,
    branch: includeProjectContent ? branch : undefined,
    availableViews: [...NAVIGABLE_VIEWS],
    availableRuns,
    settings: getAgentSettingsSnapshot(),
  };
}
