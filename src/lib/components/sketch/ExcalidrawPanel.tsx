import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { activeProject } from '$lib/stores/workspace';
import { showToast } from '$lib/stores/notification';
import { useStore } from '$lib/react/useStore';
import {
  convertLegacySketch,
  type LegacySketchState,
  type PersistedSketchScene,
} from './legacySketchToScene';
import { readSketchFile, writeSketchFile } from './sketchFile';
import type { SceneChangeHandler } from './ExcalidrawCanvas';
import './ExcalidrawPanel.css';

/**
 * The Sketch room's body: Excalidraw, stored per project.
 *
 * The room wiring, visibility flag, fullscreen rules and assistant `navigate`
 * target are unchanged — AppShell still lazy-loads one component with an
 * `onClose` prop, and this is it.
 *
 * A sketch is written twice, from the same debounce:
 *  - `<project>/.spacron/sketches/sketch.excalidraw` — the durable copy, a real
 *    Excalidraw document an agent can read and edit;
 *  - localStorage — a cache, and the whole document when no project folder is
 *    open. Both carry `savedAt`, and the newer one wins on open.
 *
 * Legacy v2-v4 documents are converted once and written to both places; the
 * old keys are left untouched (`legacySketchToScene.ts`).
 */

const ExcalidrawCanvas = lazy(() => import('./ExcalidrawCanvas.tsx'));

const SCENE_KEY_PREFIX = 'soryq_sketch_excalidraw_v1_';
const LEGACY_V4_PREFIX = 'soryq_sketch_state_v4_';
const LEGACY_V3_KEY = 'soryq_sketch_state_v3';
const LEGACY_V2_KEY = 'soryq_sketch_state_v2';
const LEGACY_OWNER_KEY = 'soryq_sketch_legacy_owner_project';
const AUTOSAVE_DELAY_MS = 600;

const EMPTY_SCENE: PersistedSketchScene = { version: 1, elements: [], files: {} };

type CachedScene = {
  scene: PersistedSketchScene;
  migrated: 'v4' | 'v3' | 'v2' | null;
  dropped: number;
};

