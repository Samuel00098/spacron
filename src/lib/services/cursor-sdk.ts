import { invoke } from '@tauri-apps/api/core';

export interface CursorNativeTurnOptions {
  cwd: string;
  model?: string | null;
  systemPrompt: string;
  userText: string;
  images: string[];
  effort?: string | null;
  accessMode?: string | null;
  sessionId?: string | null;
}

export interface CursorNativeTurnResult {
  text: string;
  sessionId: string | null;
}

/** Run one Cursor turn through the Rust-native Tauri adapter (`cursor_chat_complete`). */
export async function runCursorNativeTurn(opts: CursorNativeTurnOptions): Promise<CursorNativeTurnResult> {
  const result = await invoke<{ text: string; session_id: string | null }>('cursor_chat_complete', {
    cwd: opts.cwd,
    model: opts.model ?? null,
    system_prompt: opts.systemPrompt,
    user_text: opts.userText,
    images: opts.images,
    effort: opts.effort ?? null,
    access_mode: opts.accessMode ?? null,
    session_id: opts.sessionId ?? null,
  });
  return { text: result.text, sessionId: result.session_id ?? null };
}

export type CursorPermissionMode = 'default' | 'acceptEdits' | 'auto' | 'bypassPermissions' | 'manual';

export function cursorPermissionModeForAccess(accessMode: string): CursorPermissionMode {
  switch (accessMode) {
    case 'full-access': return 'bypassPermissions';
    case 'auto': return 'auto';
    case 'auto-edits': return 'acceptEdits';
    case 'supervised': return 'manual';
    default: return 'default';
  }
}
