import { memo, useRef } from 'react';
import { get } from '$lib/stores/storeCompat';
import FileIcon from './FileIcon.tsx';
import type { FileNode as FileNodeType } from '$lib/types/explorer';
import {
  toggleNode,
  selectedPaths,
  selectSingle,
  toggleSelection,
  selectRangeTo,
  showContextMenu,
  renamingPath,
  renamingValue,
  confirmRename,
  cancelRename,
  creatingPath,
  creatingType,
  creatingValue,
  confirmCreate,
  cancelCreate,
} from '$lib/stores/explorer';
import { useStore } from '$lib/react/useStore';
import './FileNode.css';

const DRAG_THRESHOLD = 6;

interface PendingDrag {
  path: string;
  pointerId: number;
  startX: number;
  startY: number;
  active: boolean;
}

// Deep value-compare of a node's rendered subtree. A silent auto-refresh
// rebuilds the whole tree with brand-new objects (rebuildNode never reuses
// prior instances), so comparing only the node's own fields + direct
// children.length would treat a subtree as "unchanged" whenever a nested
// descendant changed without altering an ancestor's direct-child count — e.g.
// a file created/renamed/deleted inside an expanded nested folder. That
// ancestor's memo would then skip re-render and the change would never appear.
// Recursing keeps the anti-flash benefit (truly-unchanged subtrees still skip)
// while catching nested edits.
function nodeSubtreeEqual(a: FileNodeType, b: FileNodeType): boolean {
  if (a.entry.path !== b.entry.path) return false;
  if (a.entry.name !== b.entry.name) return false;
  if (a.entry.is_dir !== b.entry.is_dir) return false;
  if (a.depth !== b.depth) return false;
  if (a.expanded !== b.expanded) return false;
  if (a.loading !== b.loading) return false;
  const ac = a.children;
  const bc = b.children;
  if (Boolean(ac) !== Boolean(bc)) return false;
  if (ac && bc) {
    if (ac.length !== bc.length) return false;
    for (let i = 0; i < ac.length; i++) {
      if (!nodeSubtreeEqual(ac[i], bc[i])) return false;
    }
  }
  return true;
}

function nodePropsEqual(prev: { node: FileNodeType }, next: { node: FileNodeType }): boolean {
  return nodeSubtreeEqual(prev.node, next.node);
}

