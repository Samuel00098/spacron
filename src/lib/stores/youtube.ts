import { invoke } from '@tauri-apps/api/core';
import { writable, get } from '$lib/stores/storeCompat';

// Module-level YouTube panel state. Living at module scope (not in the React
// component) is what keeps the panel persistent across ambient-mode switches:
// the panel may unmount/remount when the layout moves it between Focus / Split /
// Canvas, but this state — and crucially the loaded video — survives untouched.

export type YouTubeResult = {
  videoId?: string;
  playlistId?: string;
  /** Album page id (MPREb…) from music search. Albums don't expose their
   *  playable OLAK5uy_… playlist id in search results — it is resolved from
   *  this id at play time; see playMusicResult. */
  browseId?: string;
  title: string;
  channel: string;
  thumbnail: string;
  type?: 'video' | 'song' | 'album' | 'playlist';
};

/** Search/playback surface: regular YouTube videos, YouTube Music tracks, or
 *  the user's own on-disk library.
 *
 *  Music tracks are the same underlying video ids the IFrame player already
 *  plays — they're just surfaced via the Music InnerTube client so search
 *  returns songs rather than general videos. `local` is the odd one out: it
 *  bypasses the IFrame entirely and is owned by the musicLibrary store. */
export type YouTubeMode = 'video' | 'music' | 'local';
export type MusicFilter = 'songs' | 'albums' | 'playlists';

export type YouTubeState = {
  /** Optional YouTube Data API v3 key for the rich thumbnail-grid search. */
  apiKey: string;
  /** Whether search/results are scoped to YouTube (video) or YouTube Music. */
  mode: YouTubeMode;
  /** Whether YouTube Music search results are filtered to Songs, Albums, or Playlists. */
  musicFilter: MusicFilter;
  /** Current search box text. */
  query: string;
  /** Search results from the Data API (empty when no key / not yet searched). */
  results: YouTubeResult[];
  /** The video/playlist currently loaded in the player (null = nothing playing). */
  current: YouTubeResult | null;
  /** Last status/error message to surface in the UI. */
  status: string;
  /** True while a Data API search is in flight. */
  loading: boolean;
  /** Playback position (seconds) of the current video, so the player resumes
   *  from where it was after a mode-switch remount reloads the iframe. */
  position: number;
  /** Whether the user paused playback (vs it being stopped/ended). */
  paused: boolean;
  /** Index of the currently playing track within a playlist/album (0-based). */
  playlistIndex: number;
  /** True while fetching tracks for an album or playlist. */
  albumLoading?: boolean;
  /** Tracks belonging to the currently playing album/playlist. */
  albumTracks?: YouTubeResult[];
};

const STORAGE_KEY = 'spacron_youtube';

type Persisted = Pick<YouTubeState, 'apiKey' | 'mode' | 'musicFilter' | 'query' | 'current' | 'position' | 'paused' | 'playlistIndex'>;

function defaultPersisted(): Persisted {
  return { apiKey: '', mode: 'video', musicFilter: 'songs', query: '', current: null, position: 0, paused: false, playlistIndex: 0 };
}

function loadPersisted(): Persisted {
  if (typeof window === 'undefined') return defaultPersisted();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultPersisted();
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    const base = defaultPersisted();
    return {
      apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : base.apiKey,
      mode: parsed.mode === 'music' || parsed.mode === 'local' ? parsed.mode : 'video',
      musicFilter:
        parsed.musicFilter === 'albums' || parsed.musicFilter === 'playlists'
          ? parsed.musicFilter
          : 'songs',
      query: typeof parsed.query === 'string' ? parsed.query : base.query,
      current: parsed.current ?? null,
      position: typeof parsed.position === 'number' ? parsed.position : base.position,
      paused: typeof parsed.paused === 'boolean' ? parsed.paused : base.paused,
      playlistIndex: typeof parsed.playlistIndex === 'number' ? parsed.playlistIndex : base.playlistIndex,
    };
  } catch {
    return defaultPersisted();
  }
}

const initial = loadPersisted();

