import { isTauriRuntime } from '$lib/utils/tauri';

/**
 * Where to send someone whose agent CLI isn't installed.
 *
 * The roster lists ~40 CLIs and most machines have a handful, so "Not
 * installed" is the most common row state in Settings → Agents. It used to be
 * a dead end: a grey badge naming a tool with no hint of where it comes from.
 *
 * ## The honesty rule for this file
 *
 * An entry here is a URL that was known to exist, not a guess assembled from
 * the vendor's name. A wrong link is worse than no link — it sends someone to a
 * parked domain or a stranger's repo and calls it "the install page". CLIs
 * without a verified home therefore get {@link searchUrlFor}, which lands on a
 * web search for that CLI's install instructions: it cannot be wrong about
 * where the docs are, because it doesn't claim to know.
 *
 * Keyed by launch command — the same join key as `AI_AGENT_PRESETS`
 * (`stores/runs.ts`), `BRANDS` (`agentBrands.tsx`) and the Rust `PROVIDERS`
 * detection table, so one CLI is one key everywhere.
 *
 * Every URL below was requested and answered on 2026-08-12. If you add one,
 * fetch it first.
 */
const INSTALL_DOCS: Record<string, string> = {
  claude: 'https://docs.claude.com/en/docs/claude-code/overview',
  // Fetched 2026-08-13: documents `npm install -g @qoder-ai/qodercli` and
  // verifying with `qodercli --version`, which is why the preset launches
  // `qodercli` rather than `qoder` (the desktop IDE).
  qodercli: 'https://docs.qoder.com/cli/installation',
  codex: 'https://github.com/openai/codex',
  gemini: 'https://github.com/google-gemini/gemini-cli',
  agy: 'https://antigravity.google/',
  opencode: 'https://opencode.ai/docs/',
  // The docs root, not a guessed `/docs/cli` deep link: `docs.cursor.com/**`
  // 308s here, which is the only Cursor URL confirmed to exist.
  'cursor-agent': 'https://cursor.com/docs',
  copilot: 'https://github.com/github/copilot-cli',
  droid: 'https://docs.factory.ai/',
  cody: 'https://sourcegraph.com/docs/cody',
  qwen: 'https://github.com/QwenLM/qwen-code',
  cline: 'https://docs.cline.bot/',
  amp: 'https://ampcode.com/',
  goose: 'https://block.github.io/goose/',
  crush: 'https://github.com/charmbracelet/crush',
  aider: 'https://aider.chat/docs/install.html',
  kimi: 'https://github.com/MoonshotAI/kimi-cli',
  'kiro-cli': 'https://kiro.dev/',
  auggie: 'https://docs.augmentcode.com/',
  codebuff: 'https://www.codebuff.com/',
  freebuff: 'https://github.com/freebuff/freebuff',
  cn: 'https://docs.continue.dev/',
  kilo: 'https://kilocode.ai/',
  devin: 'https://docs.devin.ai/',
};

/** A web search for this CLI's install instructions — the honest fallback. */
function searchUrlFor(name: string, command: string): string {
  const query = `${name || command} coding CLI install`;
  return `https://duckduckgo.com/?q=${encodeURIComponent(query)}`;
}

/**
 * The page to open for an agent, and whether it is that agent's own
 * documentation or a search standing in for one. Callers use `known` to word
 * the affordance honestly — "Install guide" vs "Find install steps".
 */
export function installDocsFor(
  command: string,
  name: string
): { url: string; known: boolean } {
  const url = INSTALL_DOCS[command.trim().toLowerCase()];
  if (url) return { url, known: true };
  return { url: searchUrlFor(name, command), known: false };
}

/**
 * Open an agent's install page.
 *
 * Routed through the in-app preview panel in the desktop build, like every
 * other outbound link in Spacron (`services/changelog.ts` does the same) — a
 * vendor's docs page opened in the user's default browser loses the context
 * they were in, and Tauri has no window to fall back to otherwise.
 */
export async function openAgentInstallDocs(command: string, name: string): Promise<void> {
  const { url } = installDocsFor(command, name);
  if (!isTauriRuntime()) {
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }
  const { openUrlInPreviewPanel } = await import('$lib/stores/preview');
  await openUrlInPreviewPanel(url);
}
