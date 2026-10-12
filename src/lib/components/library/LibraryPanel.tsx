import { useCallback, useEffect, useMemo, useState } from 'react';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { useStore } from '$lib/react/useStore';
import { activeProject } from '$lib/stores/workspace';
import { sessions, sendPromptToSession, getAgentDisplayName } from '$lib/stores/terminal';
import { mediaGeneration } from '$lib/stores/settings';
import { editImageInThread } from '$lib/stores/orchestrator';
import { getActiveThreadId } from '$lib/stores/chatThreads';
import { setInteractionMode } from '$lib/stores/interactionMode';
import { showToast } from '$lib/stores/notification';
import {
  cancelMediaGeneration,
  failureNotice,
  fallbackNotice,
  generateMedia,
  imageEditPrompt,
  mediaProviderLabel,
} from '$lib/services/media-generation';
import ImageViewer, { type ViewerImage } from '$lib/components/shared/ImageViewer';
import type { DropdownOption } from '$lib/components/shared/Dropdown';
import { isTauriRuntime } from '$lib/utils/tauri';
import './LibraryPanel.css';

interface GenerationEntry {
  path: string;
  name: string;
  size: number;
  modified: number;
}

/** An edit running on an image provider straight from the Library. */
interface PendingEdit {
  requestId: string;
  sourceName: string;
  prompt: string;
  provider: string;
}

// Agents save into the same folder through the MCP `generate_image` tool, so
// the grid re-reads it while the room is open. One read_dir, only while mounted.
const REFRESH_MS = 4000;

const API_TARGET = 'api:';
const AGENT_TARGET = 'agent:';
const CHAT_TARGET = 'chat';

function agentEditRequest(image: ViewerImage, request: string, markPath?: string): string {
  const references = markPath ? [image.path!, markPath] : [image.path!];
  return [
    `Edit the image at ${image.path} (open it first if you can view images).`,
    `Requested change: ${request}`,
    '',
    `Call Spacron's generate_image tool with reference_images ${JSON.stringify(references)} and this prompt:`,
    imageEditPrompt(request, Boolean(markPath)),
    '',
    "It saves the result in the project's generations folder, where it shows up in the Library. Tell me the saved path when it is done.",
  ].join('\n');
}

/**
 * The Library room: every image generated in the active project
 * (`<project>/generations`), newest first. Clicking one opens the shared
 * viewer, whose Edit sends the change to an image provider, the chat thread,
 * or a running agent.
 */
