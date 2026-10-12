import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { MCP_CATALOG, MCP_CATEGORIES, catalogServer, installedFrom, matchesCatalogQuery } from './mcp-catalog';
import { RESERVED_KEYS, serverKey, validateServer } from './mcp-servers';

describe('MCP catalog', () => {
  it('installs into a valid server row for every entry', () => {
    for (const entry of MCP_CATALOG) {
      const server = catalogServer(entry, entry.auth === 'key' ? 'tok' : '');
      expect(validateServer(server), entry.id).toBeNull();
      expect(server.catalogId).toBe(entry.id);
    }
  });

  it('has unique ids and config keys, none of them reserved', () => {
    const ids = MCP_CATALOG.map((e) => e.id);
    const keys = MCP_CATALOG.map((e) => serverKey(e));
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(RESERVED_KEYS.has(key)).toBe(false);
  });

  it('only points at https endpoints, and every category is known', () => {
    const categories = new Set(MCP_CATEGORIES.map((c) => c.id));
    for (const entry of MCP_CATALOG) {
      expect(categories.has(entry.category), entry.id).toBe(true);
      if (entry.transport !== 'stdio') expect(entry.url, entry.id).toMatch(/^https:\/\//);
      if (entry.auth === 'key') expect(entry.key, entry.id).toBeDefined();
    }
  });

  it('ships the website icon every entry names', () => {
    const dir = resolve(__dirname, '../../../static/mcp-icons');
    for (const entry of MCP_CATALOG) {
      expect(entry.icon, entry.id).toBeDefined();
      expect(existsSync(resolve(dir, entry.icon!)), entry.id).toBe(true);
      expect(entry.homepage, entry.id).toMatch(/^https:\/\//);
    }
  });

  it('puts the pasted token in the header with its scheme', () => {
    const github = MCP_CATALOG.find((e) => e.id === 'github')!;
    expect(catalogServer(github, '  ghp_x  ').headers).toEqual({ Authorization: 'Bearer ghp_x' });
    const pagerduty = MCP_CATALOG.find((e) => e.id === 'pagerduty')!;
    expect(catalogServer(pagerduty, 'k').headers).toEqual({ Authorization: 'Token token=k' });
  });

  it('writes no headers for an entry that needs none', () => {
    const linear = MCP_CATALOG.find((e) => e.id === 'linear')!;
    expect(catalogServer(linear).headers).toBeUndefined();
  });

  it('prefers the row the catalog itself added', () => {
    const linear = MCP_CATALOG.find((e) => e.id === 'linear')!;
    const handTyped = { ...catalogServer(linear), id: 'hand', catalogId: undefined };
    const fromCatalog = catalogServer(linear);
    expect(installedFrom(linear, [handTyped, fromCatalog])).toBe(fromCatalog);
    expect(installedFrom(linear, [handTyped])).toBe(handTyped);
  });

  it('searches name, description and category', () => {
    const github = MCP_CATALOG.find((e) => e.id === 'github')!;
    expect(matchesCatalogQuery(github, 'git')).toBe(true);
    expect(matchesCatalogQuery(github, 'pull')).toBe(true);
    expect(matchesCatalogQuery(github, 'popular')).toBe(true);
    expect(matchesCatalogQuery(github, 'figma')).toBe(false);
  });
});

describe('sign-in proxy', () => {
  it('points a signed-in server at Spacron and drops its headers', async () => {
    const { withSignInProxy, signInProxyUrl } = await import('./mcp-servers');
    const linear = { ...catalogServer(MCP_CATALOG.find((e) => e.id === 'linear')!), oauth: true, headers: { A: 'b' } };
    const github = catalogServer(MCP_CATALOG.find((e) => e.id === 'github')!, 't');
    const url = 'http://127.0.0.1:51379/mcp?token=abc';
    const [proxied, untouched] = withSignInProxy([linear, github], url);
    expect(proxied.url).toBe('http://127.0.0.1:51379/proxy/spacron-linear?token=abc');
    expect(proxied.headers).toBeUndefined();
    expect(untouched).toBe(github);
    expect(withSignInProxy([linear], null)[0]).toBe(linear);
    expect(signInProxyUrl('http://127.0.0.1:1/mcp', 'k')).toBe('http://127.0.0.1:1/proxy/k');
  });
});

describe('installed anywhere counts as installed', () => {
  it('sees a catalog server that a plugin or a hand-added row already provides', () => {
    const context7 = MCP_CATALOG.find((e) => e.id === 'context7')!;
    const fromPlugin = { id: 'x', name: 'context7-plugin', transport: 'http' as const, url: 'https://mcp.context7.com/mcp?client=claude-code-plugin', enabled: true, pluginId: 'context7' };
    expect(installedFrom(context7, [fromPlugin])).toBe(fromPlugin);
    const byHand = { id: 'y', name: 'Linear', transport: 'http' as const, url: 'https://example.com/other', enabled: true };
    expect(installedFrom(MCP_CATALOG.find((e) => e.id === 'linear')!, [byHand])).toBe(byHand);
    expect(installedFrom(context7, [byHand])).toBeUndefined();
  });
});

describe('one icon per service everywhere', () => {
  it('gives a marketplace plugin or a server the catalog tile for the same service', async () => {
    const { catalogIconFor } = await import('./mcp-catalog');
    expect(catalogIconFor('linear')).toBe('/mcp-icons/linear.png');
    expect(catalogIconFor('Hugging Face')).toBe('/mcp-icons/huggingface.ico');
    expect(catalogIconFor('anything', 'https://mcp.context7.com/mcp?client=claude-code-plugin')).toBe('/mcp-icons/context7.png');
    expect(catalogIconFor('not-a-catalog-service')).toBeUndefined();
  });
});
