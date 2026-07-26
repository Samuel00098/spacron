export type PanelType = 'terminal' | 'editor' | 'explorer' | 'preview' | 'settings';

export type ActiveView = 'editor' | 'terminal' | 'preview' | 'settings' | 'review' | 'http' | 'tasks' | 'orchestrator' | 'db' | 'containers' | 'toolbox' | 'youtube' | 'env' | 'fleet';

// 'review' was removed 2026-07-26: Code Review is a full center panel now, not a
// drawer tab. A two-column diff is unreadable at drawer width.
export type SidebarTab = 'files' | 'search' | 'git' | 'snapshots' | 'history' | 'snippets' | 'problems';

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
  auxPanelWidth: number;
  auxEditorHeight: number; // percentage split between editor and preview panes
  leftPanelWidth: number; // width of the left utility panel (Files/Search/Git/Snapshots/Snippets/Review)
  rightDrawerWidth: number; // width of the right utility panel (Toolbox/HTTP/DB/Containers/Env)
}

