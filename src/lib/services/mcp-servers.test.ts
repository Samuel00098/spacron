import { describe, expect, it } from 'vitest';
import {
  codexTable,
  droidEntry,
  enabledServers,
  headersLostOnCodex,
  mergeMap,
  opencodeEntry,
  serverKey,
  standardEntry,
  validateServer,
  formatPairs,
  parseLines,
  parsePairs,
  type McpServer,
} from './mcp-servers';

function server(over: Partial<McpServer> = {}): McpServer {
  return { id: 'a', name: 'Linear', transport: 'http', url: 'https://mcp.linear.app/mcp', enabled: true, ...over };
}

describe('serverKey', () => {
  it('namespaces and slugs the name', () => {
    expect(serverKey({ name: 'Linear' })).toBe('spacron-linear');
    expect(serverKey({ name: 'My Server 2' })).toBe('spacron-my-server-2');
    expect(serverKey({ name: '  Sentry.io  ' })).toBe('spacron-sentry-io');
  });

  it('never produces a bare prefix for a name with nothing usable in it', () => {
    expect(serverKey({ name: '///' })).toBe('spacron-server');
  });
});

describe('validateServer', () => {
  it('accepts a remote server and a local one', () => {
    expect(validateServer(server())).toBeNull();
    expect(validateServer(server({ transport: 'stdio', command: 'npx', url: undefined }))).toBeNull();
  });

  it('refuses a name that would collide with Spacron\'s own entries', () => {
    expect(validateServer(server({ name: 'mcp' }))).toContain('Spacron uses');
    expect(validateServer(server({ name: 'playwright' }))).toContain('Spacron uses');
  });

  it('refuses two servers that slug to the same config key', () => {
    const existing = server({ id: 'a', name: 'My Server' });
    const clash = server({ id: 'b', name: 'my  server' });
    expect(validateServer(clash, [existing, clash])).toContain('already uses the name');
  });

  it('refuses a URL that is not http(s)', () => {
    expect(validateServer(server({ url: 'ftp://x/y' }))).toContain('http://');
    expect(validateServer(server({ url: 'not a url' }))).toContain('valid URL');
    expect(validateServer(server({ url: '' }))).toContain('server URL');
  });

  it('refuses a local server with no command', () => {
    expect(validateServer(server({ transport: 'stdio', command: '  ' }))).toContain('command');
  });
});

describe('enabledServers', () => {
  it('skips disabled and invalid rows rather than writing a broken config', () => {
    const list = [
      server({ id: 'a', name: 'Good' }),
      server({ id: 'b', name: 'Off', enabled: false }),
      server({ id: 'c', name: 'Broken', url: 'nonsense' }),
    ];
    expect(enabledServers(list).map((e) => e.key)).toEqual(['spacron-good']);
  });

  it('never lets a user server claim a reserved key', () => {
    expect(enabledServers([server({ name: 'mcp' })])).toEqual([]);
  });
});

describe('per-dialect entries', () => {
  it('writes the shared mcpServers shape for remote and local', () => {
    expect(standardEntry(server({ headers: { Authorization: 'Bearer t' } }))).toEqual({
      type: 'http',
      url: 'https://mcp.linear.app/mcp',
      headers: { Authorization: 'Bearer t' },
    });
    expect(standardEntry(server({ transport: 'stdio', command: 'npx', args: ['-y', 'pkg'], url: undefined }))).toEqual({
      command: 'npx',
      args: ['-y', 'pkg'],
    });
  });

  it('omits an empty header map instead of writing headers: {}', () => {
    expect(standardEntry(server({ headers: {} }))).not.toHaveProperty('headers');
    expect(standardEntry(server({ headers: { '  ': 'x' } }))).not.toHaveProperty('headers');
  });

  it('gives droid its explicit disabled flag', () => {
    expect(droidEntry(server())).toMatchObject({ type: 'http', disabled: false });
  });

  it('uses opencode\'s own transport names and flat argv', () => {
    expect(opencodeEntry(server())).toEqual({
      type: 'remote',
      url: 'https://mcp.linear.app/mcp',
      enabled: true,
    });
    expect(opencodeEntry(server({ transport: 'stdio', command: 'npx', args: ['-y', 'pkg'], url: undefined }))).toEqual({
      type: 'local',
      command: ['npx', '-y', 'pkg'],
      enabled: true,
    });
  });
});

