import { describe, expect, it } from 'vitest';
import { parsePiDialog, piDialogResponse, type PiDialog } from './pi-questions';

describe('Pi extension dialogs', () => {
  it('answers select with the label and confirm with a boolean', () => {
    const select = parsePiDialog({ id: 'u1', method: 'select', title: 'Allow?', options: ['Allow', 'Block'] }) as PiDialog;
    expect(piDialogResponse(select, '1')).toEqual({ type: 'extension_ui_response', id: 'u1', value: 'Block' });
    const confirm = parsePiDialog({ id: 'u2', method: 'confirm', title: 'Clear?' }) as PiDialog;
    expect(piDialogResponse(confirm, '1')).toEqual({ type: 'extension_ui_response', id: 'u2', confirmed: false });
    expect(piDialogResponse(confirm)).toEqual({ type: 'extension_ui_response', id: 'u2', cancelled: true });
  });

  it('cancels typed-input dialogs and ignores notifications', () => {
    expect(parsePiDialog({ id: 'u3', method: 'input', title: 'Value' })).toBe('cancel');
    expect(parsePiDialog({ id: 'u4', method: 'notify', message: 'hi' })).toBeNull();
  });
});
