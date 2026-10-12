import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const { fillVariables, marketplaceId, pluginServerRow } = await import('./plugins');

describe('plugin servers', () => {
  it('reads every transport spelling plugins use', () => {
    expect(pluginServerRow('p', 'a', { type: 'http', url: 'https://a.dev/mcp' }, 'a')).toMatchObject({ transport: 'http', url: 'https://a.dev/mcp', pluginId: 'p' });
    expect(pluginServerRow('p', 'b', { type: 'streamable-http', url: 'https://b.dev/mcp' }, 'b')?.transport).toBe('http');
    expect(pluginServerRow('p', 'c', { type: 'sse', url: 'https://c.dev/sse' }, 'c')?.transport).toBe('sse');
    expect(pluginServerRow('p', 'd', { serverUrl: 'https://d.dev/mcp' }, 'd')?.url).toBe('https://d.dev/mcp');
    expect(pluginServerRow('p', 'e', { command: 'npx', args: ['-y', 'x@1'], env: { A: '1' } }, 'e')).toMatchObject({
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'x@1'],
      env: { A: '1' },
    });
    expect(pluginServerRow('p', 'f', { type: 'http' }, 'f')).toBeNull();
  });

  it('drops headers left empty by a ${VAR:-} default', () => {
    const row = pluginServerRow('p', 'a', { type: 'http', url: 'https://a.dev', headers: { Authorization: '', X: 'y' } }, 'a');
    expect(row?.headers).toEqual({ X: 'y' });
  });

  it('fills the user\'s values into placeholders, leaving unknown ones', () => {
    const spec = { headers: { Authorization: 'Bearer ${TOKEN}' }, args: ['${env:HOST}/x', '${OTHER}'] };
    expect(fillVariables(spec, { TOKEN: 't', HOST: 'h' })).toEqual({
      headers: { Authorization: 'Bearer t' },
      args: ['h/x', '${OTHER}'],
    });
  });

  it('gives a marketplace a stable id however its source is written', () => {
    expect(marketplaceId('anthropics/claude-plugins-official')).toBe('anthropics-claude-plugins-official');
    expect(marketplaceId('https://github.com/Anthropics/claude-plugins-official.git')).toBe('anthropics-claude-plugins-official');
  });
});

describe('marketplace groups', () => {
  it('maps both marketplaces\' categories onto the catalog groups', async () => {
    const { pluginGroup } = await import('./plugins');
    const expected: Record<string, string> = {
      // Claude's slugs
      development: 'developer', database: 'databases', monitoring: 'monitoring', security: 'security',
      deployment: 'cloud', design: 'design', productivity: 'productivity', automation: 'productivity',
      learning: 'docs', testing: 'developer', migration: 'developer', location: 'design', math: 'docs',
      // Codex's titles
      'Developer Tools': 'developer', Productivity: 'productivity', Creativity: 'design', Communication: 'productivity',
      'Education & Research': 'docs', 'Data & Analytics': 'databases', Finance: 'payments',
      'Business & Operations': 'productivity', 'Scientific Research': 'docs', Security: 'security',
    };
    for (const [category, group] of Object.entries(expected)) expect(pluginGroup(category), category).toBe(group);
    expect(pluginGroup(null)).toBe('other');
  });
});

describe('marketplace installed state', () => {
  it('counts a plugin as installed from any route', async () => {
    const { isPluginInstalled } = await import('./plugins');
    const plugin = { id: 'linear', name: 'linear' } as never;
    expect(isPluginInstalled('linear', [plugin], [])).toBe(true);
    expect(isPluginInstalled('linear', [], [{ id: 'a', name: 'Linear', transport: 'http', url: 'https://mcp.linear.app/mcp', enabled: true }])).toBe(true);
    expect(isPluginInstalled('stripe', [plugin], [])).toBe(false);
  });
});
