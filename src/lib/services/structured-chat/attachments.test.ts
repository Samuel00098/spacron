import { describe, expect, it } from 'vitest';
import { acpImageBlocks, imageDataUrlsFor, parseDroppedPaths, parseImageDataUrl } from './attachments';

describe('paths dropped on the composer', () => {
  it('reads one path per line and strips the quotes a drag adds', () => {
    expect(parseDroppedPaths('C:/a/b.md')).toEqual(['C:/a/b.md']);
    expect(parseDroppedPaths('C:/a/b.md\n"C:/with space/c.png"\n')).toEqual(['C:/a/b.md', 'C:/with space/c.png']);
  });

  it('ignores blank lines and repeats of the same path', () => {
    expect(parseDroppedPaths('\n  \nC:/a\nC:/a\n')).toEqual(['C:/a']);
    expect(parseDroppedPaths('')).toEqual([]);
  });
});

describe('image attachments for inline providers', () => {
  it('decodes an image data URL into a base64 block', () => {
    expect(parseImageDataUrl('data:image/png;base64,AAAA')).toEqual({ mimeType: 'image/png', data: 'AAAA' });
    expect(parseImageDataUrl('data:image/JPEG;base64,AAAA')).toEqual({ mimeType: 'image/jpeg', data: 'AAAA' });
    expect(parseImageDataUrl('data:image/png;base64,AA\nAA')).toEqual({ mimeType: 'image/png', data: 'AAAA' });
  });

  it('refuses anything that is not an inline image', () => {
    expect(parseImageDataUrl('data:text/plain;base64,AAAA')).toBeNull();
    expect(parseImageDataUrl('data:image/png;base64,')).toBeNull();
    expect(parseImageDataUrl('C:/Users/me/pasted/image.png')).toBeNull();
    expect(parseImageDataUrl('https://example.com/a.png')).toBeNull();
  });

  it('maps data URLs to ACP image content blocks and drops the rest', () => {
    expect(acpImageBlocks(['data:image/webp;base64,AAAA', 'nonsense'])).toEqual([{ mimeType: 'image/webp', data: 'AAAA' }]);
  });

  it('keeps the images that can be read and skips the ones that cannot', async () => {
    // A path only becomes a data URL through the backend reader; without it
    // (here) the attachment is dropped instead of being sent half-read.
    await expect(imageDataUrlsFor(['data:image/jpeg;base64,AAAA', '/no/such/image.png']))
      .resolves.toEqual(['data:image/jpeg;base64,AAAA']);
    await expect(imageDataUrlsFor(['data:text/plain;base64,AAAA'])).resolves.toEqual([]);
  });
});