export default function LibraryPanel() {
  const project = useStore(activeProject);
  const allSessions = useStore(sessions);
  const mediaSettings = useStore(mediaGeneration);
  const [entries, setEntries] = useState<GenerationEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A snapshot: the grid refreshes underneath, which must not move the open image.
  const [viewer, setViewer] = useState<{ images: ViewerImage[]; index: number } | null>(null);
  const [pending, setPending] = useState<PendingEdit[]>([]);
  const root = project?.root_path ?? null;

  const refresh = useCallback(async () => {
    if (!root || !isTauriRuntime()) { setEntries([]); return; }
    try {
      setEntries(await invoke<GenerationEntry[]>('list_generations', { projectRoot: root }));
      setError(null);
    } catch (err) {
      setError(String(err ?? 'could not read the generations folder'));
    }
  }, [root]);

  useEffect(() => {
    setEntries(null);
    setViewer(null);
    void refresh();
    const timer = window.setInterval(() => void refresh(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const images: ViewerImage[] = useMemo(
    () => (entries ?? []).map((entry) => ({ src: convertFileSrc(entry.path), name: entry.name, path: entry.path })),
    [entries],
  );

  const agents = useMemo(
    () => allSessions.filter((s) => s.isRunning && s.agentPreset && !s.hidden && (!project || s.projectId === project.id)),
    [allSessions, project],
  );

  // Kept short on purpose: "Image API" already walks every keyed provider in
  // the Settings order, so only ChatGPT and OpenAI get entries of their own.
  const editTargets: DropdownOption[] = useMemo(() => {
    const product = (preset: string | null | undefined) => getAgentDisplayName(preset) ?? preset ?? 'Agent';
    return [
      { value: `${API_TARGET}auto`, label: 'Image API' },
      ...agents.map((s) => ({
        value: `${AGENT_TARGET}${s.id}`,
        label: s.agentName ? `${s.agentName} (${product(s.agentPreset)})` : product(s.agentPreset),
      })),
      { value: `${API_TARGET}chatgpt`, label: 'ChatGPT' },
      { value: `${API_TARGET}openai`, label: 'OpenAI API' },
      { value: CHAT_TARGET, label: 'Chat' },
    ];
  }, [agents]);

  async function editWithProvider(image: ViewerImage, request: string, markPath: string | undefined, provider: string) {
    const requestId = crypto.randomUUID();
    const label = provider === 'auto' ? 'Image API' : mediaProviderLabel(provider);
    setPending((list) => [{ requestId, sourceName: image.name, prompt: request, provider: label }, ...list]);
    try {
      const result = await generateMedia({
        requestId,
        kind: 'image',
        prompt: imageEditPrompt(request, Boolean(markPath)),
        referenceImages: markPath ? [image.path!, markPath] : [image.path!],
        projectRoot: root,
        settings: provider === 'auto' ? mediaSettings : { ...mediaSettings, imageProvider: provider as typeof mediaSettings.imageProvider },
      });
      showToast(fallbackNotice(result) ?? `Edited with ${mediaProviderLabel(result.provider)}`, 'success');
      await refresh();
    } catch (err) {
      const message = String(err ?? 'the edit failed');
      if (!message.startsWith('cancelled:')) showToast(failureNotice(message, 'image')?.replace(/\*\*/g, '') ?? `The edit failed: ${message}`, 'error', 8000);
    } finally {
      setPending((list) => list.filter((p) => p.requestId !== requestId));
    }
  }

  function onEdit(image: ViewerImage, request: string, markPath?: string, target?: string) {
    if (!project || !image.path) return;
    const chosen = target ?? `${API_TARGET}auto`;
    if (chosen.startsWith(API_TARGET)) {
      void editWithProvider(image, request, markPath, chosen.slice(API_TARGET.length));
      return;
    }
    if (chosen === CHAT_TARGET) {
      void editImageInThread({
        projectId: project.id,
        rootPath: project.root_path,
        threadId: getActiveThreadId(project.id) ?? undefined,
        imagePath: image.path,
        imageName: image.name,
        markPath,
        prompt: request,
      });
      setInteractionMode('chat');
      return;
    }
    if (chosen.startsWith(AGENT_TARGET)) {
      const id = Number(chosen.slice(AGENT_TARGET.length));
      const session = agents.find((s) => s.id === id);
      if (!session) { showToast('That agent is no longer running', 'warning'); return; }
      sendPromptToSession(id, agentEditRequest(image, request, markPath), session.agentPreset);
      showToast(`Sent the edit to ${session.agentName ?? getAgentDisplayName(session.agentPreset) ?? 'the agent'}`, 'success');
    }
  }

  if (!project) {
    return <div className="library-panel"><p className="library-empty">Open a project to see its generated images.</p></div>;
  }

  return (
    <div className="library-panel">
      <header className="library-head">
        <span className="library-count">{entries ? `${entries.length} image${entries.length === 1 ? '' : 's'}` : 'Loading…'}</span>
        <span className="library-folder" title={`${root}/generations`}>generations/</span>
        <button type="button" className="library-button" onClick={() => void refresh()}>Refresh</button>
      </header>
      {error && <p className="library-error">{error}</p>}
      <div className="library-scroll">
        {entries && entries.length === 0 && pending.length === 0 ? (
          <p className="library-empty">No generated images yet. Images made in chat or by agents with generate_image land here.</p>
        ) : (
          <ul className="library-grid">
            {pending.map((p) => (
              <li key={p.requestId} className="library-card pending">
                <div className="library-thumb">
                  <span className="library-pending-label">Editing with {p.provider}…</span>
                </div>
                <div className="library-meta">
                  <span className="library-name" title={p.prompt}>{p.prompt}</span>
                  <button type="button" className="library-button" onClick={() => cancelMediaGeneration(p.requestId)}>Cancel</button>
                </div>
              </li>
            ))}
            {images.map((image, index) => (
              <li key={image.path} className="library-card">
                <button type="button" className="library-thumb" onClick={() => setViewer({ images, index })} title={image.name}>
                  <img src={image.src} alt={image.name} loading="lazy" draggable={false} />
                </button>
                <div className="library-meta">
                  <span className="library-name" title={image.name}>{image.name}</span>
                  <span className="library-date">{new Date(entries![index].modified).toLocaleDateString()}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      {viewer && (
        <ImageViewer
          images={viewer.images}
          startIndex={viewer.index}
          projectRoot={root}
          onClose={() => setViewer(null)}
          onEdit={onEdit}
          editTargets={editTargets}
          defaultEditTarget={`${API_TARGET}auto`}
        />
      )}
    </div>
  );
}
