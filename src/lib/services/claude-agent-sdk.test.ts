import { describe, it, expect } from 'vitest';
import { claudePermissionModeForAccess } from './claude-agent-sdk';

describe('claudePermissionModeForAccess', () => {
  it('maps Spacron tiers to Claude permission modes', () => {
    expect(claudePermissionModeForAccess('supervised')).toBe('default');
    expect(claudePermissionModeForAccess('auto-edits')).toBe('acceptEdits');
    expect(claudePermissionModeForAccess('auto')).toBe('plan');
    expect(claudePermissionModeForAccess('full-access')).toBe('bypassPermissions');
    expect(claudePermissionModeForAccess('inherit')).toBe('default');
  });
});