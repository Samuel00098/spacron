import { invoke } from '@tauri-apps/api/core';

export interface MuseNativeTurnOptions {
  cwd: string;
  model?: string | null;
  systemPrompt: string;
  userText: string;
  images: string[];
  effort?: string | null;
  accessMode?: string | null;
  sessionId?: string | null;
}

export interface MuseNativeTurnResult {
  text: string;
  sessionId: string | null;
}

/** Run one Muse turn through the Rust-native Tauri adapter (`muse_chat_complete`). */
export async function runMuseNativeTurn(opts: MuseNativeTurnOptions): Promise<MuseNativeTurnResult> {
  const result = await invoke<{ text: string; session_id: string | null }>('muse_chat_complete', {
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

export type MusePermissionMode = 'default' | 'acceptEdits' | 'auto' | 'bypassPermissions' | 'manual';

export function musePermissionModeForAccess(accessMode: string): MusePermissionMode {
  switch (accessMode) {
    case 'full-access': return 'bypassPermissions';
    case 'auto': return 'auto';
    case 'auto-edits': return 'acceptEdits';
    case 'supervised': return 'manual';
    default: return 'default';
  }
}