export const youtubeState = writable<YouTubeState>({
  apiKey: initial.apiKey,
  mode: initial.mode,
  musicFilter: initial.musicFilter,
  query: initial.query,
  results: [],
  current: initial.current,
  status: '',
  loading: false,
  position: initial.position,
  paused: initial.paused,
  playlistIndex: initial.playlistIndex,
  albumLoading: false,
  albumTracks: [],
});

function persist() {
  if (typeof window === 'undefined') return;
  const s = get(youtubeState);
  const toSave: Persisted = {
    apiKey: s.apiKey,
    mode: s.mode,
    musicFilter: s.musicFilter,
    query: s.query,
    current: s.current,
    position: s.position,
    paused: s.paused,
    playlistIndex: s.playlistIndex,
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
  } catch {
    /* ignore quota / serialization errors */
  }
}

let lastPositionPersist = 0;

/**
 * Record the live playback position. Called frequently from the player's
 * postMessage stream, so the store update is cheap and we only flush to
 * localStorage at most once a second.
 */
export function setPosition(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return;
  youtubeState.update((s) => ({ ...s, position: seconds }));
  const now = Date.now();
  if (now - lastPositionPersist > 1000) {
    lastPositionPersist = now;
    persist();
  }
}

/**
 * Record whether the user has paused playback. Only persists when the
 * paused state actually changes so we don't hammer localStorage on every
 * poll tick when paused is stable.
 */
export function setPaused(paused: boolean) {
  youtubeState.update((s) => {
    if (s.paused === paused) return s;
    persist();
    return { ...s, paused };
  });
}

/**
 * Record which track index (0-based) is playing inside a playlist/album so
 * we can restore the exact track after a refresh.
 */
export function setPlaylistIndex(playlistIndex: number) {
  youtubeState.update((s) => ({ ...s, playlistIndex }));
}

export function setApiKey(apiKey: string) {
  youtubeState.update((s) => ({ ...s, apiKey }));
  persist();
}

/** Switch between the YouTube (video) and YouTube Music surfaces. Clears the
 *  stale results grid so the two surfaces never show mixed content; the
 *  currently-playing item keeps playing. */
export function setMode(mode: YouTubeMode) {
  youtubeState.update((s) => (s.mode === mode ? s : { ...s, mode, results: [], status: '' }));
  persist();
}

/** Switch between YouTube Music filters (songs, albums, playlists) and trigger
 *  re-search if there is an active query. */
export function setMusicFilter(musicFilter: MusicFilter) {
  youtubeState.update((s) => ({ ...s, musicFilter }));
  persist();
  const s = get(youtubeState);
  if (s.query.trim()) {
    void searchVideos(s.query);
  }
}

export function setQuery(query: string) {
  youtubeState.update((s) => ({ ...s, query }));
}

/** Reset the panel to a clean, empty state (no video, no results, no query). */
export function goHome() {
  youtubeState.update((s) => ({
    ...s,
    current: null,
    results: [],
    query: '',
    status: '',
    position: 0,
    paused: false,
    playlistIndex: 0,
  }));
  persist();
}

export function playVideo(video: YouTubeResult) {
  youtubeState.update((s) => {
    const isSame =
      (video.playlistId && s.current?.playlistId === video.playlistId) ||
      (video.videoId && s.current?.videoId === video.videoId);
    return {
      ...s,
      current: video,
      // A different video/playlist starts from the beginning; re-selecting the same one
      // (e.g. after a remount) keeps its saved position so playback resumes.
      position: isSame ? s.position : 0,
      playlistIndex: isSame ? s.playlistIndex : 0,
      status: '',
    };
  });
  persist();
}

/** Extract a video id from a raw YouTube URL or a bare 11-char id. */
export function parseVideoId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  // Bare id.
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    if (url.hostname === 'youtu.be') {
      const id = url.pathname.slice(1);
      return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
    }
    if (url.hostname.endsWith('youtube.com')) {
      const v = url.searchParams.get('v');
      if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) return v;
      // /embed/<id> or /shorts/<id>
      const m = url.pathname.match(/\/(embed|shorts)\/([a-zA-Z0-9_-]{11})/);
      if (m) return m[2];
    }
  } catch {
    /* not a URL */
  }
  return null;
}

