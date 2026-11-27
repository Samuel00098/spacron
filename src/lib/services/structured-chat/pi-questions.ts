/**
 * Pi's extension dialogs over RPC (`docs/rpc-extension-ui.md` in pi 1.7.0; not
 * run live). An `extension_ui_request` blocks the agent until the matching
 * `extension_ui_response`. `select` and `confirm` render as a card; `input` and
 * `editor` want typed text, which a card of buttons can't give.
 */
export interface PiDialog {
  id: string;
  method: 'select' | 'confirm';
  title: string;
  message: string | null;
  options: { id: string; label: string }[];
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** `cancel`: a dialog we can't show. Null: a notification that expects no reply. */
export function parsePiDialog(frame: Record<string, unknown>): PiDialog | 'cancel' | null {
  const id = text(frame.id);
  const method = frame.method;
  if (!id) return null;
  if (method === 'input' || method === 'editor') return 'cancel';
  if (method !== 'select' && method !== 'confirm') return null;
  const labels = method === 'confirm' ? ['Yes', 'No'] : (Array.isArray(frame.options) ? frame.options.filter((o): o is string => typeof o === 'string') : []);
  if (!labels.length) return 'cancel';
  return {
    id,
    method,
    title: text(frame.title) || 'Pi has a question',
    message: text(frame.message) || null,
    options: labels.map((label, index) => ({ id: String(index), label })),
  };
}

/** The reply for the chosen option; no (or an unknown) choice cancels. */
export function piDialogResponse(dialog: Pick<PiDialog, 'id' | 'method' | 'options'>, optionId?: string): Record<string, unknown> {
  const chosen = dialog.options.find((o) => o.id === optionId);
  const base = { type: 'extension_ui_response', id: dialog.id };
  if (!chosen) return { ...base, cancelled: true };
  return dialog.method === 'confirm' ? { ...base, confirmed: chosen.id === '0' } : { ...base, value: chosen.label };
}
