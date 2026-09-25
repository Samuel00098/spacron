/**
 * The chat's side of the user's MCP servers (Settings > MCP): which servers
 * exist, and the calls into Spacron's MCP client (`commands/mcp_client.rs`).
 *
 * The model names a server by the name the user gave it. That name is looked
 * up here in the user's own list and the server's spec is sent from it, so a
 * model can only ever reach servers the user configured, never a command or
 * URL of its own choosing.
 */
import { invoke } from '@tauri-apps/api/core';
import { get } from '$lib/stores/storeCompat';
import { mcpServers } from '$lib/stores/settings';
import { enabledServers, serverKey, type McpServer } from '$lib/services/mcp-servers';
import { setMcpServerNames } from './brain-tools';

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: unknown;
  readOnly: boolean;
}

export interface McpCallResult {
  text: string;
  images: string[];
  isError: boolean;
}

function specOf(server: McpServer) {
  return {
    transport: server.transport,
    url: server.url,
    headers: server.headers,
    command: server.command,
    args: server.args,
    env: server.env,
  };
}

/** The enabled, valid servers, as the chat may use them. */
export function chatMcpServers(): McpServer[] {
  return enabledServers(get(mcpServers)).map((entry) => entry.server);
}

/** Find a server by the name the model used: exact, then case/slug-insensitive. */
export function findMcpServer(name: string): McpServer | null {
  const wanted = name.trim();
  if (!wanted) return null;
  const servers = chatMcpServers();
  return servers.find((s) => s.name === wanted)
    ?? servers.find((s) => s.name.toLowerCase() === wanted.toLowerCase())
    ?? servers.find((s) => serverKey(s) === serverKey({ name: wanted }))
    ?? null;
}

export function unknownServerMessage(name: string): string {
  const names = chatMcpServers().map((s) => `"${s.name}"`);
  return names.length
    ? `error: no MCP server named "${name}". Available: ${names.join(', ')}.`
    : 'error: the user has no MCP servers turned on (Settings > MCP).';
}

export function listMcpTools(server: McpServer): Promise<McpToolInfo[]> {
  return invoke<McpToolInfo[]>('mcp_client_list_tools', { serverId: server.id, spec: specOf(server) });
}

export function callMcpTool(server: McpServer, tool: string, args: Record<string, unknown>): Promise<McpCallResult> {
  return invoke<McpCallResult>('mcp_client_call_tool', { serverId: server.id, spec: specOf(server), tool, arguments: args });
}

/** Compact schema text for the model: property names, types and required. */
export function describeMcpTool(tool: McpToolInfo): string {
  const schema = (tool.inputSchema ?? {}) as { properties?: Record<string, { type?: unknown; description?: unknown }>; required?: unknown };
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  const props = Object.entries(schema.properties ?? {}).map(([key, p]) => {
    const type = Array.isArray(p?.type) ? p.type.join('|') : String(p?.type ?? 'any');
    const desc = typeof p?.description === 'string' ? ` - ${p.description.slice(0, 120)}` : '';
    return `    ${key}${required.has(key) ? ' (required)' : ''}: ${type}${desc}`;
  });
  return [
    `- ${tool.name}${tool.readOnly ? ' [read-only]' : ''}: ${tool.description.slice(0, 300)}`,
    ...(props.length ? props : ['    (no arguments)']),
  ].join('\n');
}

let knownIds = new Set<string>();

/**
 * Keep the chat's view of the servers current: the tool list and prompt name
 * them, and a server the user turned off or deleted has its connection closed
 * now rather than when it idles out.
 */
export function syncChatMcpServers(servers: McpServer[]): void {
  const enabled = enabledServers(servers).map((entry) => entry.server);
  setMcpServerNames(enabled.map((s) => s.name));
  const ids = new Set(enabled.map((s) => s.id));
  for (const id of knownIds) {
    if (!ids.has(id)) void invoke('mcp_client_close', { serverId: id }).catch(() => undefined);
  }
  knownIds = ids;
}