/** Extract a playlist/album id from a raw YouTube/YouTube Music URL or a bare id. */
export function parsePlaylistId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  // Bare playlist ID (starts with PL, OLAK, RD, UU, etc., and is 16-42 chars)
  if (/^(PL|OLAK|RD|UU|FL|LL|MC)[a-zA-Z0-9_-]{16,42}$/.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    const list = url.searchParams.get('list');
    if (list && /^(PL|OLAK|RD|UU|FL|LL|MC)[a-zA-Z0-9_-]{16,42}$/.test(list)) return list;
  } catch {
    /* not a URL */
  }
  return null;
}

type YouTubeApiItem = {
  id?: { videoId?: string };
  snippet?: {
    title?: string;
    channelTitle?: string;
    thumbnails?: { medium?: { url?: string }; default?: { url?: string } };
  };
};

function thumbFor(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
}

/**
 * Run a search and populate the results grid.
 *
 * Two paths: with a YouTube Data API key we use the official, stable endpoint;
 * without one we fall back to YouTube's internal "InnerTube" search — the same
 * API the website itself calls — so search works out of the box with no setup.
 * Both go through the Rust `http_send_request` command, which has no browser
 * CORS restrictions.
 */
export async function searchVideos(query: string): Promise<void> {
  const trimmed = query.trim();
  if (!trimmed) return;

  // A pasted playlist URL short-circuits straight to playback.
  const directPlaylistId = parsePlaylistId(trimmed);
  if (directPlaylistId) {
    playVideo({
      playlistId: directPlaylistId,
      title: 'Album / Playlist',
      channel: '',
      thumbnail: '',
      type: 'playlist',
    });
    return;
  }

  // A pasted video URL/id short-circuits straight to playback.
  const directId = parseVideoId(trimmed);
  if (directId) {
    playVideo({
      videoId: directId,
      title: trimmed,
      channel: '',
      thumbnail: thumbFor(directId),
      type: 'video',
    });
    return;
  }

  youtubeState.update((s) => ({ ...s, loading: true, status: '' }));
  try {
    const snapshot = get(youtubeState);
    // YouTube Music uses its own InnerTube client so results are songs/albums/playlists.
    // The Data API has no music-scoped search, so music mode always goes keyless.
    const results =
      snapshot.mode === 'music'
        ? await musicSearch(trimmed, snapshot.musicFilter)
        : snapshot.apiKey.trim()
          ? await dataApiSearch(trimmed, snapshot.apiKey.trim())
          : await innertubeSearch(trimmed);
    youtubeState.update((s) => ({
      ...s,
      results,
      loading: false,
      status: results.length ? '' : 'No results found.',
    }));
  } catch (err) {
    youtubeState.update((s) => ({
      ...s,
      loading: false,
      status: err instanceof Error ? err.message : 'Search failed.',
    }));
  }
}

/** Official Data API v3 search (requires the user's API key). */
async function dataApiSearch(query: string, key: string): Promise<YouTubeResult[]> {
  const url = new URL('https://www.googleapis.com/youtube/v3/search');
  url.searchParams.set('part', 'snippet');
  url.searchParams.set('type', 'video');
  url.searchParams.set('maxResults', '24');
  url.searchParams.set('q', query);
  url.searchParams.set('key', key);

  const body = await httpGet(url.toString());
  const data = JSON.parse(body) as { items?: YouTubeApiItem[]; error?: { message?: string } };
  if (data.error) throw new Error(data.error.message ?? 'Data API error');
  return (data.items ?? [])
    .filter((item) => item.id?.videoId)
    .map((item) => ({
      videoId: item.id!.videoId!,
      title: item.snippet?.title ?? 'Untitled',
      channel: item.snippet?.channelTitle ?? '',
      thumbnail:
        item.snippet?.thumbnails?.medium?.url ??
        item.snippet?.thumbnails?.default?.url ??
        thumbFor(item.id!.videoId!),
      type: 'video',
    }));
}

