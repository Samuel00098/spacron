import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { writable, get } from '$lib/stores/storeCompat';

// Local music library: plays audio files straight off disk instead of through
// the YouTube IFrame. Same module-scope rationale as the YouTube panel state —
// the panel unmounts/remounts as the layout moves between Focus / Split /
// Canvas, and the audio element living here is what keeps playback unbroken
// across those remounts.
//
// Why this source exists at all: rebroadcasting a YouTube embed on a live
// stream risks a mid-stream ad and depends on someone else's playlist staying
// intact. Files on disk can do neither.

export type LocalTrack = {
  path: string;
  title: string;
  artist: string;
  album: string;
  ext: string;
  sizeBytes: number;
};

type ScanResult = {
  folder: string;
  tracks: LocalTrack[];
  licenseFiles: string[];
  truncated: boolean;
};

export type RepeatMode = 'off' | 'all' | 'one';

export type MusicLibraryState = {
  /** Chosen library folder ('' = none picked yet). */
  folder: string;
  tracks: LocalTrack[];
  /** Licence/certificate files found in the library, for Content ID disputes. */
  licenseFiles: string[];
  /** Index into the *filtered* view being played, resolved to a path on play. */
  currentPath: string | null;
  playing: boolean;
  loading: boolean;
  status: string;
  /** Filter text applied to the track list. */
  filter: string;
  volume: number;
  shuffle: boolean;
  repeat: RepeatMode;
  position: number;
  duration: number;
  /** True when the scan hit its track cap. */
  truncated: boolean;
};

const STORAGE_KEY = 'spacron_music_library';

type Persisted = Pick<MusicLibraryState, 'folder' | 'currentPath' | 'volume' | 'shuffle' | 'repeat'>;

function defaultPersisted(): Persisted {
  return { folder: '', currentPath: null, volume: 0.7, shuffle: false, repeat: 'off' };
}

function loadPersisted(): Persisted {
  if (typeof window === 'undefined') return defaultPersisted();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultPersisted();
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    const base = defaultPersisted();
    return {
      folder: typeof parsed.folder === 'string' ? parsed.folder : base.folder,
      currentPath: typeof parsed.currentPath === 'string' ? parsed.currentPath : null,
      volume:
        typeof parsed.volume === 'number' && parsed.volume >= 0 && parsed.volume <= 1
          ? parsed.volume
          : base.volume,
      shuffle: typeof parsed.shuffle === 'boolean' ? parsed.shuffle : base.shuffle,
      repeat:
        parsed.repeat === 'all' || parsed.repeat === 'one' || parsed.repeat === 'off'
          ? parsed.repeat
          : base.repeat,
    };
  } catch {
    return defaultPersisted();
  }
}

const initial = loadPersisted();

export const musicLibraryState = writable<MusicLibraryState>({
  folder: initial.folder,
  tracks: [],
  licenseFiles: [],
  currentPath: initial.currentPath,
  playing: false,
  loading: false,
  status: '',
  filter: '',
  volume: initial.volume,
  shuffle: initial.shuffle,
  repeat: initial.repeat,
  position: 0,
  duration: 0,
  truncated: false,
});

function persist() {
  if (typeof window === 'undefined') return;
  const s = get(musicLibraryState);
  const toSave: Persisted = {
    folder: s.folder,
    currentPath: s.currentPath,
    volume: s.volume,
    shuffle: s.shuffle,
    repeat: s.repeat,
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
  } catch {
    /* ignore quota / serialization errors */
  }
}

// --- audio element -------------------------------------------------------

let audio: HTMLAudioElement | null = null;
let lastPositionPersist = 0;

