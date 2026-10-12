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

  it('ships an icon file for every entry that names one', () => {
    for (const entry of MCP_CATALOG.filter((e) => e.icon)) {
      expect(existsSync(resolve(__dirname, '../../../static/mcp-icons', `${entry.icon}.svg`)), entry.id).toBe(true);
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

  it('finds the installed row by catalog id, not by name', () => {
    const linear = MCP_CATALOG.find((e) => e.id === 'linear')!;
    const handTyped = { ...catalogServer(linear), catalogId: undefined };
    expect(installedFrom(linear, [handTyped])).toBeUndefined();
    expect(installedFrom(linear, [catalogServer(linear)])).toBeDefined();
  });

  it('searches name, description and category', () => {
    const github = MCP_CATALOG.find((e) => e.id === 'github')!;
    expect(matchesCatalogQuery(github, 'git')).toBe(true);
    expect(matchesCatalogQuery(github, 'pull')).toBe(true);
    expect(matchesCatalogQuery(github, 'popular')).toBe(true);
    expect(matchesCatalogQuery(github, 'figma')).toBe(false);
  });
});