// Long-standing public web-client key embedded in the YouTube site — NOT a user
// secret; it's the same value for every visitor and is what makes keyless search
// possible.
const INNERTUBE_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';

/** Keyless search via YouTube's internal InnerTube API. */
async function innertubeSearch(query: string): Promise<YouTubeResult[]> {
  const url = `https://www.youtube.com/youtubei/v1/search?key=${INNERTUBE_KEY}&prettyPrint=false`;
  const payload = {
    context: {
      client: { clientName: 'WEB', clientVersion: '2.20240701.00.00', hl: 'en', gl: 'US' },
    },
    query,
  };
  const body = await httpPost(url, JSON.stringify(payload));
  const data = JSON.parse(body);
  const renderers: any[] = [];
  collectVideoRenderers(data, renderers);

  const seen = new Set<string>();
  const results: YouTubeResult[] = [];
  for (const vr of renderers) {
    const videoId: string | undefined = vr?.videoId;
    if (!videoId || seen.has(videoId)) continue;
    seen.add(videoId);
    const title =
      vr?.title?.runs?.[0]?.text ?? vr?.title?.simpleText ?? 'Untitled';
    const channel =
      vr?.ownerText?.runs?.[0]?.text ??
      vr?.longBylineText?.runs?.[0]?.text ??
      vr?.shortBylineText?.runs?.[0]?.text ??
      '';
    results.push({ videoId, title, channel, thumbnail: thumbFor(videoId), type: 'video' });
    if (results.length >= 24) break;
  }
  return results;
}

/** Recursively collect every `videoRenderer` object in the InnerTube response,
 *  which is resilient to YouTube reshuffling the surrounding structure. */
function collectVideoRenderers(node: unknown, out: any[]): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectVideoRenderers(item, out);
    return;
  }
  const obj = node as Record<string, unknown>;
  if (obj.videoRenderer && typeof obj.videoRenderer === 'object') {
    out.push(obj.videoRenderer);
  }
  for (const value of Object.values(obj)) collectVideoRenderers(value, out);
}

/**
 * Keyless YouTube Music search via the Music InnerTube API (`WEB_REMIX`
 * client). Supports songs, albums, and playlists. Results come back
 * as `musicResponsiveListItemRenderer` objects, so they are filtered and parsed.
 */
