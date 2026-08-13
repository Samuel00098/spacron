import { useMemo, useState } from 'react';
import {
  mailbox,
  mailboxSeen,
  getMailboxCards,
  dismissMailboxCard,
  type MailboxCard,
} from '$lib/services/orchestrator/mailbox';
import { replyToMailboxCard, approveMailboxCard, mergeAndApproveMailboxCard, orchestratorTasks } from '$lib/stores/orchestrator';
import { acknowledge } from '$lib/services/orchestrator/inbox';
import { useStore } from '$lib/react/useStore';
import MailboxCardView from './MailboxCard';
import './AgentMailboxCards.css';

/**
 * The "needs you" strip: the actionable agent-to-agent messages (report /
 * handoff / ask) surfaced as approvable cards instead of raw terminal scroll.
 * Approve tells the sending agent to proceed; Reply delivers your words straight
 * into its live REPL; Dismiss clears the card. All three record on the shared
 * mailbox so the rest of the team sees the decision. Renders nothing when the
 * queue is empty, so it only ever takes space when an agent actually needs you.
 */
export default function AgentMailboxCards({ projectId, rootPath }: { projectId: string; rootPath: string | null }) {
  // Subscribe to both stores so the queue recomputes as traffic arrives and as
  // the user works cards off it; getMailboxCards reads them via get() internally.
  const allMail = useStore(mailbox);
  const seen = useStore(mailboxSeen);
  const tasks = useStore(orchestratorTasks);
  const cards = useMemo(
    () => getMailboxCards(projectId, { actionableOnly: true }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allMail, seen, projectId],
  );

  const [replyingId, setReplyingId] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');
  const now = Date.now();

  if (!projectId || cards.length === 0) return null;

  function startReply(id: string) {
    setReplyingId(id);
    setReplyText('');
  }

  function cancelReply() {
    setReplyingId(null);
    setReplyText('');
  }

  function submitReply(card: MailboxCard) {
    const text = replyText.trim();
    if (!text) return;
    void replyToMailboxCard(projectId, card, text, rootPath);
    cancelReply();
  }

  // Closing a card by hand is an acknowledgement: it clears the strip *and*
  // the inbox's unread flag (read + dismissed), exactly like the notification
  // stack's dismiss. `dismissMailboxCard` alone only hides it from this strip —
  // the inbox reads with includeSeen, so the card would stay bold in the list.
  function dismiss(card: MailboxCard) {
    dismissMailboxCard(card.id);
    acknowledge(projectId, card.id);
  }

  return (
    <div className="orc-mailbox" aria-label="Agent messages needing you">
      <div className="orc-mailbox-head">
        <span className="orc-mailbox-title">Needs you</span>
        <span className="orc-mailbox-count">{cards.length}</span>
      </div>

      {cards.map((card) => (
        <MailboxCardView
          key={card.id}
          card={card}
          now={now}
          replying={replyingId === card.id}
          replyText={replyText}
          hasWorktree={card.kind === 'handoff' && card.taskId && tasks.some((t) => t.id === card.taskId && t.worktree) || false}
          onStartReply={() => startReply(card.id)}
          onCancelReply={cancelReply}
          onReplyChange={setReplyText}
          onSubmitReply={() => submitReply(card)}
          onApprove={() => void approveMailboxCard(projectId, card, rootPath)}
          onMergeApprove={() => void mergeAndApproveMailboxCard(projectId, card, rootPath)}
          onDismiss={() => dismiss(card)}
        />
      ))}
    </div>
  );
}
