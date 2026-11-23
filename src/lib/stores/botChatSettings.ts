import { get } from '$lib/stores/storeCompat';
import {
  bool,
  chatAppearance,
  normalizeChatAppearance,
  persisted,
} from '$lib/stores/chatViewSettings';

/**
 * Settings > Bots > Chat: how a bot's chat looks and behaves. Modelled on the
 * agent chat settings (`chatViewSettings.ts`) and sharing their types, limits
 * and storage helper; only what the bot chat honours is here.
 */

/**
 * Font, size, width and contrast for bot chats. Until it is first changed it
 * starts from the agent chat's look (Settings > Chat), which is what bot chats
 * used before they had settings of their own.
 */
export const botChatAppearance = persisted(
  'spacron_bot_chat_appearance',
  normalizeChatAppearance(get(chatAppearance)),
  normalizeChatAppearance,
);

/**
 * Let bots answer with interactive visuals (charts, tables, small tools) shown
 * inline. Sent to the runner with each bot, because it changes what the bot is
 * told; only bots with file access can write the page.
 */
export const botChatVisuals = persisted('spacron_bot_chat_visuals', true, bool(true));

/** The time under each bot reply. */
export const botChatTimestamps = persisted('spacron_bot_chat_timestamps', false, bool(false));

/** Starter prompts in an empty bot chat. */
export const botChatSuggestedPrompts = persisted('spacron_bot_chat_suggested_prompts', true, bool(true));