async function musicSearch(query: string, filter: MusicFilter): Promise<YouTubeResult[]> {
  const url = `https://music.youtube.com/youtubei/v1/search?key=${INNERTUBE_KEY}&prettyPrint=false`;

  // InnerTube search filter params (protobuf, same values ytmusicapi uses —
  // the middle chars encode the result type: II=songs, IY=albums).
  let params = 'EgWKAQIIAWoKEAkQBRAKEAMQBA=='; // Songs (default)
  if (filter === 'albums') {
    params = 'EgWKAQIYAWoMEA4QChADEAQQCRAF'; // Albums
  } else if (filter === 'playlists') {
    params = 'Eg-KAQwIABAAGAAgACgBMABqChAEEAMQCRAFEAo%3D'; // Playlists
  }

  const payload = {
    context: {
      client: { clientName: 'WEB_REMIX', clientVersion: '1.20240701.01.00', hl: 'en', gl: 'US' },
    },
    query,
    params,
  };
  const body = await httpPost(url, JSON.stringify(payload));
  const data = JSON.parse(body);
  const renderers: any[] = [];
  collectMusicRenderers(data, renderers);

  const seen = new Set<string>();
  const results: YouTubeResult[] = [];
  const isList = filter === 'albums' || filter === 'playlists';
  for (const item of renderers) {
    const videoId = findWatchVideoId(item);

    // Resolve the playable playlist id for list results. Albums prefer their
    // OLAK5uy_… audio playlist (present directly in album search results);
    // playlists fall back to the row's VLPL… browse target with the VL prefix
    // stripped, since some rows only expose the id there.
    let playlistId: string | undefined;
    if (isList) {
      const browseTarget: unknown = (item as any)?.navigationEndpoint?.browseEndpoint?.browseId;
      const fromBrowse =
        typeof browseTarget === 'string' && browseTarget.startsWith('VL')
          ? browseTarget.slice(2)
          : null;
      playlistId =
        filter === 'albums'
          ? findOlakPlaylistId(item) ?? sanitizePlaylistId(findPlaylistId(item))
          : sanitizePlaylistId(findPlaylistId(item)) ?? sanitizePlaylistId(fromBrowse);
    }
    const browseId = filter === 'albums' ? findAlbumBrowseId(item) ?? undefined : undefined;

    // Albums without a resolved playlist id can still play via their browseId
    // (playMusicResult resolves it); anything else needs a concrete id.
    const idKey = isList ? playlistId ?? browseId : videoId ?? undefined;
    if (!idKey || seen.has(idKey)) continue;
    seen.add(idKey);

    const cols: any[] = Array.isArray(item?.flexColumns) ? item.flexColumns : [];
    const colText = (i: number): string => {
      const runs = cols[i]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs;
      if (!Array.isArray(runs)) return '';
      return runs
        .map((r: any) => (typeof r?.text === 'string' ? r.text : ''))
        .join('')
        .trim();
    };
    const title = colText(0) || 'Untitled';
    // The subtitle column is "Artist • Album • …" for songs, but list results
    // lead with their kind ("Album • Artist • Year", "Playlist • Author • …");
    // skip that leading type word so the card shows the artist/author.
    const subtitleParts = colText(1)
      .split('•')
      .map((p) => p.trim())
      .filter(Boolean);
    const typeWords = new Set(['album', 'single', 'ep', 'playlist']);
    const channel =
      (subtitleParts[0] && typeWords.has(subtitleParts[0].toLowerCase())
        ? subtitleParts[1]
        : subtitleParts[0]) ?? '';

    results.push({
      // A song plays as its bare video: search attaches an RDAMVM… "radio"
      // playlistId which the IFrame embed player refuses to load.
      videoId: videoId || undefined,
      playlistId: isList ? playlistId : undefined,
      browseId,
      title,
      channel,
      thumbnail: findThumbnail(item),
      type: isList ? (filter === 'albums' ? 'album' : 'playlist') : 'song',
    });
    if (results.length >= 24) break;
  }
  return results;
}

/** Radio/mix ids (RD…) are session-generated server-side lists the embedded
 *  IFrame player cannot load — treat them as "no playlist id". */
function sanitizePlaylistId(playlistId: string | null): string | undefined {
  if (!playlistId || playlistId.startsWith('RD')) return undefined;
  return playlistId;
}

/** Find an album's page browseId (MPREb…) anywhere within a search renderer. */
function findAlbumBrowseId(node: unknown): string | null {
  if (!node || typeof node !== 'object') return null;
  const obj = node as Record<string, any>;
  if (typeof obj.browseId === 'string' && obj.browseId.startsWith('MPRE')) return obj.browseId;
  for (const value of Object.values(obj)) {
    const found = findAlbumBrowseId(value);
    if (found) return found;
  }
  return null;
}

/**
 * Play a search result, resolving albums to their playable playlist first.
 * Album search results only carry the album *page* id (MPREb…); the id the
 * player can actually load (OLAK5uy_…) comes from one keyless InnerTube
 * `browse` call. Everything else plays directly.
 */
export async function playMusicResult(result: YouTubeResult): Promise<void> {
  if (result.type === 'album' && !result.playlistId && result.browseId) {
    youtubeState.update((s) => ({ ...s, status: '' }));
    try {
      const url = `https://music.youtube.com/youtubei/v1/browse?key=${INNERTUBE_KEY}&prettyPrint=false`;
      const payload = {
        context: {
          client: { clientName: 'WEB_REMIX', clientVersion: '1.20240701.01.00', hl: 'en', gl: 'US' },
        },
        browseId: result.browseId,
      };
      const body = await httpPost(url, JSON.stringify(payload));
      const audioPlaylistId = findOlakPlaylistId(JSON.parse(body));
      if (audioPlaylistId) {
        playVideo({ ...result, playlistId: audioPlaylistId });
        return;
      }
    } catch {
      /* fall through to the fallback below */
    }
    // Couldn't resolve the album — fall back to its first track if search
    // found one, so the click still produces sound.
    if (result.videoId) {
      playVideo({ ...result, type: 'song' });
    } else {
      youtubeState.update((s) => ({ ...s, status: 'Could not load this album — try another result.' }));
    }
    return;
  }
  playVideo(result);
}

