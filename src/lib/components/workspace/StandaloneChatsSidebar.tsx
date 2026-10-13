import { useState } from 'react';
import { useStore } from '$lib/react/useStore';
import { chatThreadState, deleteChatThread, getStandaloneChats, renameChatThread, toggleChatThreadPinned } from '$lib/stores/chatThreads';
import { chatScope, selectedStandaloneChatId, showStandaloneChat, startStandaloneChat } from '$lib/stores/chatNavigation';
import { loadBoolean } from '$lib/utils/storage';
import { get } from '$lib/stores/storeCompat';
import './StandaloneChats.css';

export default function StandaloneChatsSidebar() {
  const state = useStore(chatThreadState);
  const scope = useStore(chatScope);
  const selectedId = useStore(selectedStandaloneChatId);
  const threads = getStandaloneChats(state).sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.lastActivityAt - a.lastActivityAt);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(() => loadBoolean('spacron_chats_collapsed'));
  function toggleCollapsed() {
    setCollapsed((current) => {
      try { localStorage.setItem('spacron_chats_collapsed', String(!current)); } catch { /* Live toggle still works. */ }
      return !current;
    });
  }
  return (
    <section className="standalone-chats-sidebar" aria-label="Chats">
      <div className="standalone-chats-heading">
        <button type="button" className="standalone-chats-toggle" aria-expanded={!collapsed} aria-controls="standalone-chats-list" onClick={toggleCollapsed} title={collapsed ? 'Expand Chats' : 'Collapse Chats'}>
          <svg className={collapsed ? '' : 'expanded'} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg><span>Chats</span>
        </button>
        <button type="button" onClick={() => { setCollapsed(false); try { localStorage.setItem('spacron_chats_collapsed', 'false'); } catch {} startStandaloneChat(); }} aria-label="New chat" title="New chat"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg></button>
      </div>
      <div id="standalone-chats-list" className="standalone-chats-list" hidden={collapsed}>
        {!threads.length && <p className="standalone-chats-empty">Start a conversation before opening a project.</p>}
        {threads.map((thread) => {
          const title = thread.title === 'New thread' ? 'New chat' : thread.title;
          const active = scope === 'standalone' && selectedId === thread.id;
          return (
            <div key={thread.id} className={`standalone-chat-row${active ? ' active' : ''}`}>
              {renaming === thread.id ? <input className="standalone-chat-rename" autoFocus aria-label="Chat name" value={name}
                onChange={(event) => setName(event.target.value)} onBlur={() => { renameChatThread(thread.id, name); setRenaming(null); }}
                onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Enter') { renameChatThread(thread.id, name); setRenaming(null); } if (event.key === 'Escape') setRenaming(null); }} />
                : <button type="button" className="standalone-chat-select" aria-current={active ? 'true' : undefined} onClick={() => showStandaloneChat(thread.id)} title={title}>
                  {thread.status === 'working' && <span className="standalone-chat-working" aria-label="Thinking" />}
                  {thread.pinned && <span className="standalone-chat-pin" aria-label="Pinned">⌖</span>}
                  <span>{title}</span>
                </button>}
              <div className="standalone-chat-row-actions">
                <button type="button" aria-label={`Rename ${title}`} title="Rename chat" onClick={() => { setName(title); setRenaming(thread.id); }}><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m16 3 5 5-12 12H4v-5zM14 5l5 5" /></svg></button>
                <button type="button" aria-label={`${thread.pinned ? 'Unpin' : 'Pin'} ${title}`} title={thread.pinned ? 'Unpin chat' : 'Pin chat'} onClick={() => toggleChatThreadPinned(thread.id)}><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m9 3 6 0-1 6 4 4v2H6v-2l4-4zM12 15v7" /></svg></button>
                <button type="button" disabled={thread.status === 'working'} aria-label={`Delete ${title}`} title={thread.status === 'working' ? 'Stop the response before deleting' : 'Delete chat'} onClick={() => setDeleting(thread.id)}><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15" /></svg></button>
              </div>
              {deleting === thread.id && <div className="standalone-chat-delete-confirm">
                <span>Delete this chat?</span>
                <button type="button" onClick={() => setDeleting(null)}>Cancel</button>
                <button type="button" disabled={thread.status === 'working'} onClick={() => {
                  deleteChatThread(thread.id);
                  // Deleting the open chat lands in a fresh one, like ChatGPT
                  // and Claude. An untouched chat is reused rather than piling
                  // up blank "New chat" rows.
                  if (selectedId === thread.id || scope !== 'standalone' || threads.length === 1) {
                    const blank = getStandaloneChats(get(chatThreadState)).find((entry) => entry.id !== thread.id
                      && !(get(chatThreadState).messagesByThread[entry.id] ?? []).length);
                    if (blank) showStandaloneChat(blank.id); else startStandaloneChat();
                  }
                  setDeleting(null);
                }}>Delete</button>
              </div>}
            </div>
          );
        })}
      </div>
    </section>
  );
}
