import { describe, it, expect } from 'vitest';
import { fileUriToPath, isInsideRoot, resolveStartingCwd, samePath } from './paths';

describe('isInsideRoot', () => {
  it('matches a file directly inside the root', () => {
    expect(isInsideRoot('/work/proj/src/main.ts', '/work/proj')).toBe(true);
  });

  it('matches the root itself', () => {
    expect(isInsideRoot('/work/proj', '/work/proj')).toBe(true);
  });

  it('rejects a sibling that merely shares a prefix', () => {
    // Component-wise, not a raw string prefix.
    expect(isInsideRoot('/work/proj-evil/src/main.ts', '/work/proj')).toBe(false);
  });

  it('rejects a file in a different project', () => {
    expect(isInsideRoot('/work/other/src/main.ts', '/work/proj')).toBe(false);
  });

  it('compares Windows paths case- and separator-insensitively', () => {
    expect(isInsideRoot('C:\\Work\\Proj\\src\\main.ts', 'c:/work/proj')).toBe(true);
    expect(isInsideRoot('C:/Work/Proj/src/main.ts', 'C:\\Work\\Proj')).toBe(true);
  });

  it('tolerates trailing separators on the root', () => {
    expect(isInsideRoot('/work/proj/src/a.ts', '/work/proj/')).toBe(true);
  });

  it('is false when either side is missing', () => {
    expect(isInsideRoot(null, '/work/proj')).toBe(false);
    expect(isInsideRoot('/work/proj/a.ts', null)).toBe(false);
    expect(isInsideRoot('/work/proj/a.ts', '')).toBe(false);
  });
});

describe('resolveStartingCwd', () => {
  it('follows the active file directory when the file is in this project', () => {
    expect(resolveStartingCwd('/work/proj/src/main.ts', '/work/proj')).toBe('/work/proj/src');
  });

  it('ignores an active file belonging to a DIFFERENT project', () => {
    // The bug: `activeFile` is a single global slot, so a file left focused in
    // another project used to become this project's terminal cwd.
    expect(resolveStartingCwd('/work/other/src/main.ts', '/work/proj')).toBe('/work/proj');
  });

  it('ignores a prefix-sibling path', () => {
    expect(resolveStartingCwd('/work/proj-evil/a.ts', '/work/proj')).toBe('/work/proj');
  });

  it('falls back to the root when there is no active file', () => {
    expect(resolveStartingCwd(null, '/work/proj')).toBe('/work/proj');
  });

  it('returns the root for a file sitting directly at the root', () => {
    expect(resolveStartingCwd('/work/proj/README.md', '/work/proj')).toBe('/work/proj');
  });

  it('returns undefined when the project root is not known yet', () => {
    // Callers must treat this as "not ready" — spawning with no cwd makes the
    // backend reject with "No project is open", which is the blank-terminal bug.
    expect(resolveStartingCwd(null, null)).toBeUndefined();
    expect(resolveStartingCwd('/work/proj/a.ts', undefined)).toBeUndefined();
    expect(resolveStartingCwd(null, '   ')).toBeUndefined();
  });

  it('keeps Windows separators from the original file path', () => {
    expect(resolveStartingCwd('C:\\Work\\Proj\\src\\main.ts', 'C:\\Work\\Proj')).toBe('C:\\Work\\Proj\\src');
  });
});

describe('fileUriToPath', () => {
  it('converts a posix file URI', () => {
    expect(fileUriToPath('file:///home/u/a.ts')).toBe('/home/u/a.ts');
  });

  it('strips the leading slash from a Windows drive path', () => {
    expect(fileUriToPath('file:///C:/work/a.ts')).toBe('C:/work/a.ts');
  });

  it('percent-decodes spaces and other escapes', () => {
    expect(fileUriToPath('file:///work/my%20proj/a%2Bb.ts')).toBe('/work/my proj/a+b.ts');
  });

  it('passes through a value that is already a path', () => {
    expect(fileUriToPath('/work/a.ts')).toBe('/work/a.ts');
  });

  it('does not throw on malformed percent-encoding', () => {
    expect(() => fileUriToPath('file:///work/a%zz.ts')).not.toThrow();
  });
});

describe('samePath', () => {
  it('ignores separator style and case', () => {
    expect(samePath('C:\\Work\\a.ts', 'c:/work/a.ts')).toBe(true);
  });

  it('ignores a trailing separator', () => {
    expect(samePath('/work/proj/', '/work/proj')).toBe(true);
  });

  it('distinguishes different files', () => {
    expect(samePath('/work/a.ts', '/work/b.ts')).toBe(false);
    expect(samePath(null, '/work/a.ts')).toBe(false);
  });
});
