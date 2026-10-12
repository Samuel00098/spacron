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
