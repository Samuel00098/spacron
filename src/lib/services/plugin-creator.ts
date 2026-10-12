/**
 * The Plugin Creator: Spacron's own plugin for making plugins.
 *
 * Installed like any plugin, its one skill lands in Claude Code's and Codex's
 * skill folders, so any of those agents can build a plugin when asked. The
 * same instructions drive Settings > MCP > Add > Create plugin, which
 * scaffolds the folder and hands the rest to the chat.
 *
 * The layout it teaches is the Claude Code plugin layout, which Codex reads
 * too and which `commands/plugins.rs` installs, so a plugin made here works in
 * all three.
 */
import { invoke } from '@tauri-apps/api/core';
import type { PluginSummary } from './plugins';
import SKILL_TEXT from './plugin-creator-skill.md?raw';

export const PLUGIN_CREATOR_ID = 'plugin-creator';

// One source for the instructions: Spacron's MCP server serves the same file
// to every agent through its `plugin_creator_guide` tool (`include_str!`).
const SKILL = SKILL_TEXT;

/** The Plugin Creator's tile: a spark on Spacron's accent. */
export const PLUGIN_CREATOR_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#6d5dfc"/>' +
  '<path d="M32 13l5.6 13.4L51 32l-13.4 5.6L32 51l-5.6-13.4L13 32l13.4-5.6z" fill="#fff"/></svg>\n';

const FILES: Record<string, string> = {
  '.claude-plugin/plugin.json': `${JSON.stringify(
    {
      name: PLUGIN_CREATOR_ID,
      displayName: 'Plugin Creator',
      version: '1.0.0',
      description: 'Lets any agent build plugins: MCP servers and skills packaged for Spacron, Claude Code and Codex.',
      author: { name: 'Spacron' },
      skills: './skills/',
      interface: { composerIcon: './assets/icon.svg' },
    },
    null,
    2,
  )}\n`,
  'skills/plugin-creator/SKILL.md': SKILL,
  'assets/icon.svg': PLUGIN_CREATOR_ICON,
  'README.md': '# Plugin Creator\n\nSpacron\'s built-in plugin for building plugins. Ask any agent to "create a plugin that…".\n',
};

/** Write the Plugin Creator to disk and read it back, ready to install. */
export function writePluginCreator(): Promise<PluginSummary> {
  return invoke<PluginSummary>('plugin_write_builtin', { id: PLUGIN_CREATOR_ID, files: FILES });
}

/** The chat request that builds a freshly scaffolded plugin. */
export function buildPluginRequest(name: string, folder: string, goal: string): string {
  return [
    `Build the plugin "${name}". I scaffolded it at ${folder}.`,
    goal.trim() ? `What it should do: ${goal.trim()}` : '',
    'Follow these plugin rules exactly:',
    SKILL.replace(/^---[\s\S]*?---\s*/, ''),
  ]
    .filter(Boolean)
    .join('\n\n');
}
