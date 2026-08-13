import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { get, writable } from './storeCompat';
import { agentPanelImages } from './agentPanelImages';

/**
 * These cover a bug that failed *silently in production*: the store destructures
 * `update` off `writable()`, and `update` used to call `this.set(...)`. Detached
 * from its object, `this` is undefined, so every `add`/`remove`/`clear` threw
 * `Cannot read properties of undefined (reading 'set')`.
 *
 * The panel's drop handler wraps `add` in a try/catch that only `console.error`s,
 * so the visible symptom was "dropping an image does nothing" — while the
 * `URL.createObjectURL` call that ran *before* the throw pinned the image's Blob
 * in the renderer with no surviving reference to revoke it. Every drop leaked.
 */

const revoked: string[] = [];

beforeEach(() => {
  revoked.length = 0;
  // Node's URL has no revokeObjectURL; the store only ever needs to call it.
  (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = (u: string) => {
    revoked.push(u);
  };
});

afterEach(() => {
  agentPanelImages.clear(1);
  agentPanelImages.clear(2);
  vi.restoreAllMocks();
});

const img = (id: string) => ({
  id,
  objectUrl: `blob:${id}`,
  diskPath: `/tmp/${id}.png`,
  name: `${id}.png`,
});

describe('storeCompat writable', () => {
  it('survives having its methods destructured off the store', () => {
    // The exact idiom agentPanelImages uses. `update` must not depend on `this`.
    const { subscribe, set, update } = writable(0);
    expect(() => update((n) => n + 1)).not.toThrow();
    expect(() => set(5)).not.toThrow();
    let seen = -1;
    subscribe((v) => { seen = v; });
    expect(seen).toBe(5);
  });
});

describe('agentPanelImages', () => {
  it('adds an image and exposes it under its session', () => {
    agentPanelImages.add(1, img('a'));
    expect(get(agentPanelImages).get(1)?.map((i) => i.id)).toEqual(['a']);
  });

  it('keeps sessions independent', () => {
    agentPanelImages.add(1, img('a'));
    agentPanelImages.add(2, img('b'));
    expect(get(agentPanelImages).get(1)?.map((i) => i.id)).toEqual(['a']);
    expect(get(agentPanelImages).get(2)?.map((i) => i.id)).toEqual(['b']);
  });

  it('revokes the object URL when one image is removed', () => {
    agentPanelImages.add(1, img('a'));
    agentPanelImages.add(1, img('b'));
    agentPanelImages.remove(1, 'a');
    expect(revoked).toEqual(['blob:a']);
    expect(get(agentPanelImages).get(1)?.map((i) => i.id)).toEqual(['b']);
  });

  it('revokes every object URL and drops the entry when a session is cleared', () => {
    agentPanelImages.add(1, img('a'));
    agentPanelImages.add(1, img('b'));
    agentPanelImages.clear(1);
    // Both blobs released — this is what stops a closed session leaking its
    // images for the lifetime of the window.
    expect(revoked.sort()).toEqual(['blob:a', 'blob:b']);
    expect(get(agentPanelImages).has(1)).toBe(false);
  });

  it('clearing an unknown session is a no-op', () => {
    expect(() => agentPanelImages.clear(999)).not.toThrow();
    expect(revoked).toEqual([]);
  });
});
