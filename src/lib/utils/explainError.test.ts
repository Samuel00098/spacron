import { describe, expect, it } from 'vitest';
import { explainError } from './explainError';

const CODEX_EBUSY = `npm error code EBUSY
npm error syscall copyfile
npm error path C:\Users\me\AppData\Roaming\npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe
npm error errno -4082
npm error EBUSY: resource busy or locked, copyfile 'C:\...\codex.exe' -> 'C:\...\codex.exe'
A running copy of the agent is probably holding its files open. Close its terminals and try again.`;

describe('explainError', () => {
  it('explains a locked-file npm update failure in plain words', () => {
    const e = explainError(CODEX_EBUSY, { subject: 'Codex CLI', action: 'update' });
    expect(e.summary).toBe("Codex CLI couldn't be updated because it's still running.");
    expect(e.nextStep).toMatch(/Close every terminal or pane running Codex CLI/);
    expect(e.details).toContain('EBUSY');
  });

  it('keeps an already friendly message untouched', () => {
    expect(explainError('Open a project first')).toEqual({ summary: 'Open a project first' });
  });

  it('keeps friendly wording but adds a next step when a rule matches', () => {
    const e = explainError('Git push failed: Updates were rejected by the remote');
    expect(e.summary).toBe('Git push failed: Updates were rejected by the remote');
    expect(e.nextStep).toMatch(/Pull/);
  });

  it('explains common raw failures', () => {
    expect(explainError('Error: getaddrinfo ENOTFOUND registry.npmjs.org').summary).toMatch(/offline/);
    expect(explainError('fatal: not a git repository (or any of the parent directories): .git').summary).toMatch(
      /isn't a git repository/,
    );
    expect(explainError('HTTP 429 Too Many Requests: {"error":"rate_limit"}').summary).toMatch(/limit/);
    expect(explainError(new Error('listen EADDRINUSE: address already in use :::3000')).summary).toMatch(/port/);
  });

  it('shortens an unknown raw dump to its first line and keeps the rest', () => {
    const raw = 'thread panicked at src/foo.rs:12:5\nstack backtrace:\n  0: foo';
    const e = explainError(raw);
    expect(e.summary).toBe('thread panicked at src/foo.rs:12:5');
    expect(e.details).toBe(raw);
    expect(e.nextStep).toBeTruthy();
  });

  it('handles empty and object errors', () => {
    expect(explainError('').summary).toMatch(/no reason/);
    expect(explainError({ message: 'Could not save' }).summary).toBe('Could not save');
  });
});
