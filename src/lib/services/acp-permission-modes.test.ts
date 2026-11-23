import { describe, expect, it } from 'vitest';
import { acpModeNeedsSwitch, chooseAcpMode, chooseAntigravityAcpMode, parseAcpModeState } from './acp-permission-modes';

const cursorModes = {
  currentModeId: 'auto',
  availableModes: [
    { id: 'read-only', name: 'Read Only' },
    { id: 'accept-edits', name: 'Accept Edits' },
    { id: 'auto', name: 'Auto' },
    { id: 'yolo', name: 'YOLO', description: 'No approvals' },
  ],
};

describe('ACP permission modes', () => {
  it('uses Antigravity native Auto only when advertised and handles Full access in default', () => {
    const defaultMode = { id: 'default' };
    const state = { currentModeId: 'plan', availableModes: [defaultMode, { id: 'auto' }, { id: 'plan' }] };
    expect(chooseAntigravityAcpMode(state, 'auto')).toBe('auto');
    expect(chooseAntigravityAcpMode(state, 'full-access')).toBe('default');
    expect(chooseAntigravityAcpMode({ ...state, availableModes: [defaultMode] }, 'auto')).toBe('default');
  });
  it('reads modes from a session/new result or from the modes object alone', () => {
    const parsed = parseAcpModeState({ sessionId: 's1', modes: cursorModes });
    expect(parsed).toEqual({
      currentModeId: 'auto',
      availableModes: [
        { id: 'read-only', name: 'Read Only' },
        { id: 'accept-edits', name: 'Accept Edits' },
        { id: 'auto', name: 'Auto' },
        { id: 'yolo', name: 'YOLO', description: 'No approvals' },
      ],
    });
    expect(parseAcpModeState(cursorModes)?.availableModes).toHaveLength(4);
    expect(parseAcpModeState({ sessionId: 's1' })).toBeNull();
    expect(parseAcpModeState(null)).toBeNull();
  });

  it('maps each tier onto the agent’s own modes', () => {
    expect(chooseAcpMode(parseAcpModeState({ modes: cursorModes }), 'supervised')).toBe('read-only');
    expect(chooseAcpMode(parseAcpModeState({ modes: cursorModes }), 'auto-edits')).toBe('accept-edits');
    // "auto accept edits" must never be read as plain auto.
    const editsOnly = parseAcpModeState({
      modes: { availableModes: [{ id: 'auto-accept-edits', name: 'Auto Accept Edits' }, { id: 'auto', name: 'Auto' }] },
    });
    expect(chooseAcpMode(editsOnly, 'auto-edits')).toBe('auto-accept-edits');
    expect(chooseAcpMode(editsOnly, 'auto')).toBe('auto');
    expect(chooseAcpMode(parseAcpModeState({ modes: cursorModes }), 'full-access')).toBe('yolo');
  });

  it('leaves the agent alone when it advertises nothing suitable', () => {
    const plain = parseAcpModeState({ modes: { availableModes: [{ id: 'chat', name: 'Chat' }] } });
    expect(chooseAcpMode(plain, 'full-access')).toBeNull();
    expect(chooseAcpMode(null, 'auto')).toBeNull();
    // No bypass mode advertised: a full-access tier must not be faked.
    const safeOnly = parseAcpModeState({ modes: { availableModes: [{ id: 'read-only' }, { id: 'ask' }] } });
    expect(chooseAcpMode(safeOnly, 'full-access')).toBeNull();
  });

  it('skips a set_mode call when the session is already there', () => {
    const state = parseAcpModeState({ modes: cursorModes });
    expect(acpModeNeedsSwitch(state, 'auto')).toBe(false);
    expect(acpModeNeedsSwitch(state, 'full-access')).toBe(true);
    expect(acpModeNeedsSwitch(null, 'auto')).toBe(false);
  });
});