/** Find the album's playable audio-playlist id (OLAK5uy_…) in a browse response. */
function findOlakPlaylistId(node: unknown): string | null {
  if (!node || typeof node !== 'object') return null;
  const obj = node as Record<string, any>;
  for (const key of ['audioPlaylistId', 'playlistId'] as const) {
    if (typeof obj[key] === 'string' && obj[key].startsWith('OLAK')) return obj[key];
  }
  for (const value of Object.values(obj)) {
    const found = findOlakPlaylistId(value);
    if (found) return found;
  }
  return null;
}

/**
 * Fetch the track list of an album/playlist via the Music InnerTube `next`
 * endpoint — the call the site itself makes to build its play queue. Keyless
 * and sign-in free, like musicSearch. Populates `albumTracks` for the
 * tracklist panel; any failure just leaves the list empty (the album still
 * plays through the IFrame player, only the visual tracklist is missing).
 */
export async function fetchAlbumTracks(playlistId: string): Promise<void> {
  youtubeState.update((s) => ({ ...s, albumLoading: true, albumTracks: [] }));
  try {
    const url = `https://music.youtube.com/youtubei/v1/next?key=${INNERTUBE_KEY}&prettyPrint=false`;
    const payload = {
      context: {
        client: { clientName: 'WEB_REMIX', clientVersion: '1.20240701.01.00', hl: 'en', gl: 'US' },
      },
      playlistId,
    };
    const body = await httpPost(url, JSON.stringify(payload));
    const data = JSON.parse(body);
    // One `playlistPanelVideoRenderer` per queue entry.
    const renderers: any[] = [];
    collectRenderersByKey(data, 'playlistPanelVideoRenderer', renderers);

    const seen = new Set<string>();
    const tracks: YouTubeResult[] = [];
    for (const r of renderers) {
      const videoId: string | undefined =
        r?.videoId ?? r?.navigationEndpoint?.watchEndpoint?.videoId;
      if (!videoId || seen.has(videoId)) continue;
      seen.add(videoId);
      const title = r?.title?.runs?.[0]?.text ?? r?.title?.simpleText ?? 'Untitled';
      // longBylineText runs are "Artist • Album • Year" — keep the artist.
      const byline = Array.isArray(r?.longBylineText?.runs)
        ? r.longBylineText.runs.map((run: any) => (typeof run?.text === 'string' ? run.text : '')).join('')
        : '';
      const channel = (byline.split('•')[0] ?? '').trim();
      tracks.push({ videoId, title, channel, thumbnail: thumbFor(videoId), type: 'song' });
    }
    youtubeState.update((s) => ({ ...s, albumLoading: false, albumTracks: tracks }));
  } catch {
    youtubeState.update((s) => ({ ...s, albumLoading: false, albumTracks: [] }));
  }
}

/** Clear the album tracklist (when playback moves to a plain video/song). */
export function clearAlbumTracks() {
  youtubeState.update((s) =>
    s.albumTracks && s.albumTracks.length ? { ...s, albumTracks: [], albumLoading: false } : s
  );
}

/** Recursively collect every object stored under `key`, resilient to YouTube
 *  reshuffling the surrounding response structure. */
function collectRenderersByKey(node: unknown, key: string, out: any[]): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectRenderersByKey(item, key, out);
    return;
  }
  const obj = node as Record<string, unknown>;
  if (obj[key] && typeof obj[key] === 'object') {
    out.push(obj[key]);
  }
  for (const value of Object.values(obj)) collectRenderersByKey(value, key, out);
}

/** Recursively collect every `musicResponsiveListItemRenderer` (one per track),
 *  resilient to YouTube reshuffling the surrounding response structure. */
