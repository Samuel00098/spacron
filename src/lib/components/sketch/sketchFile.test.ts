import { describe, expect, it } from 'vitest';
import { parseSketchFile, serialiseSketchFile } from './sketchFile';
import type { PersistedSketchScene } from './legacySketchToScene';

const scene: PersistedSketchScene = {
  version: 1,
  savedAt: 1700000000000,
  canvasBackground: '#0f2c59',
  elements: [{ id: 'a', type: 'rectangle', x: 1, y: 2 }],
  files: {
    'file-1': { id: 'file-1', mimeType: 'image/png', dataURL: 'data:image/png;base64,AA==', created: 0 },
  },
};

describe('project sketch file', () => {
  it('writes a document Excalidraw itself would open, and reads it back', () => {
    const raw = serialiseSketchFile(scene);
    const parsedJson = JSON.parse(raw);

    expect(parsedJson.type).toBe('excalidraw');
    expect(parsedJson.version).toBe(2);
    expect(parsedJson.source).toBe('spacron');
    expect(parsedJson.savedAt).toBe(scene.savedAt);
    expect(parsedJson.elements).toHaveLength(1);
    expect(parsedJson.files['file-1'].mimeType).toBe('image/png');

    const parsed = parseSketchFile(raw);
    expect(parsed?.elements).toEqual(scene.elements);
    expect(parsed?.files).toEqual(scene.files);
    expect(parsed?.savedAt).toBe(scene.savedAt);
    expect(parsed?.canvasBackground).toBe('#0f2c59');
  });

  it('omits a theme-implied background instead of freezing one', () => {
    const raw = serialiseSketchFile({ ...scene, canvasBackground: undefined });
    expect(JSON.parse(raw).appState).toEqual({});
    expect(parseSketchFile(raw)?.canvasBackground).toBeUndefined();
  });

  it('rejects a file that is not a scene', () => {
    expect(parseSketchFile('not json')).toBeNull();
    expect(parseSketchFile('{}')).toBeNull();
    expect(parseSketchFile('{"elements": "nope"}')).toBeNull();
  });
});