/** Lazily create the single shared audio element and wire its events once. */
function getAudio(): HTMLAudioElement | null {
  if (typeof window === 'undefined') return null;
  if (audio) return audio;

  const el = new Audio();
  el.preload = 'metadata';
  el.volume = get(musicLibraryState).volume;

  el.addEventListener('timeupdate', () => {
    musicLibraryState.update((s) => ({ ...s, position: el.currentTime }));
    // Position moves ~4x/second; throttle the localStorage write.
    const now = Date.now();
    if (now - lastPositionPersist > 1000) {
      lastPositionPersist = now;
      persist();
    }
  });
  el.addEventListener('loadedmetadata', () => {
    musicLibraryState.update((s) => ({ ...s, duration: Number.isFinite(el.duration) ? el.duration : 0 }));
  });
  el.addEventListener('play', () => musicLibraryState.update((s) => ({ ...s, playing: true })));
  el.addEventListener('pause', () => musicLibraryState.update((s) => ({ ...s, playing: false })));
  el.addEventListener('ended', () => {
    // 'one' loops in place; everything else advances the queue.
    if (get(musicLibraryState).repeat === 'one') {
      el.currentTime = 0;
      void el.play().catch(() => undefined);
      return;
    }
    playNext(true);
  });
  el.addEventListener('error', () => {
    const s = get(musicLibraryState);
    const name = s.tracks.find((t) => t.path === s.currentPath)?.title ?? 'that track';
    musicLibraryState.update((st) => ({
      ...st,
      playing: false,
      status: `Could not play ${name} — the file may be missing or in an unsupported format.`,
    }));
  });

  audio = el;
  return el;
}

/** Tracks matching the current filter — the list the UI shows and the queue
 *  that next/previous walk. */
export function visibleTracks(s: MusicLibraryState): LocalTrack[] {
  const q = s.filter.trim().toLowerCase();
  if (!q) return s.tracks;
  return s.tracks.filter(
    (t) =>
      t.title.toLowerCase().includes(q) ||
      t.artist.toLowerCase().includes(q) ||
      t.album.toLowerCase().includes(q)
  );
}

// --- actions -------------------------------------------------------------

/** Scan (or rescan) a folder into the library. Also re-grants the asset-protocol
 *  scope, which is why it must run again on every app start, not just on pick. */
export async function scanFolder(folder: string): Promise<void> {
  if (!folder) return;
  musicLibraryState.update((s) => ({ ...s, loading: true, status: '' }));
  try {
    const res = await invoke<ScanResult>('music_library_scan', { folder });
    musicLibraryState.update((s) => ({
      ...s,
      folder: res.folder,
      tracks: res.tracks,
      licenseFiles: res.licenseFiles,
      truncated: res.truncated,
      loading: false,
      // A remembered track that no longer exists shouldn't linger in the UI.
      currentPath: res.tracks.some((t) => t.path === s.currentPath) ? s.currentPath : null,
      status: res.tracks.length
        ? res.truncated
          ? `Loaded the first ${res.tracks.length} tracks — the folder holds more.`
          : ''
        : 'No audio files found in that folder.',
    }));
    persist();
  } catch (err) {
    musicLibraryState.update((s) => ({
      ...s,
      loading: false,
      status: err instanceof Error ? err.message : 'Could not read that folder.',
    }));
  }
}

/** Re-index the folder already chosen — used on mount to restore the library
 *  and re-grant playback access after a restart. */
export async function refreshLibrary(): Promise<void> {
  const s = get(musicLibraryState);
  if (s.folder) await scanFolder(s.folder);
}

export function playTrack(path: string): void {
  const el = getAudio();
  if (!el) return;
  const s = get(musicLibraryState);
  const track = s.tracks.find((t) => t.path === path);
  if (!track) return;

  // Re-selecting the current track restarts it rather than reloading the src,
  // which would drop the buffer for no reason.
  if (s.currentPath === path && el.src) {
    el.currentTime = 0;
    void el.play().catch(() => undefined);
    return;
  }

  el.src = convertFileSrc(path);
  el.volume = s.volume;
  musicLibraryState.update((st) => ({ ...st, currentPath: path, position: 0, duration: 0, status: '' }));
  persist();
  void el.play().catch(() => undefined);
}

