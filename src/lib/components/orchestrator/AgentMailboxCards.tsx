import { useMemo, useState } from 'react';
import {
  mailbox,
  mailboxSeen,
  getMailboxCards,
  dismissMailboxCard,
  type MailboxCard,
  type MailboxKind,
} from '$lib/services/orchestrator/mailbox';
import { replyToMailboxCard, approveMailboxCard } from '$lib/stores/orchestrator';
import { useStore } from '$lib/react/useStore';
import './AgentMailboxCards.css';

// A short label + glyph per kind. Only the actionable kinds (report / handoff /
// ask) ever reach this strip, but we cover them all for completeness.
const KIND_GLYPH: Record<MailboxKind, string> = {
  claim: '🔒', release: '🔓', handoff: '➡️', ask: '❓', report: '📣', done: '✅', note: '📝',
};
const KIND_LABEL: Record<MailboxKind, string> = {
  claim: 'claim', release: 'release', handoff: 'hand-off', ask: 'question', report: 'report', done: 'done', note: 'note',
};

function ageLabel(ts: number, now: number): string {
  const mins = Math.floor(Math.max(0, now - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

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

  return (
    <div className="orc-mailbox" aria-label="Agent messages needing you">
      <div className="orc-mailbox-head">
        <span className="orc-mailbox-title">Needs you</span>
        <span className="orc-mailbox-count">{cards.length}</span>
      </div>

      {cards.map((card) => (
        <div className={`orc-mb-card orc-mb-${card.kind}`} key={card.id}>
          <div className="orc-mb-meta">
            <span className="orc-mb-kind" title={KIND_LABEL[card.kind]}>
              <span className="orc-mb-glyph" aria-hidden="true">{KIND_GLYPH[card.kind]}</span>
              {KIND_LABEL[card.kind]}
            </span>
            <span className="orc-mb-route">
              <strong>{card.from}</strong>
              <span className="orc-mb-arrow"> → </span>
              {card.to ?? 'team'}
            </span>
            <span className="orc-mb-age">{ageLabel(card.createdAt, now)}</span>
          </div>

          <div className="orc-mb-text">{card.text}</div>

          {card.files.length > 0 && (
            <div className="orc-mb-files">
              {card.files.slice(0, 4).map((f) => (
                <span className="orc-mb-file" key={f} title={f}>{f}</span>
              ))}
              {card.files.length > 4 && <span className="orc-mb-file more">+{card.files.length - 4}</span>}
            </div>
          )}

          {replyingId === card.id ? (
            <div className="orc-mb-reply">
              <textarea
                className="orc-mb-reply-input"
                value={replyText}
                autoFocus
                rows={2}
                placeholder={`Reply to ${card.from}…`}
                onChange={(e) => setReplyText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submitReply(card); }
                  else if (e.key === 'Escape') { e.preventDefault(); cancelReply(); }
                }}
              />
              <div className="orc-mb-reply-actions">
                <button className="orc-mb-btn ghost" onClick={cancelReply}>Cancel</button>
                <button className="orc-mb-btn primary" onClick={() => submitReply(card)} disabled={!replyText.trim()}>
                  Send
                </button>
              </div>
            </div>
          ) : (
            <div className="orc-mb-actions">
              <button
                className="orc-mb-btn primary"
                onClick={() => void approveMailboxCard(projectId, card, rootPath)}
                title="Tell the agent to proceed"
              >
                Approve
              </button>
              <button className="orc-mb-btn" onClick={() => startReply(card.id)} title="Send the agent a follow-up">
                Reply
              </button>
              <button className="orc-mb-btn ghost" onClick={() => dismissMailboxCard(card.id)} title="Clear this card">
                Dismiss
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
