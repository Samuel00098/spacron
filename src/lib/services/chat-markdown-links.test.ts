import { describe, expect, it } from 'vitest';
import {
  CHAT_MARKDOWN_URI_REGEXP,
  parseChatFileLink,
  resolveChatFilePath,
} from './chat-markdown-links';

describe('CHAT_MARKDOWN_URI_REGEXP', () => {
  it('allows relative paths, file URIs, Windows paths, and filename:line links', () => {
    const allowed = [
      '.github/workflows/release.yml',
      './src/main.ts',
      'src/lib/app.ts#L10-L20',
      'src/lib/app.ts:42',
      'release.yml:42',
      'release.yml:42:5',
      'file:///C:/Users/SMIDS%20MAN/repo/.github/workflows/release.yml',
      'file:///home/user/repo/README.md#L5',
      'C:/Users/SMIDS%20MAN/repo/.github/workflows/release.yml',
      'C:\\Users\\repo\\file.ts',
      'https://github.com/org/repo',
      'mailto:test@example.com',
      '#heading',
    ];
    for (const uri of allowed) {
      expect(CHAT_MARKDOWN_URI_REGEXP.test(uri), uri).toBe(true);
    }
  });

  it('continues blocking unsafe URI schemes', () => {
    const blocked = [
      'javascript:alert(1)',
      'JAVASCRIPT:123',
      'vbscript:msgbox(1)',
      'data:text/html,<script>alert(1)</script>',
      'blob:https://example.com/123',
      'custom.scheme:alert(1)',
    ];
    for (const uri of blocked) {
      expect(CHAT_MARKDOWN_URI_REGEXP.test(uri), uri).toBe(false);
    }
  });
});

describe('parseChatFileLink', () => {
  it('parses relative and repo-relative file paths', () => {
    expect(parseChatFileLink('.github/workflows/release.yml')).toEqual({
      path: '.github/workflows/release.yml',
    });
    expect(parseChatFileLink('./src/app.ts#L15-L30')).toEqual({
      path: './src/app.ts',
      line: 15,
    });
    expect(parseChatFileLink('src/app.ts:42:7')).toEqual({
      path: 'src/app.ts',
      line: 42,
    });
    expect(parseChatFileLink('release.yml:12')).toEqual({
      path: 'release.yml',
      line: 12,
    });
  });

  it('parses file:// URIs on Windows and Unix with percent-encoded spaces and line numbers', () => {
    expect(
      parseChatFileLink('file:///c:/Users/SMIDS%20MAN/Documents/spacron/.github/workflows/release.yml'),
    ).toEqual({
      path: 'c:/Users/SMIDS MAN/Documents/spacron/.github/workflows/release.yml',
    });

    expect(
      parseChatFileLink('file:///C:/Users/dev/notes.md#L10-L20'),
    ).toEqual({
      path: 'C:/Users/dev/notes.md',
      line: 10,
    });

    expect(
      parseChatFileLink('file://C:/Users/dev/notes.md:25'),
    ).toEqual({
      path: 'C:/Users/dev/notes.md',
      line: 25,
    });

    expect(
      parseChatFileLink('file://localhost/home/dev/app.ts#L8'),
    ).toEqual({
      path: '/home/dev/app.ts',
      line: 8,
    });
  });

  it('parses bare Windows and Unix absolute paths', () => {
    expect(parseChatFileLink('C:/Users/SMIDS%20MAN/repo/file.ts:9')).toEqual({
      path: 'C:/Users/SMIDS MAN/repo/file.ts',
      line: 9,
    });
    expect(parseChatFileLink('/Users/dev/repo/file.ts#L4')).toEqual({
      path: '/Users/dev/repo/file.ts',
      line: 4,
    });
  });

  it('ignores web URLs, mailto, unsafe schemes, and bare hash anchors', () => {
    expect(parseChatFileLink('https://example.com/a/b')).toBeNull();
    expect(parseChatFileLink('http://localhost:3000')).toBeNull();
    expect(parseChatFileLink('mailto:dev@example.com')).toBeNull();
    expect(parseChatFileLink('javascript:alert(1)')).toBeNull();
    expect(parseChatFileLink('data:text/plain,hello')).toBeNull();
    expect(parseChatFileLink('#section-1')).toBeNull();
    expect(parseChatFileLink('')).toBeNull();
  });
});

describe('resolveChatFilePath', () => {
  it('resolves relative and Windows leading-slash paths against the session root', () => {
    expect(resolveChatFilePath('C:\\Users\\dev\\spacron', '.github/workflows/release.yml')).toBe(
      'C:\\Users\\dev\\spacron/.github/workflows/release.yml',
    );
    expect(resolveChatFilePath('C:\\Users\\dev\\spacron', './src/main.ts')).toBe(
      'C:\\Users\\dev\\spacron/src/main.ts',
    );
    expect(resolveChatFilePath('C:\\Users\\dev\\spacron', '/.github/workflows/release.yml')).toBe(
      'C:\\Users\\dev\\spacron/.github/workflows/release.yml',
    );
    expect(resolveChatFilePath('C:\\Users\\dev\\spacron', 'C:/Users/dev/other.ts')).toBe(
      'C:/Users/dev/other.ts',
    );
  });

  it('keeps absolute Unix paths untouched on Unix roots', () => {
    expect(resolveChatFilePath('/home/dev/spacron', '/etc/hosts')).toBe('/etc/hosts');
    expect(resolveChatFilePath('/home/dev/spacron', '.github/workflows/release.yml')).toBe(
      '/home/dev/spacron/.github/workflows/release.yml',
    );
  });
});
