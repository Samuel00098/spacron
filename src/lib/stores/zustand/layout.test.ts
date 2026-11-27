import { describe, it, expect, beforeEach } from 'vitest';
import { get } from '$lib/stores/storeCompat';
import { layoutControlCommand } from '$lib/stores/layoutControl';
import {
  useLayoutStore,
  fitDrawerWidths,
  STAGE_MIN_WIDTH,
  LEFT_PANEL_DEFAULT_WIDTH,
  LEFT_PANEL_MIN_WIDTH,
  RIGHT_DRAWER_MIN_WIDTH,
} from './layout';
import { useSettingsStore } from './settings';

// The editor is a room, not just a visibility flag. Flipping `editorVisible`
// leaves it wherever it was — off stage, or minimized — so revealing the editor
// has to ask the room system to bring it forward as well. AppShell answers the
// command with `focusRoom`, which un-minimizes and honours the Split slot rule.
describe('setActiveView room focus', () => {
  beforeEach(() => {
    layoutControlCommand.set(null);
    useLayoutStore.setState({ editorVisible: false, activeView: 'terminal' });
  });

  it('asks the room system to focus the editor when the editor view is shown', () => {
    useLayoutStore.getState().setActiveView('editor');

    expect(useLayoutStore.getState().editorVisible).toBe(true);
    expect(get(layoutControlCommand)).toMatchObject({ type: 'room', op: 'focus', room: 'editor' });
  });

  it('re-fires with a fresh nonce when the editor is already the active view', () => {
    // Re-opening the file that is already on screen changes no layout state at
    // all. Without a new nonce the request is swallowed and the editor stays
    // off stage — which was the original bug.
    useLayoutStore.getState().setActiveView('editor');
    const first = get(layoutControlCommand);

    useLayoutStore.getState().setActiveView('editor');
    const second = get(layoutControlCommand);

    expect(first?.nonce).toBeGreaterThan(0);
    expect(second?.nonce).toBeGreaterThan(first!.nonce);
  });

  it('does not touch room focus for non-editor views', () => {
    useLayoutStore.getState().setActiveView('tasks');
    expect(get(layoutControlCommand)).toBeNull();
  });
});

describe('sidebarTab projects persistence and sanitisation', () => {
  it('validates projects as a recognized sidebar tab', async () => {
    const { sanitiseSidebarTab } = await import('./layout');
    expect(sanitiseSidebarTab('projects')).toBe('projects');
  });

  it('toggles projects tab and maintains visibility', () => {
    useLayoutStore.setState({ sidebarVisible: false, sidebarTab: 'files' });
    useLayoutStore.getState().toggleSidebarTab('projects');

    expect(useLayoutStore.getState().sidebarVisible).toBe(true);
    expect(useLayoutStore.getState().sidebarTab).toBe('projects');

    // Toggling while active collapses it
    useLayoutStore.getState().toggleSidebarTab('projects');
    expect(useLayoutStore.getState().sidebarVisible).toBe(false);
  });
});

// Drawers give way so the stage stays usable in small windows, without ever
// rewriting the saved widths (that is the caller's business, and it doesn't).
describe('fitDrawerWidths', () => {
  const both = { left: 340, right: 380, leftOpen: true, rightOpen: true };

  it('keeps the saved widths when everything fits', () => {
    expect(fitDrawerWidths({ ...both, available: 1224 })).toEqual({ left: 340, right: 380 });
  });

  it('squeezes both drawers down to their minimums at the 960px window', () => {
    const fit = fitDrawerWidths({ ...both, available: 904 });
    // The minimums come first here: the stage gets what they leave.
    expect(fit).toEqual({ left: LEFT_PANEL_MIN_WIDTH, right: RIGHT_DRAWER_MIN_WIDTH });
    expect(fit.left).toBeGreaterThanOrEqual(LEFT_PANEL_MIN_WIDTH);
    expect(fit.right).toBeGreaterThanOrEqual(RIGHT_DRAWER_MIN_WIDTH);
  });

  it('never goes below either minimum, even when the stage cannot be saved', () => {
    expect(fitDrawerWidths({ ...both, available: 500 })).toEqual({
      left: LEFT_PANEL_MIN_WIDTH,
      right: RIGHT_DRAWER_MIN_WIDTH,
    });
  });

  it('only squeezes the drawer that is open', () => {
    const fit = fitDrawerWidths({ ...both, rightOpen: false, available: 700 });
    expect(fit.left).toBe(700 - STAGE_MIN_WIDTH);
    expect(fit.right).toBe(380);
  });
});

// Preview can be docked in the right sidebar instead of being a stage room.
// Docked, it sits beside the stage, so opening it must not move the stage and
// the stage's single-room toggles must not close it.
describe('docked preview', () => {
  beforeEach(() => {
    layoutControlCommand.set(null);
    useLayoutStore.setState({ previewVisible: false, previewDocked: false, editorVisible: false, activeView: 'terminal' });
  });

  it('opens in the sidebar when that is the placement setting, leaving the stage alone', () => {
    useSettingsStore.setState({ previewPlacement: 'sidebar' });
    useLayoutStore.getState().togglePreviewVisible();

    const l = useLayoutStore.getState();
    expect(l.previewVisible).toBe(true);
    expect(l.previewDocked).toBe(true);
    expect(l.activeView).toBe('terminal');
  });

  it('opens as a room when that is the placement setting', () => {
    useSettingsStore.setState({ previewPlacement: 'room' });
    useLayoutStore.getState().revealPreview();

    const l = useLayoutStore.getState();
    expect(l.previewDocked).toBe(false);
    expect(l.activeView).toBe('preview');
    expect(get(layoutControlCommand)).toMatchObject({ type: 'room', op: 'focus', room: 'preview' });
  });

  it('survives opening the editor while docked, but not while it is a room', () => {
    useLayoutStore.setState({ previewVisible: true, previewDocked: true });
    useLayoutStore.getState().toggleEditorVisible();
    expect(useLayoutStore.getState().previewVisible).toBe(true);

    useLayoutStore.setState({ previewVisible: true, previewDocked: false, editorVisible: false });
    useLayoutStore.getState().toggleEditorVisible();
    expect(useLayoutStore.getState().previewVisible).toBe(false);
  });

  it('moves between the sidebar and a room without closing', () => {
    useLayoutStore.setState({ previewVisible: true, previewDocked: true });
    useLayoutStore.getState().setPreviewDocked(false);
    expect(useLayoutStore.getState()).toMatchObject({ previewVisible: true, previewDocked: false, activeView: 'preview' });

    useLayoutStore.getState().setPreviewDocked(true);
    expect(useLayoutStore.getState()).toMatchObject({ previewVisible: true, previewDocked: true, activeView: 'terminal' });
  });
});

describe('left sidebar width', () => {
  it('opens at its default width however wide it was left', () => {
    useLayoutStore.setState({ sidebarVisible: true });
    useLayoutStore.getState().setLeftPanelWidth(480);
    expect(useLayoutStore.getState().leftPanelWidth).toBe(480);
    useLayoutStore.getState().setSidebarVisible(false);
    useLayoutStore.getState().setSidebarVisible(true);
    expect(useLayoutStore.getState().leftPanelWidth).toBe(LEFT_PANEL_DEFAULT_WIDTH);
  });

  it('cannot be made narrower than its minimum', () => {
    useLayoutStore.getState().setLeftPanelWidth(100);
    expect(useLayoutStore.getState().leftPanelWidth).toBe(LEFT_PANEL_MIN_WIDTH);
  });
});
