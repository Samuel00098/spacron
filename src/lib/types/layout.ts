export type PanelType = 'terminal' | 'editor' | 'explorer' | 'preview' | 'settings';

export type ActiveView = 'editor' | 'terminal' | 'preview' | 'settings' | 'review' | 'http' | 'tasks' | 'orchestrator' | 'db' | 'containers' | 'toolbox' | 'youtube' | 'env' | 'fleet' | 'mobile';

// 'review' was removed 2026-07-26: Code Review is a full center panel now, not a
// drawer tab. A two-column diff is unreadable at drawer width.
export type SidebarTab = 'files' | 'search' | 'git' | 'snapshots' | 'history' | 'snippets' | 'problems';

// Sections of the Settings modal. Lives here rather than in the component so
// callers can deep-link one (`openSettings('appearance')`) without importing the
// modal itself.
export type SettingsTab =
  | 'general'
  | 'appearance'
  | 'models'
  | 'voice'
  | 'terminal'
  | 'agents'
  | 'stats'
  | 'shortcuts'
  | 'about';

export interface LayoutState {
  sidebarVisible: boolean;
  sidebarWidth: number;
  activeView: ActiveView;
  lastAuxView: ActiveView; // remembers last open right-panel tab for restoration
  editorSplitPreview: boolean; // show preview panel alongside editor
  sidebarTab: SidebarTab;
  editorVisible: boolean;
  previewVisible: boolean;
  reviewVisible: boolean;
  httpVisible: boolean;
  tasksVisible: boolean;
  fleetVisible: boolean;
  orchestratorVisible: boolean;
  dbVisible: boolean;
  containersVisible: boolean;
  toolboxVisible: boolean;
  envVisible: boolean;
  youtubeVisible: boolean;
  mobileVisible: boolean;
  auxPanelWidth: number;
  auxEditorHeight: number; // percentage split between editor and preview panes
  leftPanelWidth: number; // width of the left utility panel (Files/Search/Git/Snapshots/Snippets/Review)
  rightDrawerWidth: number; // width of the right utility panel (Toolbox/HTTP/DB/Containers/Env)
}

