import ConfirmDialog from './ConfirmDialog';
import { useStore } from '$lib/react/useStore';
import { answerDesktopGrant, desktopGrantQueue } from '$lib/stores/computerUse';

/**
 * Asks the user whether an agent may see, or control, their desktop
 * (docs/computer-use.md).
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

  const who = request.agentName?.trim() || (request.chatId ? 'Spacron chat' : 'An agent');
  const windowLabel = (
    <>
      <strong>“{request.windowTitle ?? 'untitled'}”</strong>
      {request.process ? <> ({request.process})</> : null}
    </>
  );
  const control = request.kind === 'control';
  const lasts = request.chatId
    ? 'The permission lasts until this chat reply is finished.'
    : "The permission lasts until this agent's session ends.";
  const waiting = queue.length - 1;

  const what =
    request.kind === 'window_list' ? (
      <>see the list of your open windows: their titles, apps and positions</>
    ) : control ? (
      <>control the window {windowLabel}: click, type and press keys in it and in its own menus and dialogs</>
    ) : (
      <>see the window {windowLabel}: what is written in it and a screenshot of it</>
    );

  return (
    <ConfirmDialog
      key={request.requestId}
      title={control ? `Let ${who} control a window?` : `Let ${who} see your screen?`}
      danger={control}
      body={
        <>
          <p style={{ margin: '0 0 8px' }}>
            {who} wants to {what}.
          </p>
          {request.reason && request.reason !== '(no reason given)' ? (
            // The agent's own words: plain text, quoted, never trusted as markup.
            <p style={{ margin: '0 0 8px' }}>Its reason: “{request.reason}”</p>
          ) : null}
          <p style={{ margin: 0 }}>
            {control
              ? 'An orange frame shows while it is in control. Press Ctrl+Alt+Esc at any time to stop it and withdraw every permission. '
              : 'It can look but not click or type. '}
            {lasts}
            {waiting > 0 ? ` ${waiting} more request${waiting === 1 ? '' : 's'} waiting.` : ''}
          </p>
        </>
      }
      confirmLabel={control ? 'Allow control' : 'Allow'}
      cancelLabel="Don't allow"
      onConfirm={() => answerDesktopGrant(request.requestId, true)}
      onCancel={() => answerDesktopGrant(request.requestId, false)}
    />
  );
}
