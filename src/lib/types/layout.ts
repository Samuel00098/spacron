export type PanelType = 'terminal' | 'editor' | 'explorer' | 'preview' | 'settings';

export type ActiveView = 'editor' | 'terminal' | 'preview' | 'settings' | 'review' | 'http' | 'tasks' | 'orchestrator' | 'db' | 'containers' | 'toolbox' | 'env' | 'fleet' | 'mobile' | 'sketch' | 'library' | 'deepseek';

// Code Review remains an ActiveView for persisted-state compatibility, but the
// visible panel is now hosted by the unified right-sidebar utility drawer.
export type SidebarTab = 'projects' | 'files' | 'search' | 'git' | 'snapshots' | 'history' | 'snippets' | 'problems';

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
  | 'chat'
  | 'source-control'
  | 'orchestrator'
  | 'mcp'
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
  mobileVisible: boolean;
  sketchVisible: boolean;
  libraryVisible: boolean;
  deepseekVisible: boolean;
  auxPanelWidth: number;
  auxEditorHeight: number; // percentage split between editor and preview panes
  leftPanelWidth: number; // width of the left utility panel (Files/Search/Git/Snapshots/Snippets/Review)
  rightDrawerWidth: number; // width of the right utility panel (Toolbox/HTTP/DB/Containers/Env)
  /** Preview lives in the right sidebar rather than as a stage room. Only
   *  meaningful while `previewVisible`; the next open re-reads the
   *  `previewPlacement` setting. */
  previewDocked: boolean;
  /** Right sidebar width while it is showing the docked Preview. Kept apart from
   *  `rightDrawerWidth` so a wide browser does not leave Files wide too. */
  previewDrawerWidth: number;
}
