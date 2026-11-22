import { get } from '$lib/stores/storeCompat';
import {
  sessions,
  devSessions,
  activeSessionId,
  devActiveSessionId,
  manualPromptTargetId,
  isAgentSession,
  getAgentDisplayName,
  requestTerminalInput,
  requestTerminalChatInput,
  promptBarImage,
} from '$lib/stores/terminal';
import { isTerminalChatView } from '$lib/services/terminal-chat';
import { structuredChatPanes } from '$lib/services/structured-chat/panes';
import { invoke } from '@tauri-apps/api/core';

export type AgentTarget = {
  id: number;
  sessionId: number;
  name: string;
  preset: string;
  displayName: string;
  isChatView: boolean;
  isDev: boolean;
  lastActivatedAt: number;
};

export function getActiveAgentTargets(): AgentTarget[] {
  const normal = get(sessions) || [];
  const dev = get(devSessions) || [];
  const structPanes = get(structuredChatPanes) || {};

  const candidates: AgentTarget[] = [];
  const seenIds = new Set<number>();

  for (const s of [...normal, ...dev]) {
    if (!s || !s.isRunning || s.hidden) continue;
    if (seenIds.has(s.id)) continue;
    if (!isAgentSession(s)) continue;

    seenIds.add(s.id);
    const isDev = dev.some((d) => d?.id === s.id);
    const isChat = isTerminalChatView(s.id) || Boolean(structPanes[s.id]);
    const preset = s.agentPreset || 'agent';
    const name = s.agentName || getAgentDisplayName(preset) || s.title || 'Agent';

    candidates.push({
      id: s.id,
      sessionId: s.id,
      name,
      preset,
      displayName: `${name} (${isChat ? 'Chat' : 'Terminal'})`,
      isChatView: isChat,
      isDev,
      lastActivatedAt: s.lastActivatedAt ?? 0,
    });
  }

  // Sort candidates:
  // Active/focused session first, then most recently activated.
  const activeId = get(manualPromptTargetId) ?? get(activeSessionId) ?? get(devActiveSessionId);
  return candidates.sort((a, b) => {
    if (a.id === activeId) return -1;
    if (b.id === activeId) return 1;
    return b.lastActivatedAt - a.lastActivatedAt;
  });
}

export function resolveDefaultTarget(targets: AgentTarget[]): AgentTarget | null {
  if (!targets || targets.length === 0) return null;
  if (targets.length === 1) return targets[0];

  const activeId = get(manualPromptTargetId) ?? get(activeSessionId) ?? get(devActiveSessionId);
  if (activeId !== null) {
    const matched = targets.find((t) => t.id === activeId);
    if (matched) return matched;
  }

  return targets[0];
}

/** Quote a path only when it has spaces, with forward slashes. */
export function quoteTerminalPath(filePath: string): string {
  const norm = filePath.replace(/\\/g, '/');
  return norm.includes(' ') ? `"${norm}"` : norm;
}

/** Convert base64 data URL to bytes array for Tauri invoke. */
export function dataUrlToBytes(dataUrl: string): number[] {
  try {
    const base64 = dataUrl.split(',')[1] || '';
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return Array.from(bytes);
  } catch {
    return [];
  }
}

export type DispatchPromptOptions = {
  imageDataUrl?: string | null;
  imageName?: string | null;
};

export async function dispatchPromptToAgent(
  target: AgentTarget,
  promptText: string,
  options?: DispatchPromptOptions
): Promise<boolean> {
  // Never redirect visual context after its chosen destination closes.
  if (!getActiveAgentTargets().some((candidate) => candidate.sessionId === target.sessionId)) {
    throw new Error('The selected agent is no longer available. Choose another agent.');
  }
  const text = promptText.trim();
  const dataUrl = options?.imageDataUrl;
  const imageName = options?.imageName || `snapshot-${Date.now()}.png`;

  let savedPath: string | null = null;
  if (dataUrl) {
    try {
      const bytes = dataUrlToBytes(dataUrl);
      if (bytes.length > 0) {
        savedPath = await invoke<string>('save_pasted_image', {
          name: imageName,
          data: bytes,
        });
      }
    } catch {
      // If invoke fails (e.g. running outside Tauri or in tests), fallback gracefully
      savedPath = null;
    }
  }

  // Activate session
  if (target.isDev) devActiveSessionId.set(target.sessionId);
  else activeSessionId.set(target.sessionId);

  if (target.isChatView) {
    // Deliver to Chat UI (TerminalChatView)
    requestTerminalChatInput(
      target.sessionId,
      text,
      savedPath || dataUrl
        ? {
            path: savedPath || imageName,
            name: imageName,
            dataUrl: dataUrl ?? null,
          }
        : null
    );
    return true;
  } else {
    // Deliver to raw Terminal (TerminalPane)
    if (dataUrl) {
      promptBarImage.set({ dataUrl, name: imageName });
    }

    let fullText = text;
    if (savedPath) {
      const quoted = quoteTerminalPath(savedPath);
      fullText = `${quoted}\n\n${text}`;
    }

    requestTerminalInput(target.sessionId, fullText);
    return true;
  }
}