function sceneKeyFor(projectId: string) {
  return `${SCENE_KEY_PREFIX}${projectId}`;
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function readLegacy(projectId: string): { state: LegacySketchState; from: 'v4' | 'v3' | 'v2' } | null {
  const v4 = parseJson<LegacySketchState>(localStorage.getItem(`${LEGACY_V4_PREFIX}${projectId}`));
  if (v4) return { state: v4, from: 'v4' };

  // The v3/v2 documents were unscoped. The old panel let the first project to
  // open them claim them, and that claim is respected here so two projects
  // cannot both convert the same drawing.
  const owner = localStorage.getItem(LEGACY_OWNER_KEY);
  if (owner && owner !== projectId) return null;

  const legacy = parseJson<LegacySketchState>(
    localStorage.getItem(LEGACY_V3_KEY) ?? localStorage.getItem(LEGACY_V2_KEY),
  );
  return legacy ? { state: legacy, from: 'v3' } : null;
}

/** Synchronous: localStorage, or a one-time conversion of the old document. */
function loadCachedScene(projectId: string | null): CachedScene {
  if (typeof localStorage === 'undefined' || !projectId) {
    return { scene: EMPTY_SCENE, migrated: null, dropped: 0 };
  }

  const saved = parseJson<PersistedSketchScene>(localStorage.getItem(sceneKeyFor(projectId)));
  if (saved?.elements) {
    return { scene: { ...saved, version: 1 }, migrated: null, dropped: 0 };
  }

  let legacy: ReturnType<typeof readLegacy> = null;
  try {
    legacy = readLegacy(projectId);
  } catch {
    legacy = null;
  }
  if (!legacy) return { scene: EMPTY_SCENE, migrated: null, dropped: 0 };

  const converted = convertLegacySketch(legacy.state);
  return {
    scene: {
      version: 1,
      elements: converted.elements,
      files: converted.files,
      canvasBackground: converted.canvasBackground,
      migratedFrom: legacy.from,
    },
    migrated: legacy.from,
    dropped: converted.counts.dropped,
  };
}

function writeCache(projectId: string | null, scene: PersistedSketchScene): boolean {
  if (typeof localStorage === 'undefined' || !projectId) return false;
  try {
    localStorage.setItem(sceneKeyFor(projectId), JSON.stringify(scene));
    return true;
  } catch {
    return false;
  }
}

/** The app marks its light theme on `<html>`; that is the truth to follow. */
function appThemeIsLight(): boolean {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('light-theme');
}

type ExcalidrawPanelProps = {
  /** Closes the surface hosting the canvas (same contract as the old panel). */
  onClose?: () => void;
};

export default function ExcalidrawPanel({ onClose }: ExcalidrawPanelProps) {
  const project = useStore(activeProject);
  const projectId = project?.id ?? null;
  const rootPath = project?.root_path ?? null;

  const [scene, setScene] = useState<PersistedSketchScene | null>(null);
  const [isLightTheme, setIsLightTheme] = useState(appThemeIsLight);

  // Pending autosave: the latest document, plus the timer that writes it.
  const latestRef = useRef<PersistedSketchScene | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const saveWarningShownRef = useRef(false);

  const flush = useCallback((projectKey: string | null, root: string | null) => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const pending = latestRef.current;
    latestRef.current = null;
    if (!pending) return;

    const toWrite: PersistedSketchScene = { ...pending, version: 1, savedAt: Date.now() };
    const cached = writeCache(projectKey, toWrite);
    if (root) {
      void writeSketchFile(root, toWrite).catch(() => {
        if (saveWarningShownRef.current) return;
        saveWarningShownRef.current = true;
        showToast('Could not write the sketch into this project folder', 'error');
      });
    } else if (!cached && !saveWarningShownRef.current) {
      saveWarningShownRef.current = true;
      showToast('Sketch is too large to autosave locally', 'error');
    }
  }, []);

  // Open a document: the newer of the project file and the local cache.
  useEffect(() => {
    let cancelled = false;
    setScene(null);
    saveWarningShownRef.current = false;

    const cached = loadCachedScene(projectId);
    if (!projectId) {
      setScene(cached.scene);
      return;
    }

    // Cache first, so a project with no folder still opens instantly.
    if (!rootPath) {
      setScene(cached.scene);
      return;
    }

    void (async () => {
      const fromFile = await readSketchFile(rootPath);
      if (cancelled) return;

      const fileIsNewer = !!fromFile && (fromFile.savedAt ?? 0) > (cached.scene.savedAt ?? 0);
      const chosen = fileIsNewer ? fromFile : cached.scene;
      setScene(chosen);
      if (fileIsNewer) writeCache(projectId, chosen);

      // A conversion has to reach the project folder too, or clearing the cache
      // would resurrect the legacy document as the only copy.
      if (cached.migrated && !fileIsNewer) {
        const migrated: PersistedSketchScene = { ...cached.scene, savedAt: Date.now() };
        writeCache(projectId, migrated);
        if (cached.migrated !== 'v4') localStorage.setItem(LEGACY_OWNER_KEY, projectId);
        void writeSketchFile(rootPath, migrated).catch(() => {
          showToast('Converted the sketch, but could not write it into the project folder', 'error');
        });
        const count = migrated.elements.length;
        if (count > 0) {
          const skipped = cached.dropped > 0 ? `, ${cached.dropped} skipped` : '';
          showToast(`Converted ${count} legacy sketch element${count === 1 ? '' : 's'}${skipped}`, 'success');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [projectId, rootPath]);

  // Write the outgoing document before a project switch replaces it.
  useEffect(() => {
    const key = projectId;
    const root = rootPath;
    return () => flush(key, root);
  }, [projectId, rootPath, flush]);

  // Follow the app's theme (preset, custom or system): theme.ts toggles a class
  // on <html>, so observing that covers every path that changes it.
  useEffect(() => {
    const root = document.documentElement;
    const sync = () => setIsLightTheme(root.classList.contains('light-theme'));
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  // Escape keeps closing the room when focus is *not* inside the drawing. Inside
  // it, Excalidraw owns the key (cancel the current tool / clear the selection).
  useEffect(() => {
    if (!onClose) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const target = event.target as HTMLElement | null;
      if (target?.closest?.('.excalidraw')) return;
      onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const theme: 'light' | 'dark' = isLightTheme ? 'light' : 'dark';

  const handleChange = useCallback<SceneChangeHandler>(
    (next) => {
      if (!projectId) return;
      latestRef.current = { version: 1, ...next };
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = window.setTimeout(() => {
        saveTimerRef.current = null;
        flush(projectId, rootPath);
      }, AUTOSAVE_DELAY_MS);
    },
    [projectId, rootPath, flush],
  );

  const placeholder = (
    <div className="excalidraw-room-loading" role="status" aria-live="polite">
      <span className="excalidraw-room-spinner" aria-hidden="true" />
      <span>Loading sketch…</span>
    </div>
  );

  return (
    <div className="excalidraw-room" data-project={projectId ?? undefined} data-theme={theme}>
      {scene === null ? (
        placeholder
      ) : (
        <Suspense fallback={placeholder}>
          <ExcalidrawCanvas
            // A different project is a different document; remounting is what
            // makes initialData authoritative.
            key={projectId ?? 'no-project'}
            initialScene={scene}
            theme={theme}
            onChange={handleChange}
          />
        </Suspense>
      )}
    </div>
  );
}
