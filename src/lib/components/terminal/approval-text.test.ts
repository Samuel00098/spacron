import { describe, expect, it } from 'vitest';
import { approvalText } from './approval-text';

const cwd = 'C:\\Users\\me\\chat-files\\ss_1';

describe('approvalText', () => {
  it("splits Grok's quoted path out of the title and drops the bare kind", () => {
    expect(approvalText(`Write \`${cwd}\\notes\\a.txt\``, 'edit', cwd))
      .toEqual({ action: 'Write', target: 'notes\\a.txt', fullTarget: `${cwd}\\notes\\a.txt` });
  });

  it("reads Claude's tool name and path", () => {
    expect(approvalText('Claude wants to use Write', `${cwd}\\a.txt`, cwd))
      .toMatchObject({ action: 'Write', target: 'a.txt' });
  });

  it('keeps a title with nothing to split, and a path outside the folder whole', () => {
    expect(approvalText('File a.txt', 'edit', cwd)).toMatchObject({ action: 'File a.txt', target: null });
    expect(approvalText('Claude wants to use Bash', 'rm -rf build', cwd)).toMatchObject({ target: 'rm -rf build' });
  });
});
