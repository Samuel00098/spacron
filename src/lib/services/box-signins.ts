/**
 * Signed-in MCP connectors (Gmail, Drive, Notion, …) on a remote box.
 *
 * A connector you signed in to through Spacron is served by the desktop app's
 * proxy, which adds a fresh token to each request. Agents on a box reach that
 * proxy through the reverse tunnel, so it only works while this laptop is
 * connected. Sharing a sign-in with a box copies it there
 * (`remote_share_mcp_grants`, Rust to box directly; tokens never pass through
 * this UI), and the box's own proxy (`remote/box_proxy.rs`) serves it, so it
 * keeps working with the laptop closed: for bots and for agents you run there.
 *
 * Off by default, per connector and per box: it puts that account's sign-in on
 * the box.
 */
import { invoke } from '@tauri-apps/api/core';
import { get, writable } from '$lib/stores/storeCompat';
import { activeConnection, activeRemoteId, getRemoteToken, remoteTarget } from '$lib/stores/remoteWorkspace';
import { backendInvoke } from '$lib/services/backend';

const KEY = 'spacron_box_signins_v1';

/** Sign-in keys (`spacron-gmail`) shared with each box, by remote connection id. */
export const sharedSignIns = writable<Record<string, string[]>>(load());

/** What the connected box reports: its proxy address and what it holds. */
export interface BoxMcpInfo {
  proxyBase: string | null;
  token: string | null;
  shared: string[];
  /** The box's own MCP server (`spacron-box`): agents on the box, virtual desktop. */
  mcpUrl?: string | null;
  /** The box's operating system: `linux`, `macos` or `windows`. */
  os?: string;
  /** Where its desktop tools act: a `virtual` desktop (Linux) or the real `screen`. */
  desktop?: 'virtual' | 'screen' | 'none';
}
export const boxMcpInfo = writable<BoxMcpInfo | null>(null);

function load(): Record<string, string[]> {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, (v as unknown[]).filter((x): x is string => typeof x === 'string')]));
  } catch {
    return {};
  }
}

export function sharedWith(boxId: string | null | undefined): string[] {
  return boxId ? get(sharedSignIns)[boxId] ?? [] : [];
}

/** Ask the connected box where its proxy is and what it holds. */
export async function refreshBoxMcpInfo(): Promise<BoxMcpInfo | null> {
  if (!get(remoteTarget)) { boxMcpInfo.set(null); return null; }
  try {
    const info = await backendInvoke<BoxMcpInfo>('box_mcp_info');
    boxMcpInfo.set(info);
    return info;
  } catch {
    // An older box server without the sign-in proxy.
    boxMcpInfo.set(null);
    return null;
  }
}

/** Share exactly `keys` with the connected box (an empty list removes them all). */
export async function setSharedSignIns(keys: string[]): Promise<void> {
  const conn = get(activeConnection);
  const id = get(activeRemoteId);
  if (!conn || !id) throw new Error('Connect to the box first.');
  const token = await getRemoteToken(id);
  await invoke<number>('remote_share_mcp_grants', { url: conn.url, token, keys });
  const next = { ...get(sharedSignIns), [id]: [...new Set(keys)].sort() };
  localStorage.setItem(KEY, JSON.stringify(next));
  sharedSignIns.set(next);
  await refreshBoxMcpInfo();
}

/**
 * The box-side URL for a shared sign-in, for configs written to the box. Null
 * when it is not shared with the connected box or the box has no proxy.
 */
export function boxProxyUrl(key: string): string | null {
  const info = get(boxMcpInfo);
  if (!info?.proxyBase || !info.token || !info.shared.includes(key)) return null;
  return `${info.proxyBase}/${key}?token=${info.token}`;
}

/** The box's own tools as a server entry, for agents running on the box. */
export function boxToolsServer(): { id: string; name: string; transport: 'http'; url: string; enabled: true } | null {
  const url = get(boxMcpInfo)?.mcpUrl;
  return url ? { id: 'spacron-box', name: 'box', transport: 'http', url, enabled: true } : null;
}
