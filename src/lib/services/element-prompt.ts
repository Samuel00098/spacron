/**
 * Turns an inspector selection into the text an agent can actually act on.
 *
 * Both inspectors already collect everything needed: `INSPECTOR_SNIPPET` in
 * `src-tauri/src/preview/mod.rs` (the one the proxy injects) and the inline
 * fallback in `PreviewPanel.tsx` both send `outerHTML`, computed styles,
 * attributes and the ancestor path across the bridge. The prompt builder used to
 * throw all of it away and emit `<button.primary> "Save"`, so the agent received
 * a screenshot of the element plus a twenty-character label — a picture of the
 * problem with nothing to edit. This module spends that payload.
 *
 * Kept out of the component so it can be tested directly, and because the two
 * inspector copies are already a drift hazard; one formatter for both is the
 * point.
 */

export type SelectedElementInfo = {
  selector: string;
  tag: string;
  text: string;
  html?: string;
  attributes?: Record<string, string>;
  classes?: string[];
  styles?: Record<string, string>;
  ancestorPath?: string[];
  page?: { url: string; title: string };
  rect: { x: number; y: number; width: number; height: number };
};

export type ElementPromptOptions = {
  /** Optional user prompt or instructions for the agent (Orca Design Mode prompt). */
  userInstructions?: string;
  /** Whether to include computed CSS styles (default: true). */
  includeStyles?: boolean;
  /** Whether to include the raw HTML snippet (default: true). */
  includeHtml?: boolean;
  /** Max length of the HTML snippet (default: 2000). */
  maxHtml?: number;
};

/** The inspector caps outerHTML at 3000; the prompt bar is a textarea a human
 *  also reads, so it gets a tighter budget. */
const MAX_HTML = 2000;
const MAX_TEXT = 200;
const MAX_ATTRS = 12;
const MAX_ATTR_VALUE = 80;
const MAX_STYLES = 14;

/** `class` is already in the selector and `style` duplicates the computed block;
 *  both are noise in a prompt. */
const SKIPPED_ATTRS = new Set(['class', 'style']);

/** Computed styles come back as an unordered map whose key order differs between
 *  the two inspectors. Emitting a stable, layout-first order keeps the prompt
 *  diff-able and puts the properties that usually explain a visual bug first. */
const STYLE_ORDER = [
  'display',
  'position',
  'width',
  'height',
  'margin',
  'padding',
  'color',
  'backgroundColor',
  'background-color',
  'font',
  'fontSize',
  'font-size',
  'fontWeight',
  'font-weight',
  'border',
  'borderRadius',
  'border-radius',
  'flexDirection',
  'flex-direction',
  'gap',
  'zIndex',
  'z-index',
  'opacity',
  'overflow',
];

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** camelCase keys (what `getComputedStyle` hands back by property access) read
 *  oddly next to CSS; normalise so the agent sees what it would type. */
function toCssProperty(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

function orderedStyles(styles: Record<string, string>): [string, string][] {
  const present = Object.entries(styles).filter(([, v]) => typeof v === 'string' && v.trim() !== '');
  const rank = new Map(STYLE_ORDER.map((k, i) => [k, i]));
  present.sort(([a], [b]) => {
    const ra = rank.get(a) ?? Number.MAX_SAFE_INTEGER;
    const rb = rank.get(b) ?? Number.MAX_SAFE_INTEGER;
    return ra === rb ? a.localeCompare(b) : ra - rb;
  });
  // De-duplicate the camelCase/kebab-case pairs above — an inspector sends one
  // spelling or the other, never both, but a future one might send each.
  const seen = new Set<string>();
  const out: [string, string][] = [];
  for (const [key, value] of present) {
    const css = toCssProperty(key);
    if (seen.has(css)) continue;
    seen.add(css);
    out.push([css, value.trim()]);
    if (out.length >= MAX_STYLES) break;
  }
  return out;
}

/**
 * Build the prompt text for a picked element. The cropped screenshot is attached
 * separately by the caller — this is only the part the agent can read as code.
 *
 * Supports optional Orca Design Mode options to prepend user instructions,
 * toggle computed styles, and toggle or limit HTML snippet content.
 */
export function buildElementPrompt(info: SelectedElementInfo, options?: ElementPromptOptions): string {
  const tag = (info.tag || 'element').toLowerCase();
  const selector = info.selector?.trim() || tag;
  const lines: string[] = [];

  const instructions = options?.userInstructions?.trim();
  if (instructions) {
    lines.push(`Task: ${instructions}`);
    lines.push('');
  }

  const pageUrl = info.page?.url?.trim();
  lines.push(pageUrl ? `Selected \`${selector}\` on ${pageUrl}` : `Selected \`${selector}\``);
  lines.push('');

  const text = info.text?.trim();
  if (text) lines.push(`Text: "${truncate(text, MAX_TEXT)}"`);

  if (info.rect && (info.rect.width || info.rect.height)) {
    lines.push(`Box: ${Math.round(info.rect.width)}×${Math.round(info.rect.height)} px`);
  }

  const attrs = Object.entries(info.attributes || {})
    .filter(([k, v]) => !SKIPPED_ATTRS.has(k) && typeof v === 'string' && v.trim() !== '')
    .slice(0, MAX_ATTRS)
    .map(([k, v]) => `${k}="${truncate(v.trim(), MAX_ATTR_VALUE)}"`);
  if (attrs.length) lines.push(`Attributes: ${attrs.join(' ')}`);

  // `ancestorPath` is deliberately not emitted. The Rust inspector builds it by
  // calling buildSelector() on each ancestor, and buildSelector already walks up
  // four levels — so the entries are progressively longer copies of each other
  // and the last one is just `selector` again. `selector` already carries the
  // chain; printing the path too would be redundant noise in the prompt.

  const includeStyles = options?.includeStyles !== false;
  if (includeStyles) {
    const styles = orderedStyles(info.styles || {});
    if (styles.length) {
      lines.push('');
      lines.push('Computed styles:');
      for (const [prop, value] of styles) lines.push(`  ${prop}: ${value}`);
    }
  }

  const includeHtml = options?.includeHtml !== false;
  const maxHtml = options?.maxHtml ?? MAX_HTML;
  const html = info.html?.trim();
  if (includeHtml && html) {
    lines.push('');
    lines.push('```html');
    lines.push(truncate(html, maxHtml));
    lines.push('```');
  }

  return lines.join('\n');
}