function FileNodeUnmemoized({ node }: { node: FileNodeType }) {
  const selected = useStore(selectedPaths);
  const renaming = useStore(renamingPath);
  const renameValue = useStore(renamingValue);
  const creating = useStore(creatingPath);
  const createType = useStore(creatingType);
  const createValue = useStore(creatingValue);

  const pendingDrag = useRef<PendingDrag | null>(null);
  const suppressClick = useRef(false);

  async function handleClick(e: React.MouseEvent | React.KeyboardEvent) {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    // Ctrl/Cmd toggles a single item; Shift extends a range. Neither opens or
    // expands the node — they only adjust the selection (standard explorer UX).
    if (e.ctrlKey || e.metaKey) {
      toggleSelection(node.entry.path);
      return;
    }
    if (e.shiftKey) {
      selectRangeTo(node.entry.path);
      return;
    }
    // Plain click: collapse the selection to this one item, then open/expand it.
    selectSingle(node.entry.path);
    await toggleNode(node);
  }

  function handleKeydown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleClick(e);
    }
  }

  function handleContextMenu(e: React.MouseEvent) {
    // Right-clicking an item outside the current selection resets the selection
    // to just that item, so the menu's Delete acts on what the user pointed at.
    if (!get(selectedPaths).has(node.entry.path)) {
      selectSingle(node.entry.path);
    }
    showContextMenu(e.nativeEvent, node.entry.path, node.entry.is_dir);
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const drag = pendingDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.active) {
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < DRAG_THRESHOLD) return;
      drag.active = true;
      suppressClick.current = true;
      window.dispatchEvent(new CustomEvent('spacron-explorer-drag-start', { detail: { path: drag.path } }));
    }
    window.dispatchEvent(new CustomEvent('spacron-explorer-drag-move', {
      detail: { path: drag.path, clientX: event.clientX, clientY: event.clientY },
    }));
  }

  function finishPointerDrag(event: React.PointerEvent<HTMLDivElement>, dropped: boolean) {
    const drag = pendingDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    pendingDrag.current = null;
    if (!drag.active) return;

    window.dispatchEvent(new CustomEvent('spacron-explorer-drag-end', {
      detail: dropped
        ? { path: drag.path, clientX: event.clientX, clientY: event.clientY }
        : {},
    }));
    requestAnimationFrame(() => { suppressClick.current = false; });
  }

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !event.isPrimary || renaming === node.entry.path) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pendingDrag.current = {
      path: node.entry.path,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
    };
  }

  const renameInput = (
    <input
      className="rename-input"
      type="text"
      value={renameValue}
      onChange={(e) => renamingValue.set(e.target.value)}
      autoFocus
      onClick={(e) => e.stopPropagation()}
      onBlur={cancelRename}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          confirmRename();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          cancelRename();
        }
      }}
    />
  );

  if (node.entry.is_dir) {
    return (
      <>
        <div
          className={`file-node dir${selected.has(node.entry.path) ? ' selected' : ''}${node.expanded ? ' expanded' : ''}`}
          style={{ paddingLeft: node.depth * 16 + 8 }}
          onClick={handleClick}
          onKeyDown={handleKeydown}
          onContextMenu={handleContextMenu}
          role="treeitem"
          aria-expanded={node.expanded}
          aria-selected={selected.has(node.entry.path)}
          tabIndex={0}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className={`chevron${node.expanded ? ' rotated' : ''}`}
          >
            <polyline points="9,18 15,12 9,6" />
          </svg>
          <FileIcon name={node.entry.name} isDir={true} />
          {renaming === node.entry.path ? renameInput : <span className="node-name">{node.entry.name}</span>}
          {node.loading && <span className="loading-spinner"></span>}
        </div>
        {creating === node.entry.path && (
          <div className="create-input" style={{ paddingLeft: (node.depth + 1) * 16 + 8 }}>
            <FileIcon name={createValue} isDir={createType === 'dir'} />
            <input
              type="text"
              placeholder={createType === 'file' ? 'filename.ts' : 'folder-name'}
              value={createValue}
              onChange={(e) => creatingValue.set(e.target.value)}
              autoFocus
              onClick={(e) => e.stopPropagation()}
              onBlur={cancelCreate}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  e.stopPropagation();
                  confirmCreate();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  e.stopPropagation();
                  cancelCreate();
                }
              }}
            />
          </div>
        )}
        {node.expanded &&
          node.children &&
          node.children.map((child) => <FileNode key={child.entry.path} node={child} />)}
      </>
    );
  }

  return (
    <div
      className={`file-node file${selected.has(node.entry.path) ? ' selected' : ''}`}
      style={{ paddingLeft: node.depth * 16 + 8 }}
      onClick={handleClick}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={(event) => finishPointerDrag(event, true)}
      onPointerCancel={(event) => finishPointerDrag(event, false)}
      onLostPointerCapture={(event) => finishPointerDrag(event, false)}
      onDragStart={(event) => event.preventDefault()}
      onKeyDown={handleKeydown}
      onContextMenu={handleContextMenu}
      role="treeitem"
      aria-selected={selected.has(node.entry.path)}
      tabIndex={0}
    >
      <span className="chevron-placeholder"></span>
      <FileIcon name={node.entry.name} isDir={false} />
      {renaming === node.entry.path ? renameInput : <span className="node-name">{node.entry.name}</span>}
    </div>
  );
}

const FileNode = memo(FileNodeUnmemoized, nodePropsEqual);
export default FileNode;
