import { describe, expect, it } from 'vitest';
import { boxFolderName } from './remote-send';

describe('boxFolderName', () => {
  it('keeps safe names and cleans the rest', () => {
    const sep = String.fromCharCode(92);
    expect(boxFolderName(['C:', 'Users', 'me', 'Samuel Works', 'spacron'].join(sep))).toBe('spacron');
    expect(boxFolderName('/home/me/My App (v2)')).toBe('My-App-v2-');
    expect(boxFolderName('/home/me/.dotfiles')).toBe('dotfiles');
    expect(boxFolderName('/')).toBe('project');
  });
});
