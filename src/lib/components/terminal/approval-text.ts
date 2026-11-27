/**
 * What a permission request is asking, in readable parts. Agents word it
 * differently: Grok sends "Write `C:\…\a.txt`" with the detail "edit", Claude
 * "Claude wants to use Write" with the path as detail, Antigravity
 * "File a.txt" with "edit".
 */
export interface ApprovalText {
  /** The action, e.g. "Write". */
  action: string;
  /** The file or command it applies to, shortened against the chat's folder. */
  target: string | null;
  /** The unshortened target, for a tooltip. */
  fullTarget: string | null;
}

/** ACP tool kinds: a bare one says nothing the title doesn't. */
const KIND_WORDS = new Set(['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'other']);

function shorten(target: string, cwd: string | null): string {
  if (!cwd) return target;
  const flat = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const root = flat(cwd);
  return flat(target).startsWith(`${root}/`) ? target.slice(root.length + 1) : target;
}

export function approvalText(title: string, detail: string | null | undefined, cwd: string | null = null): ApprovalText {
  const quoted = /`([^`]+)`/.exec(title);
  const extra = detail?.trim() && !KIND_WORDS.has(detail.trim().toLowerCase()) ? detail.trim() : null;
  const full = quoted?.[1] ?? extra;
  const action = title
    .replace(/`[^`]*`/, ' ')
    .replace(/^.*\bwants to use\b/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    action: action || 'Run this action',
    target: full ? shorten(full, cwd) : null,
    fullTarget: full,
  };
}