describe('codexTable', () => {
  it('writes a remote server as a url table', () => {
    expect(codexTable('spacron-linear', server())).toBe(
      '[mcp_servers.spacron-linear]\nurl = "https://mcp.linear.app/mcp"\n',
    );
  });

  it('writes a local server as command and args', () => {
    expect(codexTable('spacron-x', server({ transport: 'stdio', command: 'npx', args: ['-y', 'pkg'], url: undefined })))
      .toBe('[mcp_servers.spacron-x]\ncommand = "npx"\nargs = ["-y", "pkg"]\n');
  });

  it('escapes a quote so one bad value cannot break the whole file', () => {
    const table = codexTable('spacron-x', server({ transport: 'stdio', command: 'a"b', url: undefined }));
    expect(table).toContain('command = "a\\"b"');
  });

  it('reports the headers Codex cannot express', () => {
    expect(headersLostOnCodex(server({ headers: { Authorization: 'Bearer t' } }))).toBe(true);
    expect(headersLostOnCodex(server())).toBe(false);
    expect(headersLostOnCodex(server({ transport: 'stdio', command: 'x', url: undefined }))).toBe(false);
  });
});

describe('mergeMap', () => {
  it('writes wanted servers and deletes our stale ones', () => {
    const map = mergeMap([server({ name: 'Linear' })], ['spacron-linear', 'spacron-deleted'], standardEntry);
    expect(map['spacron-linear']).toMatchObject({ type: 'http' });
    expect(map['spacron-deleted']).toBeNull();
  });

  it('never touches a key outside our namespace', () => {
    const map = mergeMap([], ['linear', 'playwright', 'my-own-thing'], standardEntry);
    expect(map).toEqual({});
  });

  it('never deletes Spacron\'s own entries while pruning', () => {
    const map = mergeMap([], ['spacron-mcp', 'spacron-playwright'], standardEntry);
    expect(map).toEqual({});
  });

  it('drops a renamed server\'s old key and adds the new one', () => {
    const map = mergeMap([server({ name: 'Linear v2' })], ['spacron-linear'], standardEntry);
    expect(map['spacron-linear']).toBeNull();
    expect(map['spacron-linear-v2']).toMatchObject({ type: 'http' });
  });

  it('removes a server the user switched off', () => {
    const map = mergeMap([server({ name: 'Linear', enabled: false })], ['spacron-linear'], standardEntry);
    expect(map['spacron-linear']).toBeNull();
  });
});

describe('form text parsing', () => {
  it('keeps everything after the first separator, spaces and all', () => {
    expect(parsePairs('Authorization: Bearer a b c', ':')).toEqual({ Authorization: 'Bearer a b c' });
    expect(parsePairs('X-Key: v: with: colons', ':')).toEqual({ 'X-Key': 'v: with: colons' });
    expect(parsePairs('TOKEN=a=b', '=')).toEqual({ TOKEN: 'a=b' });
  });

  it('ignores blank lines, comments and lines with no key', () => {
    expect(parsePairs(['', '# a comment', ': novalue', 'A: 1', ''].join('\n'), ':')).toEqual({ A: '1' });
  });

  it('round-trips through the editor', () => {
    const map = { Authorization: 'Bearer t', 'X-Api-Key': 'k' };
    expect(parsePairs(formatPairs(map, ':'), ':')).toEqual(map);
  });

  it('treats each argument line as one argument, spaces included', () => {
    expect(parseLines(['--config', 'C:/my path/cfg.json', '', ''].join('\n')))
      .toEqual(['--config', 'C:/my path/cfg.json']);
  });
});
