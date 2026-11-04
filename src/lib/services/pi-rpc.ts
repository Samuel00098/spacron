import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export type PiRecord = Record<string, unknown>;

export interface PiRpcSession {
  id: number;
  command(record: PiRecord): Promise<void>;
  onEvent(handler: (record: PiRecord) => void): Promise<UnlistenFn>;
  onStderr(handler: (text: string) => void): Promise<UnlistenFn>;
  onExit(handler: () => void): Promise<UnlistenFn>;
  close(): Promise<void>;
}

export async function openPiRpcSession(command: string, args: string[], cwd: string): Promise<PiRpcSession> {
  const { id } = await invoke<{ id: number }>('pi_start', { args: { command, args, cwd } });
  let closed = false;
  return {
    id,
    async command(record) {
      if (closed) throw new Error('Pi RPC session is closed');
      await invoke('pi_command', { id, record });
    },
    onEvent(handler) {
      return listen<PiRecord>(`pi://${id}/event`, (event) => handler(event.payload));
    },
    onStderr(handler) {
      return listen<{ text?: string }>(`pi://${id}/stderr`, (event) => {
        if (typeof event.payload.text === 'string') handler(event.payload.text);
      });
    },
    onExit(handler) {
      return listen<Record<string, unknown>>(`pi://${id}/exit`, () => handler());
    },
    async close() {
      if (closed) return;
      closed = true;
      await invoke('pi_close', { id });
    },
  };
}

export function piPrompt(message: string, id = `spacron-${Date.now()}`): PiRecord {
  return { id, type: 'prompt', message };
}

export function isPiSettled(record: PiRecord): boolean {
  return record.type === 'agent_settled'
    || record.type === 'agent_end'
    || record.type === 'response' && record.command === 'prompt' && record.success === false;
}

export function piTextDelta(record: PiRecord): string {
  if (record.type !== 'message_update' || !record.assistantMessageEvent ||
      typeof record.assistantMessageEvent !== 'object') return '';
  const event = record.assistantMessageEvent as Record<string, unknown>;
  return event.type === 'text_delta' && typeof event.delta === 'string' ? event.delta : '';
}
