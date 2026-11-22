import { createPortal } from 'react-dom';
import { useEffect, useRef } from 'react';
import type { SlashCommand } from '$lib/services/terminal-chat-rich';

export type ChatMenuAgent = { command: string; name: string };
export type ChatMenuPoint = { x: number; y: number };

type Props = {
  point: ChatMenuPoint | null;
  commands: SlashCommand[];
  agents: ChatMenuAgent[];
  commandDisabled?: boolean;
  onClose: () => void;
  onFind: () => void;
  onCommand: (command: SlashCommand) => void;
  onHandOff: () => void;
  onCopyContext: () => void;
};


/** Context actions for the transcript view, portaled so fixed positioning follows the window. */
export default function TerminalChatContextMenu({
  point,
  commands,
  agents,
  commandDisabled = false,
  onClose,
  onFind,
  onCommand,
  onHandOff,
  onCopyContext,
}: Props) {
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!point) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [point, onClose]);

  if (!point || typeof document === 'undefined') return null;
  const left = Math.max(8, Math.min(point.x, window.innerWidth - 252));
  const top = Math.max(8, Math.min(point.y, window.innerHeight - 430));

  return createPortal(
    <div
      ref={menuRef}
      className="terminal-chat-context-menu"
      role="menu"
      aria-label="Chat actions"
      style={{ left, top }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <MenuButton icon="search" shortcut="Ctrl+F" onClick={onFind}>Find in chat</MenuButton>
      <MenuButton icon="handoff" onClick={onHandOff}>Hand Off to Another Agent</MenuButton>
      <div className="terminal-chat-context-menu-separator" />
      <MenuButton icon="copy" onClick={onCopyContext}>Copy Context</MenuButton>
    </div>,
    document.body,
  );
}

function MenuButton({
  icon,
  shortcut,
  arrow = false,
  disabled = false,
  title,
  onClick,
  children,
}: {
  icon: 'search' | 'play' | 'handoff' | 'copy' | 'command' | 'agent';
  shortcut?: string;
  arrow?: boolean;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className="terminal-chat-context-menu-item"
      disabled={disabled}
      title={title}
      onClick={onClick}
    >
      <MenuIcon name={icon} />
      <span className="terminal-chat-context-menu-label">{children}</span>
      {shortcut && <span className="terminal-chat-context-menu-shortcut">{shortcut}</span>}
      {arrow && <span className="terminal-chat-context-menu-arrow">›</span>}
    </button>
  );
}

function MenuIcon({ name }: { name: 'search' | 'play' | 'handoff' | 'copy' | 'command' | 'agent' }) {
  const paths: Record<typeof name, React.ReactNode> = {
    search: <><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 5 5" /></>,
    play: <path d="M7 4.8v14.4L19 12 7 4.8Z" fill="currentColor" stroke="none" />,
    handoff: <><rect x="3.5" y="4.5" width="17" height="12" rx="2" /><path d="M8 20h8M12 16.5V20M8 9h8M8 12.5h5" /></>,
    copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></>,
    command: <><path d="M8 4a3 3 0 1 0 0 6h8a3 3 0 1 0-3-3v10a3 3 0 1 0 3-3H8a3 3 0 1 0 3 3V7a3 3 0 1 0-3 3" /></>,
    agent: <><circle cx="12" cy="8" r="3.2" /><path d="M5 20c.8-3.5 3.1-5.2 7-5.2s6.2 1.7 7 5.2" /></>,
  };
  return <svg className="terminal-chat-context-menu-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
