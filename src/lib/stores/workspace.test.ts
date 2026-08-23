import { describe, expect, it } from 'vitest';

import { __sanitisePersistedProjectState as sanitise } from './workspace';

/**
 * The per-project stage arrangement — Split's tiling and the primary room.
 *
 * These go through `sanitisePersistedProjectState` on the cold-start path, and a
 * field the sanitiser doesn't know about is dropped without a word even though
 * it was saved correctly. That is the trap `.spacron/memory/per-project-persistence.md`
 * warns about, and it is invisible until someone notices their layout isn't
 * coming back.
 */
describe('persisted stage arrangement', () => {
  it('brings the tiling and the primary room back', () => {
    const state = sanitise({
      openFiles: [],
      expandedPaths: [],
      ambient: 'gallery',
      splitSlots: ['terminal', 'agent:7', 'editor'],
      focusedRoom: 'agent:7',
    });

    expect(state?.ambient).toBe('gallery');
    expect(state?.splitSlots).toEqual(['terminal', 'agent:7', 'editor']);
    expect(state?.focusedRoom).toBe('agent:7');
  });

  it('keeps an empty arrangement empty — that is the "never arranged" sentinel', () => {
    // Not the same as "an empty stage": the shell derives its default two-pane
    // layout from it, so turning it into anything else changes what a project
    // that never touched the rail opens with.
    const state = sanitise({ openFiles: [], expandedPaths: [], splitSlots: [] });
    expect(state?.splitSlots).toEqual([]);
  });

  it('drops ids that are not room ids, keeping the rest of the arrangement', () => {
    const state = sanitise({
      openFiles: [],
      expandedPaths: [],
      splitSlots: ['terminal', '../../etc/passwd', 'agent:notanumber', 42, null, 'editor'],
      focusedRoom: 'DROP TABLE rooms',
    });

    expect(state?.splitSlots).toEqual(['terminal', 'editor']);
    expect(state?.focusedRoom).toBeNull();
  });

  it('truncates a slot list longer than the stage can hold', () => {
    const state = sanitise({
      openFiles: [],
      expandedPaths: [],
      splitSlots: Array.from({ length: 30 }, (_, i) => `agent:${i + 1}`),
    });

    expect(state?.splitSlots).toHaveLength(12);
    expect(state?.splitSlots?.[0]).toBe('agent:1');
  });

  it('reads state saved before the arrangement existed', () => {
    const state = sanitise({ openFiles: [], expandedPaths: [], ambient: 'focus' });

    expect(state?.splitSlots).toBeUndefined();
    expect(state?.focusedRoom).toBeNull();
  });
});

/**
 * The right utility drawer is per-project: a tool opened over one project must
 * not still be open over the next. It rides through persistence as a tool NAME,
 * so the sanitiser is the one thing standing between a hand-edited
 * `spacron_project_*` entry and an arbitrary string reaching the drawer.
 */
describe('persisted right drawer tool', () => {
  it('brings the open tool back', () => {
    const state = sanitise({
      openFiles: [],
      expandedPaths: [],
      layout: { activeView: 'mobile', rightDrawerTool: 'mobile' },
    });

    expect(state?.layout?.rightDrawerTool).toBe('mobile');
  });

  it('treats a closed drawer as closed', () => {
    const state = sanitise({
      openFiles: [],
      expandedPaths: [],
      layout: { activeView: 'terminal', rightDrawerTool: null },
    });

    expect(state?.layout?.rightDrawerTool).toBeNull();
  });

  it('closes the drawer for state saved before it was per-project', () => {
    // The whole point of the change: an absent field must mean "closed", never
    // "leave whatever the last project had open".
    const state = sanitise({
      openFiles: [],
      expandedPaths: [],
      layout: { activeView: 'terminal' },
    });

    expect(state?.layout?.rightDrawerTool).toBeNull();
  });

  it('rejects a tool name this build does not have', () => {
    for (const bogus of ['definitely-not-a-tool', 'proto', 42, {}, ['mobile']]) {
      const state = sanitise({
        openFiles: [],
        expandedPaths: [],
        layout: { activeView: 'terminal', rightDrawerTool: bogus },
      });
      expect(state?.layout?.rightDrawerTool).toBeNull();
    }
  });
});

describe('persisted expandedRoom state', () => {
  it('preserves valid expanded room id', () => {
    const state = sanitise({
      openFiles: [],
      expandedPaths: [],
      expandedRoom: 'terminal',
    });
    expect(state?.expandedRoom).toBe('terminal');
  });

  it('rejects invalid expanded room id', () => {
    const state = sanitise({
      openFiles: [],
      expandedPaths: [],
      expandedRoom: 'malicious/../path',
    });
    expect(state?.expandedRoom).toBeNull();
  });
});

