import ConfirmDialog from './ConfirmDialog';
import { useStore } from '$lib/react/useStore';
import { answerDesktopGrant, desktopGrantQueue } from '$lib/stores/computerUse';

/**
 * Asks the user whether an agent may see their desktop (docs/computer-use.md).
 *
 * One dialog at a time, oldest request first. Escape, an outside click and
 * "Don't allow" all decline: the agent's tool call is waiting on the answer,
 * and the safe one has to be the easiest to give.
 *
 * Mounted once at the app root and renders nothing while the queue is empty —
 * the dialog itself is conditional, as ConfirmDialog requires.
 */
export default function DesktopGrantHost() {
  const queue = useStore(desktopGrantQueue);
  const request = queue[0];
  if (!request) return null;

  const who = request.agentName?.trim() || 'An agent';
  const what =
    request.kind === 'window_list' ? (
      <>the list of your open windows: their titles, apps and positions</>
    ) : (
      <>
        the window <strong>“{request.windowTitle ?? 'untitled'}”</strong>
        {request.process ? <> ({request.process})</> : null}: what is written in it and a
        screenshot of it
      </>
    );
  const waiting = queue.length - 1;

  return (
    <ConfirmDialog
      key={request.requestId}
      title={`Let ${who} see your screen?`}
      body={
        <>
          <p style={{ margin: '0 0 8px' }}>
            {who} wants to see {what}.
          </p>
          {request.reason && request.reason !== '(no reason given)' ? (
            // The agent's own words: plain text, quoted, never trusted as markup.
            <p style={{ margin: '0 0 8px' }}>Its reason: “{request.reason}”</p>
          ) : null}
          <p style={{ margin: 0 }}>
            It can look but not click or type. The permission lasts until this agent's session
            ends.
            {waiting > 0 ? ` ${waiting} more request${waiting === 1 ? '' : 's'} waiting.` : ''}
          </p>
        </>
      }
      confirmLabel="Allow"
      cancelLabel="Don't allow"
      onConfirm={() => answerDesktopGrant(request.requestId, true)}
      onCancel={() => answerDesktopGrant(request.requestId, false)}
    />
  );
}
