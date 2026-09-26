import { describe, it, expect, beforeEach } from 'vitest';
import { get } from '$lib/stores/storeCompat';
import { layoutControlCommand } from '$lib/stores/layoutControl';
import {
  useLayoutStore,
  fitDrawerWidths,
  STAGE_MIN_WIDTH,
  LEFT_PANEL_MIN_WIDTH,
  RIGHT_DRAWER_MIN_WIDTH,
} from './layout';

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

  it('squeezes both drawers so the stage keeps its minimum at the 960px window', () => {
    const fit = fitDrawerWidths({ ...both, available: 904 });
    expect(904 - fit.left - fit.right).toBeGreaterThanOrEqual(STAGE_MIN_WIDTH);
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
