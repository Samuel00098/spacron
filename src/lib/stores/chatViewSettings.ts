import { writable, type Writable } from '$lib/stores/storeCompat';

/**
 * Settings > Chat: how an agent terminal's chat view (`TerminalChatView`)
 * looks and behaves. Modelled on Orca's chat settings (appearance + behaviour);
 * only settings the view actually honours live here.
 *
 * Which view a new agent opens in is `agentLaunchView` in
 * `services/terminal-chat.ts`, shown in the same tab.
 */

/** `app`, `system` and `terminal` follow those fonts; anything else names an installed font family. */
export type ChatFontChoice = 'app' | 'system' | 'terminal' | (string & {});

/** A font family name safe to put in CSS, or null. */
export function cleanFontFamily(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.replace(/["'`;{}<>\\]/g, '').trim();
  return name.length > 0 && name.length <= 120 ? name : null;
}
export type ChatWidth = 'comfortable' | 'wide' | 'full';

export interface ChatAppearance {
  font: ChatFontChoice;
  /** px, or null to follow the app's UI font size. */
  fontSize: number | null;
  /** px, for code blocks, inline code, commands and tool output. */
  codeFontSize: number;
  width: ChatWidth;
  /** Use the terminal's font and colours for the whole chat. */
  matchTerminal: boolean;
  /** How bright text is against the background: 100 is the theme as is. */
  contrast: number;
}

export const CHAT_FONT_SIZE_RANGE = { min: 11, max: 20 } as const;
export const CHAT_CODE_FONT_SIZE_RANGE = { min: 10, max: 18 } as const;
export const CHAT_CONTRAST_RANGE = { min: 70, max: 130 } as const;
export const DEFAULT_CHAT_APPEARANCE: ChatAppearance = {
  font: 'app',
  fontSize: null,
  codeFontSize: 12,
  width: 'comfortable',
  matchTerminal: false,
  contrast: 100,
};

/** Thread and composer column for each width choice. */
export const CHAT_WIDTH_COLUMN: Record<ChatWidth, string> = {
  comfortable: '760px',
  wide: '1040px',
  full: '100%',
};

function clampInt(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value)))
    : null;
}

/** Saved settings are untrusted (hand-edited, older versions): keep what is valid. */
export function normalizeChatAppearance(value: unknown): ChatAppearance {
  const v = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return {
    font: cleanFontFamily(v.font) ?? 'app',
    fontSize: clampInt(v.fontSize, CHAT_FONT_SIZE_RANGE.min, CHAT_FONT_SIZE_RANGE.max),
    codeFontSize:
      clampInt(v.codeFontSize, CHAT_CODE_FONT_SIZE_RANGE.min, CHAT_CODE_FONT_SIZE_RANGE.max)
      ?? DEFAULT_CHAT_APPEARANCE.codeFontSize,
    width: v.width === 'wide' || v.width === 'full' ? v.width : 'comfortable',
    matchTerminal: v.matchTerminal === true,
    contrast: clampInt(v.contrast, CHAT_CONTRAST_RANGE.min, CHAT_CONTRAST_RANGE.max) ?? DEFAULT_CHAT_APPEARANCE.contrast,
  };
}

function persisted<T>(key: string, fallback: T, normalize: (raw: unknown) => T): Writable<T> {
  let initial = fallback;
  try {
    const raw = typeof window !== 'undefined' ? window.localStorage.getItem(key) : null;
    if (raw != null) initial = normalize(JSON.parse(raw));
  } catch {
    // Unreadable or restricted storage: defaults.
  }
  const store = writable<T>(initial);
  store.subscribe((value) => {
    try {
      if (typeof window !== 'undefined') window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Restricted storage: the choice lasts for this session only.
    }
  });
  return store;
}

const bool = (fallback: boolean) => (raw: unknown) => (typeof raw === 'boolean' ? raw : fallback);

export const chatAppearance = persisted('spacron_chat_appearance', DEFAULT_CHAT_APPEARANCE, normalizeChatAppearance);

/** Sending while scrolled up jumps to the latest message and follows the reply. */
export const chatScrollToLatestOnSend = persisted('spacron_chat_scroll_on_send', true, bool(true));

/** Browser spellcheck and autocorrect in the chat's message box. */
export const chatComposerSpellcheck = persisted('spacron_chat_spellcheck', true, bool(true));

/**
 * Whether newly launched agents get a folder for inline visuals
 * (`SPACRON_CHAT_VISUALS_DIR`). Applies to agents started after the change.
 */
export const chatInlineVisuals = persisted('spacron_chat_inline_visuals', true, bool(true));

/**
 * Messages sent while the agent is working wait in the chat as cards you can
 * edit, reorder or delete, and go in one at a time as each turn ends. Off
 * types them straight into the CLI, which queues or steers them itself.
 */
export const chatQueueFollowUps = persisted('spacron_chat_queue_follow_ups', true, bool(true));

/** A "New" line above messages that arrived while you were scrolled up or away. */
export const chatMarkNewMessages = persisted('spacron_chat_mark_new', true, bool(true));

/**
 * Name a new chat from its first message, so /history and the tab strip show
 * something recognisable. Off leaves the agent's own name until you rename it.
 */
export const chatAutoNames = persisted('spacron_chat_auto_names', true, bool(true));

/** The time beside each message. */
export const chatShowTimestamps = persisted('spacron_chat_timestamps', false, bool(false));

/** Hovering a web link in a reply shows a preview card (fetched from the linked site). */
export const chatLinkPreviews = persisted('spacron_chat_link_previews', true, bool(true));

/** Diff cards on edits, and the list of files each turn changed. */
export const chatTurnDiffs = persisted('spacron_chat_turn_diffs', true, bool(true));

/** Cards for pull requests a turn opened, with their CI checks (through `gh`). */
export const chatPullRequests = persisted('spacron_chat_pull_requests', true, bool(true));

/** When a usage limit stops the agent, send "continue" once the limit resets. */
export const chatUsageAutoContinue = persisted('spacron_chat_usage_auto_continue', false, bool(false));

/** Starter prompts in an empty chat. */
export const chatSuggestedPrompts = persisted('spacron_chat_suggested_prompts', true, bool(true));

/** A line in the chat when CI finishes on a pull request the agent opened. */
export const chatCiLines = persisted('spacron_chat_ci_lines', true, bool(true));

/**
 * Let a model rewrite the first-message name into a short title. Off by
 * default: it makes one small request to the configured AI provider per new
 * chat, which spends that provider's credits, so it is only ever opt-in.
 */
export const chatModelNames = persisted('spacron_chat_model_names', false, bool(false));
