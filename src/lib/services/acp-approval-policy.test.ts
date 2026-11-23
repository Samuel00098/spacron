import { describe, expect, it } from 'vitest';
import { acpApprovalDecision } from './acp-approval-policy';

const allowOnce = { id: 'once', label: 'Allow once', kind: 'allow_once' };
const allowAlways = { id: 'always', label: 'Always allow', kind: 'allow_always' };
const reject = { id: 'no', label: 'Reject', kind: 'reject_once' };
const options = [allowOnce, allowAlways, reject];

describe('ACP approval policy', () => {
  it('asks about everything under Supervised, except reads', () => {
    expect(acpApprovalDecision('supervised', 'edit', options)).toBeNull();
    expect(acpApprovalDecision('supervised', 'execute', options)).toBeNull();
    expect(acpApprovalDecision('supervised', 'read', options)).toMatchObject({ reason: 'read-only', option: allowAlways });
    expect(acpApprovalDecision('supervised', undefined, options)).toBeNull();
  });

  it('treats an unchosen tier as Supervised', () => {
    expect(acpApprovalDecision('inherit', 'edit', options)).toBeNull();
    expect(acpApprovalDecision(null, 'edit', options)).toBeNull();
  });

  it('approves file changes under Auto-accept edits but not commands', () => {
    expect(acpApprovalDecision('auto-edits', 'edit', options)).toMatchObject({ reason: 'auto-edits' });
    expect(acpApprovalDecision('auto-edits', 'delete', options)).toMatchObject({ reason: 'auto-edits' });
    expect(acpApprovalDecision('auto-edits', 'execute', options)).toBeNull();
    // A category it cannot classify is not assumed to be an edit.
    expect(acpApprovalDecision('auto-edits', undefined, options)).toBeNull();
  });

  it('approves everything grantable under Auto and Full access', () => {
    expect(acpApprovalDecision('auto', 'execute', options)).toMatchObject({ reason: 'auto', option: allowAlways });
    expect(acpApprovalDecision('full-access', 'execute', options)).toMatchObject({ reason: 'full-access' });
  });

  it('prefers allow_always, then allow_once, and never picks a reject option', () => {
    expect(acpApprovalDecision('full-access', 'edit', [reject, allowOnce])?.option).toBe(allowOnce);
    expect(acpApprovalDecision('full-access', 'edit', [reject])).toBeNull();
    expect(acpApprovalDecision('full-access', 'edit', [])).toBeNull();
  });

  it('asks about requests Antigravity Auto still sends', () => {
    expect(acpApprovalDecision('auto', 'execute', options, {})).toBeNull();
    expect(acpApprovalDecision('auto', 'read', options, {})).toBeNull();
    expect(acpApprovalDecision('full-access', 'execute', options, {})).toMatchObject({ reason: 'full-access' });
  });

  it('leaves Antigravity fixed-choice questions to the user in Full access', () => {
    expect(acpApprovalDecision('full-access', 'other', options, { toolCallId: 'interaction_1' })).toBeNull();
  });

  it('recognises v1 options that carry no kind', () => {
    const v1 = [{ id: 'y', label: 'Approve' }, { id: 'n', label: 'Deny' }];
    expect(acpApprovalDecision('full-access', 'edit', v1)?.option.id).toBe('y');
    expect(acpApprovalDecision('full-access', 'edit', [{ id: 'n', label: 'Deny' }])).toBeNull();
    // Read-only approval at Supervised still needs a grant to pick.
    expect(acpApprovalDecision('supervised', 'read', [{ id: 'n', label: 'Cancel' }])).toBeNull();
  });
});
