import { afterEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import { mcpServers } from '$lib/stores/settings';
import type { McpServer } from '$lib/services/mcp-servers';
import { activeBrainToolDefs, brainToolProfile, buildBrainToolsPrompt } from './brain-tools';
import { validateToolCall } from './agent-transport';
import { acpMcpServers, describeMcpTool, findMcpServer, syncChatMcpServers } from './mcp-client';

const server = (over: Partial<McpServer>): McpServer => ({
  id: 'a', name: 'Linear', transport: 'http', url: 'https://mcp.linear.app/mcp', enabled: true, ...over,
});

afterEach(() => {
  mcpServers.set([]);
  syncChatMcpServers([]);
  invoke.mockClear();
});

describe('chat MCP servers', () => {
  it('offers the MCP tools only while a server is on, and names the servers in the prompt', () => {
    syncChatMcpServers([server({ enabled: false })]);
    expect(activeBrainToolDefs().some((d) => d.name === 'mcp_call_tool')).toBe(false);
    expect(buildBrainToolsPrompt()).not.toContain('MCP LOOP');

    syncChatMcpServers([server({})]);
    expect(activeBrainToolDefs().map((d) => d.name)).toEqual(expect.arrayContaining(['mcp_list_tools', 'mcp_call_tool']));
    expect(buildBrainToolsPrompt()).toContain('"Linear"');
    expect(brainToolProfile('ask').allowed.has('mcp_call_tool')).toBe(true);
  });

  it('closes the connection of a server the user turned off', () => {
    syncChatMcpServers([server({}), server({ id: 'b', name: 'Docs' })]);
    syncChatMcpServers([server({})]);
    expect(invoke).toHaveBeenCalledWith('mcp_client_close', { serverId: 'b' });
    expect(invoke).not.toHaveBeenCalledWith('mcp_client_close', { serverId: 'a' });
  });

  it('finds a server only from the user list, by name, case or slug', () => {
    mcpServers.set([server({ name: 'My Linear' }), server({ id: 'x', name: 'Off', enabled: false })]);
    expect(findMcpServer('My Linear')?.id).toBe('a');
    expect(findMcpServer('my linear')?.id).toBe('a');
    expect(findMcpServer('my-linear')?.id).toBe('a');
    expect(findMcpServer('Off')).toBeNull();
    expect(findMcpServer('https://evil.example/mcp')).toBeNull();
  });

  it('describes a tool schema compactly for the model', () => {
    const text = describeMcpTool({
      name: 'create_issue',
      description: 'Create an issue',
      readOnly: false,
      inputSchema: { type: 'object', properties: { title: { type: 'string', description: 'Title' }, labels: { type: ['array', 'null'] } }, required: ['title'] },
    });
    expect(text).toBe('- create_issue: Create an issue\n    title (required): string - Title\n    labels: array|null');
  });

  it('converts enabled stdio and remote servers for ACP sessions', async () => {
    const servers = [
      server({ name: 'Local', transport: 'stdio', command: 'my-mcp', args: ['--safe'], env: { TOKEN: 'x' } }),
      server({ name: 'Remote', transport: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'test-token' } }),
    ];
    mcpServers.set(servers);
    syncChatMcpServers(servers);
    await expect(acpMcpServers()).resolves.toEqual([
      { name: 'Local', command: 'my-mcp', args: ['--safe'], env: [{ name: 'TOKEN', value: 'x' }] },
      { type: 'http', name: 'Remote', url: 'https://example.test/mcp', headers: [{ name: 'Authorization', value: 'test-token' }] },
    ]);
  });

  it('accepts tool arguments as an object or as JSON text', () => {
    const call = { id: '1', name: 'mcp_call_tool' as const, args: { server: 'Linear', tool: 't', arguments: '{"q":"bug"}' } as Record<string, unknown> };
    expect(validateToolCall(call)).toBeNull();
    expect(call.args.arguments).toEqual({ q: 'bug' });
    expect(validateToolCall({ id: '2', name: 'mcp_call_tool', args: { server: 'Linear', tool: 't', arguments: [1] } })).toContain('arguments');
    expect(validateToolCall({ id: '3', name: 'mcp_call_tool', args: { tool: 't' } })).toContain('server');
  });
});
