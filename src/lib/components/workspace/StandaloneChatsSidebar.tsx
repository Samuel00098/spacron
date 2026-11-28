import { useEffect, useState } from 'react';
import { useStore } from '$lib/react/useStore';
import { selectedStandaloneChatId, showStandaloneStructuredChat, standaloneChatOpen, startStandaloneStructuredChat } from '$lib/stores/chatNavigation';
import {
  listStandaloneStructuredRecords,
  structuredSessions,
  updateStandaloneStructuredRecord,
} from '$lib/services/structured-chat/session-store';
import { migrateLegacyStandaloneChats, removeStandaloneStructuredChat } from '$lib/services/structured-chat/standalone-structured';
import { loadBoolean } from '$lib/utils/storage';
import './StandaloneChats.css';

export default function StandaloneChatsSidebar() {
  const allSessions = useStore(structuredSessions);
  const open = useStore(standaloneChatOpen);
  const selectedId = useStore(selectedStandaloneChatId);

  useEffect(() => {
    migrateLegacyStandaloneChats();
  }, []);

  const threads = listStandaloneStructuredRecords(allSessions);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(() => loadBoolean('spacron_chats_collapsed', true));

  function toggleCollapsed() {
    setCollapsed((current) => {
      try { localStorage.setItem('spacron_chats_collapsed', String(!current)); } catch { /* Live toggle still works. */ }
      return !current;
    });
  }

  return (
    <section className="standalone-chats-sidebar" aria-label="Chats">
      <div className="standalone-chats-heading">
        <button
          type="button"
          className="standalone-chats-toggle"
          aria-expanded={!collapsed}
          aria-controls="standalone-chats-list"
          onClick={toggleCollapsed}
          title={collapsed ? 'Expand Chats' : 'Collapse Chats'}
        >
          <svg className={collapsed ? '' : 'expanded'} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="m9 5 7 7-7 7" />
          </svg>
          <span>Chats</span>
          {collapsed && threads.length > 0 && <span className="sidebar-fold-count">{threads.length}</span>}
        </button>
        <button
          type="button"
          onClick={() => {
            setCollapsed(false);
            try { localStorage.setItem('spacron_chats_collapsed', 'false'); } catch {}
            startStandaloneStructuredChat();
          }}
          aria-label="New chat"
          title="New chat"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </div>
      <div id="standalone-chats-list" className="standalone-chats-list" hidden={collapsed}>
        {!threads.length && <p className="standalone-chats-empty">Start a conversation before opening a project.</p>}
        {threads.map((record) => {
          const title = record.title?.trim() || 'New chat';
          const active = open && selectedId === record.id;
          const working = record.lifecycle === 'working';
          return (
            <div key={record.id} className={`standalone-chat-row${active ? ' active' : ''}`}>
              {renaming === record.id ? (
                <input
                  className="standalone-chat-rename"
                  autoFocus
                  aria-label="Chat name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  onBlur={() => {
                    const clean = name.trim();
                    if (clean) updateStandaloneStructuredRecord(record.id, { title: clean, titleAuto: false });
                    setRenaming(null);
                  }}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === 'Enter') {
                      const clean = name.trim();
                      if (clean) updateStandaloneStructuredRecord(record.id, { title: clean, titleAuto: false });
                      setRenaming(null);
                    }
                    if (event.key === 'Escape') setRenaming(null);
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="standalone-chat-select"
                  aria-current={active ? 'true' : undefined}
                  onClick={() => showStandaloneStructuredChat(record.id)}
                  title={title}
                >
                  {working && <span className="standalone-chat-working" aria-label="Thinking" />}
                  {record.pinned && <span className="standalone-chat-pin" aria-label="Pinned">⌖</span>}
                  <span>{title}</span>
                </button>
              )}
              <div className="standalone-chat-row-actions">
                <button
                  type="button"
                  aria-label={`Rename ${title}`}
                  title="Rename chat"
                  onClick={() => { setName(title); setRenaming(record.id); }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                    <path d="m16 3 5 5-12 12H4v-5zM14 5l5 5" />
                  </svg>
                </button>
                <button
                  type="button"
                  aria-label={`${record.pinned ? 'Unpin' : 'Pin'} ${title}`}
                  title={record.pinned ? 'Unpin chat' : 'Pin chat'}
                  onClick={() => updateStandaloneStructuredRecord(record.id, { pinned: !record.pinned })}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                    <path d="m9 3 6 0-1 6 4 4v2H6v-2l4-4zM12 15v7" />
                  </svg>
                </button>
                <button
                  type="button"
                  disabled={working}
                  aria-label={`Delete ${title}`}
                  title={working ? 'Stop the response before deleting' : 'Delete chat'}
                  onClick={() => setDeleting(record.id)}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                    <path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15" />
                  </svg>
                </button>
              </div>
              {deleting === record.id && (
                <div className="standalone-chat-delete-confirm">
                  <span>Delete this chat?</span>
                  <button type="button" onClick={() => setDeleting(null)}>Cancel</button>
                  <button
                    type="button"
                    disabled={working}
                    onClick={() => {
                      void removeStandaloneStructuredChat(record.id).then(() => {
                        const remaining = listStandaloneStructuredRecords();
                        if (selectedId === record.id || !open || !remaining.length) {
                          const next = remaining[0];
                          if (next) showStandaloneStructuredChat(next.id);
                          else startStandaloneStructuredChat();
                        }
                      });
                      setDeleting(null);
                    }}
                  >
                    Delete
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
