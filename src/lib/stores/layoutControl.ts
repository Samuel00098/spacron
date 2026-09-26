import { writable } from '$lib/stores/storeCompat';

// A thin command bus between the orchestrator (and any other controller) and the
// AppShell, which owns the room/ambient layout as local React state. The
// orchestrator writes commands here; AppShell applies them with its existing
// functions (switchAmbientLayout / focusRoom / minimizeRoom / …) and publishes a
// read-only snapshot back so the orchestrator brain can see the current layout.

export type AmbientLayout = 'focus' | 'development' | 'gallery' | 'vibe' | 'preview';
export type RoomOp = 'focus' | 'expand' | 'collapse' | 'minimize' | 'restore' | 'close';

export type LayoutCommand =
  // `nonce` lets an identical command (e.g. "focus terminal" twice) re-fire.
  | { nonce: number; type: 'ambient'; mode: AmbientLayout }
  /**
   * Restore a whole arrangement at once — mode, Split tiling and focus together.
   *
   * One command rather than three, because the order they land in matters: a
   * mode switch re-applies that mode's own remembered focus, so a focus set
   * beforehand is overwritten (see `switchAmbientLayout`). Handing all three to
   * the shell lets it seed that per-mode entry before switching.
   */
  | {
      nonce: number;
      type: 'arrangement';
      mode: AmbientLayout;
      slots: string[];
      focused: string | null;
      expanded?: string | null;
      presets?: Record<number, string>;
      minimized?: string[];
      roomOrder?: string[];
      devTerminalOpen?: boolean;
    }
  | { nonce: number; type: 'room'; op: RoomOp; room: string }
  /** Zoom `room` to the full stage, or drop back to the grid when null. */
  | { nonce: number; type: 'expand'; room: string | null };

export interface LayoutRoomSnapshot {
  id: string;
  title: string;
  focused: boolean;
  minimized: boolean;
}

export interface LayoutSnapshot {
  ambient: AmbientLayout;
  rooms: LayoutRoomSnapshot[];
  /**
   * Split's tiling order, left→right. Empty is the "unarranged" sentinel — the
   * shell then derives the default two-pane stage — so it is carried through
   * as-is rather than being flattened into the rooms actually on screen.
   */
  splitSlots: string[];
  expandedRoom?: string | null;
  /** Active preset layouts mapped by pane count (2, 3, 4). */
  splitPresets?: Record<number, string>;
  /** Rooms minimized in the current arrangement. */
  minimizedRooms?: string[];
  /** The order used by the room switcher. */
  roomOrder?: string[];
  /** The development terminal is a shell-owned room, not a LayoutState flag. */
  devTerminalOpen?: boolean;
}

export const layoutControlCommand = writable<LayoutCommand | null>(null);
export const layoutSnapshot = writable<LayoutSnapshot>({ ambient: 'focus', rooms: [], splitSlots: [] });

/** The room the shell currently treats as active, or null when there isn't one. */
export function focusedRoomOf(snapshot: LayoutSnapshot): string | null {
  return snapshot.rooms.find((room) => room.focused)?.id ?? null;
}

let commandNonce = 0;

/** Ask the workspace to switch ambient arrangement (Focus / Split / Gallery / Preview). */
export function requestAmbientLayout(mode: AmbientLayout): void {
  layoutControlCommand.set({ nonce: ++commandNonce, type: 'ambient', mode });
}

/**
 * Ask the workspace to restore a saved arrangement wholesale. Used when swapping
 * projects, so each one comes back to the stage it was left on.
 */
export function requestRoomArrangement(
  mode: AmbientLayout,
  slots: string[],
  focused: string | null,
  expanded?: string | null,
  presets?: Record<number, string>,
  minimized?: string[],
  roomOrder?: string[],
  devTerminalOpen?: boolean,
): void {
  layoutControlCommand.set({
    nonce: ++commandNonce,
    type: 'arrangement',
    mode,
    slots,
    focused,
    expanded: expanded ?? null,
    presets,
    minimized,
    roomOrder,
    devTerminalOpen,
  });
}

/** Ask the workspace to focus / minimize / restore / close a room by name. */
export function requestRoomControl(op: RoomOp, room: string): void {
  layoutControlCommand.set({ nonce: ++commandNonce, type: 'room', op, room });
}

/**
 * Ask the workspace to expand `room` to the full stage, or to collapse back to
 * the grid when `room` is null. A room that is no longer open is ignored. Used by
 * the title bar's Back/Forward to step between expanded panels.
 */
export function requestStageExpansion(room: string | null): void {
  layoutControlCommand.set({ nonce: ++commandNonce, type: 'expand', room });
}

/** AppShell publishes its current layout here so controllers can read it. */
export function publishLayoutSnapshot(snapshot: LayoutSnapshot): void {
  layoutSnapshot.set(snapshot);
}
