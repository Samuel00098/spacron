import { afterEach, describe, expect, it } from 'vitest';
import { get } from '$lib/stores/storeCompat';
import {
  agentCmdOverrides,
  agentDefaultArgs,
  agentDefaultEnv,
  agentPermissionMode,
  chatDefaultAccessMode,
} from '$lib/stores/settings';
import { structuredAccessFor } from './defaults';

const original = {
  mode: get(agentPermissionMode),
  args: get(agentDefaultArgs),
  env: get(agentDefaultEnv),
  commands: get(agentCmdOverrides),
  chatDefault: get(chatDefaultAccessMode),
};

afterEach(() => {
  agentPermissionMode.set(original.mode);
  agentDefaultArgs.set(original.args);
  agentDefaultEnv.set(original.env);
  agentCmdOverrides.set(original.commands);
  chatDefaultAccessMode.set(original.chatDefault);
});

describe('structuredAccessFor', () => {
  it('inherits full access from the yolo agent default', () => {
    chatDefaultAccessMode.set('inherit');
    agentPermissionMode.set('yolo');
    agentDefaultArgs.set({});
    agentDefaultEnv.set({});
    expect(structuredAccessFor('codex')).toBe('full-access');
  });

  it('inherits ask from the manual agent default', () => {
    chatDefaultAccessMode.set('inherit');
    agentPermissionMode.set('manual');
    agentDefaultArgs.set({});
    agentDefaultEnv.set({});
    expect(structuredAccessFor('claude')).toBe('ask');
  });

  it('does not grant access when a custom override is ambiguous', () => {
    chatDefaultAccessMode.set('inherit');
    agentPermissionMode.set('yolo');
    agentDefaultArgs.set({ codex: '--some-custom-policy' });
    agentDefaultEnv.set({});
    expect(structuredAccessFor('codex')).toBe('ask');
  });

  it('uses explicit chat default access mode when set', () => {
    agentPermissionMode.set('manual');
    chatDefaultAccessMode.set('full-access');
    expect(structuredAccessFor('codex')).toBe('full-access');

    chatDefaultAccessMode.set('auto');
    expect(structuredAccessFor('codex')).toBe('auto');

    chatDefaultAccessMode.set('auto-edits');
    expect(structuredAccessFor('claude')).toBe('auto');

    chatDefaultAccessMode.set('supervised');
    expect(structuredAccessFor('claude')).toBe('ask');
  });
});

