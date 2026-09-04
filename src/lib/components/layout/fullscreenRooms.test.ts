import { describe, expect, it } from 'vitest';
import { isFullscreenRoom, resolveStageExpansion } from './fullscreenRooms.ts';

describe('isFullscreenRoom', () => {
  it('claims Tasks and Sketch', () => {
    expect(isFullscreenRoom('tasks')).toBe(true);
    expect(isFullscreenRoom('sketch')).toBe(true);
  });

  it('leaves every other room tileable', () => {
    for (const room of ['terminal', 'editor', 'preview', 'review', 'agent:7', 'workspace']) {
      expect(isFullscreenRoom(room)).toBe(false);
    }
  });
});

describe('resolveStageExpansion', () => {
  it('fills the stage with a fullscreen-only room whenever it is active', () => {
    expect(resolveStageExpansion('sketch', null)).toEqual({ room: 'sketch', forced: true });
    expect(resolveStageExpansion('tasks', null)).toEqual({ room: 'tasks', forced: true });
  });

  it('leaves an ordinary active room to the grid', () => {
    expect(resolveStageExpansion('terminal', null)).toEqual({ room: null, forced: false });
  });

  it('reports a user zoom as unforced, so it stays dismissable', () => {
    expect(resolveStageExpansion('terminal', 'terminal')).toEqual({
      room: 'terminal',
      forced: false,
    });
  });

  // The whole point of deriving rather than storing: a fullscreen room outranks
  // whatever `expandedRoom` happens to hold, so no path that clears the zoom can
  // drop Tasks or Sketch into a tile.
  it('outranks a stale zoom on another room', () => {
    expect(resolveStageExpansion('sketch', 'terminal')).toEqual({ room: 'sketch', forced: true });
  });

  // Leaving Sketch for the terminal must not hand the terminal a full-stage zoom
  // the user never asked for — the stage goes back to that room's normal tiling.
  it('releases the stage when focus moves off a fullscreen room', () => {
    expect(resolveStageExpansion('editor', null)).toEqual({ room: null, forced: false });
  });

  it('expands nothing on an empty stage', () => {
    expect(resolveStageExpansion(null, null)).toEqual({ room: null, forced: false });
  });
});
