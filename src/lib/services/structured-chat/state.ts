import type { TerminalChatItem } from '$lib/services/terminal-chat';
import type { StructuredAccess, StructuredChatState } from './codex-session';

export function initialStructuredState(access: StructuredAccess = 'ask', previous?: StructuredChatState): StructuredChatState {
  return {
    status: 'starting',
    error: null,
    items: previous?.items ?? [],
    models: previous?.models ?? [],
    model: previous?.model ?? null,
    effort: previous?.effort ?? null,
    fast: previous?.fast,
    ultracode: previous?.ultracode,
    mode: previous?.mode ?? null,
    access: previous?.access ?? access,
    threadId: null,
    approvals: [],
    subagents: previous?.subagents ?? [],
    pendingQueue: [],
    restoredMode: previous?.restoredMode ?? null,
    contextUsed: null,
    contextWindow: null,
  };
}

export class StructuredStateStore {
  readonly states = new Map<number, StructuredChatState>();
  private readonly listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get(sessionId: number): StructuredChatState | null {
    return this.states.get(sessionId) ?? null;
  }

  set(sessionId: number, state: StructuredChatState): void {
    this.states.set(sessionId, state);
    this.emit();
  }

  update(sessionId: number, patch: Partial<StructuredChatState> | ((state: StructuredChatState) => Partial<StructuredChatState>)): void {
    const current = this.states.get(sessionId);
    if (!current) return;
    this.states.set(sessionId, { ...current, ...(typeof patch === 'function' ? patch(current) : patch) });
    this.emit();
  }

  upsert(sessionId: number, item: TerminalChatItem): void {
    this.update(sessionId, (state) => {
      const index = state.items.findIndex((candidate) => candidate.id === item.id);
      if (index < 0) return { items: [...state.items, { ...item, time: item.time ?? new Date().toISOString() }] };
      const items = state.items.slice();
      items[index] = { ...items[index], ...item };
      return { items };
    });
  }

  append(sessionId: number, id: string, kind: TerminalChatItem['kind'], text: string): void {
    this.update(sessionId, (state) => {
      const index = state.items.findIndex((item) => item.id === id);
      if (index < 0) return { items: [...state.items, { id, kind, text, time: new Date().toISOString() }] };
      const items = state.items.slice();
      items[index] = { ...items[index], text: items[index].text + text };
      return { items };
    });
  }

  delete(sessionId: number): void {
    this.states.delete(sessionId);
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