export function togglePlay(): void {
  const el = getAudio();
  if (!el) return;
  const s = get(musicLibraryState);

  // Nothing loaded yet — start the first visible track.
  if (!s.currentPath || !el.src) {
    const first = visibleTracks(s)[0];
    if (first) playTrack(first.path);
    return;
  }
  if (el.paused) {
    void el.play().catch(() => undefined);
  } else {
    el.pause();
  }
}

/** Advance the queue. `auto` marks an advance caused by a track ending, which
 *  is the only case that should stop at the end of a non-repeating list. */
export function playNext(auto = false): void {
  const s = get(musicLibraryState);
  const list = visibleTracks(s);
  if (!list.length) return;

  if (s.shuffle) {
    // Pick any track but the current one, so shuffle never repeats in place.
    const pool = list.filter((t) => t.path !== s.currentPath);
    const pick = (pool.length ? pool : list)[Math.floor(Math.random() * (pool.length || list.length))];
    playTrack(pick.path);
    return;
  }

  const idx = list.findIndex((t) => t.path === s.currentPath);
  const nextIdx = idx + 1;
  if (nextIdx >= list.length) {
    if (s.repeat === 'all') {
      playTrack(list[0].path);
    } else if (auto) {
      musicLibraryState.update((st) => ({ ...st, playing: false }));
    }
    return;
  }
  playTrack(list[nextIdx].path);
}

export function playPrevious(): void {
  const el = getAudio();
  const s = get(musicLibraryState);
  const list = visibleTracks(s);
  if (!list.length) return;

  // Past three seconds, "previous" restarts the track — the convention every
  // music player uses.
  if (el && el.currentTime > 3) {
    el.currentTime = 0;
    return;
  }

  const idx = list.findIndex((t) => t.path === s.currentPath);
  const prevIdx = idx <= 0 ? (s.repeat === 'all' ? list.length - 1 : 0) : idx - 1;
  playTrack(list[prevIdx].path);
}

/** Pause local playback without clearing what's loaded. Called when the media
 *  player switches to a YouTube source, so the two can't play over each other. */
export function pausePlayback(): void {
  if (!audio) return;
  audio.pause();
}

export function seek(seconds: number): void {
  const el = getAudio();
  if (!el || !Number.isFinite(seconds)) return;
  el.currentTime = Math.max(0, seconds);
  musicLibraryState.update((s) => ({ ...s, position: el.currentTime }));
}

export function setVolume(volume: number): void {
  const clamped = Math.min(1, Math.max(0, volume));
  const el = getAudio();
  if (el) el.volume = clamped;
  musicLibraryState.update((s) => ({ ...s, volume: clamped }));
  persist();
}

export function toggleShuffle(): void {
  musicLibraryState.update((s) => ({ ...s, shuffle: !s.shuffle }));
  persist();
}

export function cycleRepeat(): void {
  const order: RepeatMode[] = ['off', 'all', 'one'];
  musicLibraryState.update((s) => ({ ...s, repeat: order[(order.indexOf(s.repeat) + 1) % order.length] }));
  persist();
}

export function setFilter(filter: string): void {
  musicLibraryState.update((s) => ({ ...s, filter }));
}

/** Open a track or licence file in the OS file manager. */
export async function revealInFolder(path: string): Promise<void> {
  try {
    await invoke('music_library_reveal', { path });
  } catch (err) {
    musicLibraryState.update((s) => ({
      ...s,
      status: err instanceof Error ? err.message : 'Could not open the file manager.',
    }));
  }
}

/** Stop playback and forget the chosen folder. */
export function clearLibrary(): void {
  const el = getAudio();
  if (el) {
    el.pause();
    el.removeAttribute('src');
    el.load();
  }
  musicLibraryState.update((s) => ({
    ...s,
    folder: '',
    tracks: [],
    licenseFiles: [],
    currentPath: null,
    playing: false,
    position: 0,
    duration: 0,
    truncated: false,
    status: '',
  }));
  persist();
}

/** mm:ss for the progress readout. */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}