function collectMusicRenderers(node: unknown, out: any[]): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectMusicRenderers(item, out);
    return;
  }
  const obj = node as Record<string, unknown>;
  if (obj.musicResponsiveListItemRenderer && typeof obj.musicResponsiveListItemRenderer === 'object') {
    out.push(obj.musicResponsiveListItemRenderer);
  }
  for (const value of Object.values(obj)) collectMusicRenderers(value, out);
}

/** Find the first `watchEndpoint.videoId` anywhere within a node, preferring
 *  known locations before falling back to a blind deep search. */
function findWatchVideoId(node: unknown): string | null {
  if (!node || typeof node !== 'object') return null;
  const obj = node as Record<string, any>;
  if (typeof obj?.playlistItemData?.videoId === 'string') return obj.playlistItemData.videoId;
  if (typeof obj?.watchEndpoint?.videoId === 'string') return obj.watchEndpoint.videoId;
  // musicResponsiveListItemRenderer stores the video ID inside
  // navigationEndpoint.watchEndpoint — check before the blind deep search
  // so we don't accidentally find a watchEndpoint in an unrelated subtree.
  if (typeof obj?.navigationEndpoint?.watchEndpoint?.videoId === 'string') {
    return obj.navigationEndpoint.watchEndpoint.videoId;
  }
  for (const value of Object.values(obj)) {
    const found = findWatchVideoId(value);
    if (found) return found;
  }
  return null;
}

/** Find the first playlistId anywhere within a node, preferring known
 *  locations before falling back to a blind deep search. */
function findPlaylistId(node: unknown): string | null {
  if (!node || typeof node !== 'object') return null;
  const obj = node as Record<string, any>;
  if (typeof obj?.playlistId === 'string' && obj.playlistId) return obj.playlistId;
  if (typeof obj?.watchPlaylistEndpoint?.playlistId === 'string') return obj.watchPlaylistEndpoint.playlistId;
  if (typeof obj?.watchEndpoint?.playlistId === 'string') return obj.watchEndpoint.playlistId;
  // musicResponsiveListItemRenderer stores the playlist ID inside
  // navigationEndpoint — check before the blind deep search
  if (typeof obj?.navigationEndpoint?.watchPlaylistEndpoint?.playlistId === 'string') {
    return obj.navigationEndpoint.watchPlaylistEndpoint.playlistId;
  }
  if (typeof obj?.navigationEndpoint?.watchEndpoint?.playlistId === 'string') {
    return obj.navigationEndpoint.watchEndpoint.playlistId;
  }
  for (const value of Object.values(obj)) {
    const found = findPlaylistId(value);
    if (found) return found;
  }
  return null;
}

/** Find the first thumbnail URL anywhere within a node. */
function findThumbnailUrl(node: unknown): string | null {
  if (!node || typeof node !== 'object') return null;
  const obj = node as Record<string, any>;
  if (Array.isArray(obj.thumbnails) && obj.thumbnails.length > 0) {
    const t = obj.thumbnails[obj.thumbnails.length - 1];
    if (typeof t?.url === 'string') return t.url;
  }
  for (const value of Object.values(obj)) {
    const found = findThumbnailUrl(value);
    if (found) return found;
  }
  return null;
}

/** Extracts the thumbnail from a renderer, falling back to mqdefault for videoId. */
function findThumbnail(item: any): string {
  const thumbUrl = findThumbnailUrl(item?.thumbnail);
  if (thumbUrl) return thumbUrl;
  const videoId = findWatchVideoId(item);
  if (videoId) return thumbFor(videoId);
  return '';
}

type HttpResponse = { status: number; body: string; ok: boolean };

async function httpGet(url: string): Promise<string> {
  const res = await invoke<HttpResponse>('http_send_request', {
    method: 'GET',
    url,
    headers: { Accept: 'application/json' },
    body: null,
  });
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.body;
}

async function httpPost(url: string, jsonBody: string): Promise<string> {
  const res = await invoke<HttpResponse>('http_send_request', {
    method: 'POST',
    url,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    },
    body: jsonBody,
  });
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.body;
}
