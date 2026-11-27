import type { StructuredApproval } from '$lib/services/structured-chat/provider';
import { approvalText } from './approval-text';
import './PermissionCard.css';

export type ApprovalDecision = 'accept' | 'acceptForSession' | 'decline';

export interface ApprovalChoice {
  key: string;
  label: string;
  decision: ApprovalDecision;
  optionId?: string;
  tone: 'once' | 'always' | 'no';
}

/** The answers to a request, in the order their number keys pick them. */
export function approvalChoices(approval: StructuredApproval): ApprovalChoice[] {
  if (!approval.options?.length) {
    return [
      { key: 'accept', label: 'Allow', decision: 'accept', tone: 'once' },
      { key: 'always', label: 'Allow for this chat', decision: 'acceptForSession', tone: 'always' },
      { key: 'decline', label: 'Decline', decision: 'decline', tone: 'no' },
    ];
  }
  return approval.options.map((option) => {
    const words = `${option.kind ?? ''} ${option.id}`;
    const no = /reject|cancel|deny|declin/i.test(words);
    return {
      key: option.id,
      label: option.label,
      decision: no ? 'decline' : 'accept',
      optionId: option.id,
      tone: no ? 'no' : /always|session/i.test(`${words} ${option.label}`) ? 'always' : 'once',
    };
  });
}

export default function PermissionCard({ approval, agentLabel, cwd, onAnswer }: {
  approval: StructuredApproval;
  agentLabel: string;
  cwd: string | null;
  onAnswer: (choice: ApprovalChoice) => void;
}) {
  const { action, target, fullTarget } = approvalText(approval.title, approval.detail, cwd);
  return (
    <div className="permission-card" role="group" aria-label={approval.title}>
      <div className="permission-card-head">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 3 5 6v5c0 4.5 3 8.5 7 10 4-1.5 7-5.5 7-10V6z" />
        </svg>
        <span>{agentLabel} needs your permission</span>
      </div>
      <div className="permission-card-action">{action}</div>
      {target && <code className="permission-card-target" title={fullTarget ?? undefined}>{target}</code>}
      <div className="permission-card-choices" role="group" aria-label="Answers">
        {approvalChoices(approval).map((choice, index) => (
          <button
            key={choice.key}
            type="button"
            className={`permission-card-choice ${choice.tone}`}
            onClick={() => onAnswer(choice)}
          >
            <kbd>{index + 1}</kbd>
            <span>{choice.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
