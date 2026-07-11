import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useStore } from '$lib/react/useStore';
import { get } from '$lib/stores/storeCompat';
import {
  youtubeState,
  setApiKey,
  setMode,
  setMusicFilter,
  setQuery,
  searchVideos,
  playMusicResult,
  setPosition,
  goHome,
  fetchAlbumTracks,
  clearAlbumTracks,
  type MusicFilter,
} from '$lib/stores/youtube';
import { loadYouTubeApi, type YTPlayer } from '$lib/utils/youtubeApi';
import './YouTubePanel.css';

/** Format a second count as m:ss for the music transport bar. */
function fmtTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Square-ish high-res cover art for a track (cropped from hqdefault in CSS). */
function musicArt(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

/** Map a YouTube IFrame API error code to a message for the status line —
 *  without this the player failed silently. Code 5 means the HTML5 player
 *  itself couldn't play; on Linux that is almost always WebKitGTK missing the
 *  system GStreamer codecs, so point at the packages to install. */
let gstreamerCodecsChecked = false;
let gstreamerCodecsOk = true;

// Probe once at module load so describePlayerError can give accurate
// guidance on Linux instead of always blaming missing codecs.
checkGstreamerCodecs();

async function checkGstreamerCodecs() {
  try {
    gstreamerCodecsOk = await invoke<boolean>('check_gstreamer_codecs');
  } catch {
    gstreamerCodecsOk = false;
  }
  gstreamerCodecsChecked = true;
}

function describePlayerError(code: number): string {
  switch (code) {
    case 2:
      return 'This video link looks invalid.';
    case 100:
      return 'Video not found — it may be private or removed.';
    case 101:
    case 150:
      return 'This video does not allow embedded playback. Try another result.';
    default: {
      const onLinuxDesktop =
        navigator.userAgent.includes('Linux') && !navigator.userAgent.includes('Android');
      if (onLinuxDesktop && gstreamerCodecsChecked && !gstreamerCodecsOk) {
        return (
          'Playback failed. On Linux, video playback needs the GStreamer codecs — ' +
          'e.g. on Ubuntu/Debian run: sudo apt install gstreamer1.0-plugins-good ' +
          'gstreamer1.0-plugins-bad gstreamer1.0-libav — then restart Spacron.'
        );
      }
      return `Playback failed (error ${code}).`;
    }
  }
}

// Live-stream / stall recovery tuning. If the player claims to be playing or
// buffering (or a live stream drops to ENDED) but the current time hasn't moved
// for this long, we treat the stream as stalled and rebuild the player to
// reconnect. Bounded so a stream that has genuinely ended doesn't reload forever.
const STALL_TIMEOUT_MS = 20000;
const MAX_RECONNECTS = 5;
const RECONNECTING_STATUS = 'Reconnecting…';

export default function YouTubePanel() {
  const state = useStore(youtubeState);
  const [showSettings, setShowSettings] = useState(false);

  const panelRef = useRef<HTMLDivElement | null>(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });

  const playerHostRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<YTPlayer | null>(null);

  // Music-mode transport state, sampled from the player while it plays so the
  // audio-only UI has a working play/pause button and seek bar.
  const [musicPlaying, setMusicPlaying] = useState(true);
  const [musicProgress, setMusicProgress] = useState(0);
  const [musicDuration, setMusicDuration] = useState(0);

  // Dynamic details of the currently playing track in a playlist/album.
  const [trackDetails, setTrackDetails] = useState<{
    videoId?: string;
    title?: string;
    channel?: string;
  } | null>(null);

  // While a video is playing, a fresh search drops its results into a dropdown
  // over the player so you can switch without leaving what you're watching.
  const [resultsOpen, setResultsOpen] = useState(false);

  // Bumping this forces the player-building effect to tear down and rebuild the
  // iframe — used by the stall watchdog to reconnect a frozen/dropped stream.
  const [reloadNonce, setReloadNonce] = useState(0);
  // Reconnect attempts spent on the *current* source, so a genuinely dead stream
  // can't loop forever. Reset when the source changes or playback recovers.
  const reconnectsRef = useRef(0);
  const lastKeyRef = useRef<string | null>(null);

  // Measure container dimensions for responsiveness
  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setDimensions({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    await searchVideos(state.query);
    if (get(youtubeState).current) setResultsOpen(true);
  }

  const currentVideoId = state.current?.videoId ?? null;
  const currentPlaylistId = state.current?.playlistId ?? null;
  const playbackKey =
    currentPlaylistId && currentVideoId
      ? `${currentPlaylistId}_${currentVideoId}`
      : currentPlaylistId || currentVideoId;
  const hasPlayer = Boolean(playbackKey);
  const hasPlaylist = Boolean(currentPlaylistId);

  // Build (and tear down) the IFrame API player. Keyed on the playbackKey (videoId or playlistId)
  // so it only rebuilds when the source playlist/video changes — not on the per-second position
  // updates — which is what keeps playback smooth. On unmount we save the current time so
  // the next mount resumes it.
  useEffect(() => {
    if (!playbackKey) return;
    const host = playerHostRef.current;
    if (!host) return;

    let cancelled = false;
    let poll: number | null = null;
    // Captured once, at the moment this video/playlist mounts — the resume point.
    // (For a live stream YouTube ignores this and rejoins the live edge.)
    const startAt = Math.floor(get(youtubeState).position);
    // Reset the reconnect budget only when the *source* changes, not on a
    // watchdog-triggered rebuild (which bumps reloadNonce, keeping playbackKey the
    // same) — otherwise the retry cap would reset every reload and loop forever.
    if (lastKeyRef.current !== playbackKey) {
      lastKeyRef.current = playbackKey;
      reconnectsRef.current = 0;
    }
    // Reset the music transport for the freshly-loaded track.
    setMusicProgress(0);
    setMusicDuration(0);
    setMusicPlaying(true);
    setTrackDetails(null);

    void loadYouTubeApi()
      .then((YT) => {
        if (cancelled || !playerHostRef.current) return;
        const mount = document.createElement('div');
        playerHostRef.current.appendChild(mount);

        playerRef.current = new YT.Player(mount, {
          host: 'https://www.youtube-nocookie.com',
          videoId: currentVideoId || undefined,
          playerVars: {
            autoplay: 0,
            rel: 0,
            modestbranding: 1,
            start: currentPlaylistId ? undefined : startAt,
            listType: currentPlaylistId ? 'playlist' : undefined,
            list: currentPlaylistId || undefined,
          },
          events: {
            onError: (e) => {
              youtubeState.update((s) => ({ ...s, status: describePlayerError(e.data) }));
            },
          },
        });

        // Sample the position and track info while playing. Also runs the stall
        // watchdog: `lastTime`/`stalledSince` persist across ticks (closure vars)
        // to detect frozen playback and trigger a reconnect.
        let lastTime = -1;
        let stalledSince = 0;
        poll = window.setInterval(() => {
          const p = playerRef.current;
          if (!p) return;
          try {
            const t = p.getCurrentTime();
            if (typeof t === 'number' && t > 0) {
              setPosition(t);
              setMusicProgress(t);
            }
            const d = p.getDuration();
            if (typeof d === 'number' && d > 0) setMusicDuration(d);
            const ps = p.getPlayerState();
            if (typeof ps === 'number') setMusicPlaying(ps === 1 || ps === 3);

            // Dynamically retrieve info of the active track (crucial for playlists/albums)
            const data = (p as any).getVideoData?.();
            if (data && data.video_id) {
              setTrackDetails({
                videoId: data.video_id,
                title: data.title || '',
                channel: data.author || '',
              });
            }

            // ── Stall / live-drop watchdog ──────────────────────────────────
            // ps: 1 playing, 2 paused, 3 buffering, 0 ended.
            const isLive = Boolean(data?.isLive);
            const advanced = typeof t === 'number' && Math.abs(t - lastTime) >= 0.25;
            if (advanced) {
              // Healthy playback — clear any stall state and refund the budget.
              stalledSince = 0;
              lastTime = t;
              reconnectsRef.current = 0;
              youtubeState.update((s) =>
                s.status === RECONNECTING_STATUS ? { ...s, status: '' } : s
              );
            } else {
              // Not advancing. Recover from a frozen play/buffer, or a live stream
              // that dropped to ENDED. A normal (non-live) video reaching its end
              // is left alone so finished videos don't reload.
              const frozenWhilePlaying = (ps === 1 || ps === 3) && typeof t === 'number';
              const liveDropped = isLive && ps === 0;
              if (frozenWhilePlaying || liveDropped) {
                if (stalledSince === 0) {
                  stalledSince = Date.now();
                } else if (Date.now() - stalledSince > STALL_TIMEOUT_MS) {
                  stalledSince = 0;
                  lastTime = -1;
                  if (reconnectsRef.current < MAX_RECONNECTS) {
                    reconnectsRef.current += 1;
                    youtubeState.update((s) => ({ ...s, status: RECONNECTING_STATUS }));
                    setReloadNonce((n) => n + 1);
                  } else {
                    youtubeState.update((s) => ({
                      ...s,
                      status: 'Stream stopped — it may have ended. Search again to retry.',
                    }));
                  }
                }
              } else {
                stalledSince = 0;
              }
            }
          } catch {
            /* player not ready yet */
          }
        }, 1000);
      })
      .catch((err) => {
        if (!cancelled) {
          youtubeState.update((s) => ({ ...s, status: String(err) }));
        }
      });

    return () => {
      cancelled = true;
      if (poll !== null) window.clearInterval(poll);
      const p = playerRef.current;
      if (p) {
        try {
          const t = p.getCurrentTime();
          if (typeof t === 'number' && t > 0) setPosition(t);
          p.destroy();
        } catch {
          /* already gone */
        }
      }
      playerRef.current = null;
      playerHostRef.current?.replaceChildren();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playbackKey, reloadNonce]);

  const isMusic = state.mode === 'music';

  // Music mode defaults to the CUSTOM player: keyless InnerTube search
  // (songs/albums/playlists) + the IFrame API player + the .yt-music transport
  // UI. No sign-in, no proxy. The real music.youtube.com site is available
  // behind an explicit toolbar toggle for browsing/discovery — it refuses to
  // be iframed directly (X-Frame-Options/CSP), so it loads through the app's
  // background proxy, which strips those guards.
  const [musicSiteOpen, setMusicSiteOpen] = useState(false);
  const [musicSitePort, setMusicSitePort] = useState<number | null>(null);

  // Leaving music mode always closes the embedded site.
  useEffect(() => {
    if (!isMusic) setMusicSiteOpen(false);
  }, [isMusic]);

  useEffect(() => {
    if (!musicSiteOpen) return;
    let cancelled = false;
    void (async () => {
      const { ensureProxyRunning } = await import('$lib/stores/preview');
      const port = await ensureProxyRunning();
      if (!cancelled) setMusicSitePort(port);
    })();
    // Opening the site: pause whatever the custom player is playing so its
    // audio doesn't fight the embedded site's.
    try {
      playerRef.current?.pauseVideo();
    } catch {
      /* player not ready */
    }
    return () => {
      cancelled = true;
    };
  }, [musicSiteOpen]);

  // Keep the album/playlist tracklist in sync with what's playing: fetch it
  // when a playlist/album loads (keyless InnerTube `next` call), clear it when
  // playback moves to a single track.
  useEffect(() => {
    if (currentPlaylistId) {
      void fetchAlbumTracks(currentPlaylistId);
    } else {
      clearAlbumTracks();
    }
  }, [currentPlaylistId]);

  function toggleMusicPlay() {
    const p = playerRef.current;
    if (!p) return;
    try {
      if (musicPlaying) {
        p.pauseVideo();
        setMusicPlaying(false);
      } else {
        p.playVideo();
        setMusicPlaying(true);
      }
    } catch {
      /* player not ready yet */
    }
  }

  function onMusicSeek(e: React.ChangeEvent<HTMLInputElement>) {
    const v = Number(e.target.value);
    setMusicProgress(v);
    const p = playerRef.current;
    if (!p) return;
    try {
      p.seekTo(v, true);
    } catch {
      /* player not ready yet */
    }
  }

  function playNext() {
    const p = playerRef.current;
    if (!p) return;
    try {
      (p as any).nextVideo?.();
    } catch {
      /* not ready / not a playlist */
    }
  }

  function playPrev() {
    const p = playerRef.current;
    if (!p) return;
    try {
      (p as any).previousVideo?.();
    } catch {
      /* not ready / not a playlist */
    }
  }

  const isNarrow = dimensions.width > 0 && dimensions.width < 500;
  const isShort = dimensions.height > 0 && dimensions.height < 450;
  const isMiniHeight = dimensions.height > 0 && dimensions.height < 250;

  const sizeClasses = [
    isNarrow ? 'yt-width-narrow' : '',
    isShort ? 'yt-height-short' : '',
    isMiniHeight ? 'yt-height-mini' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const activeTitle = trackDetails?.title || state.current?.title || '';
  const activeChannel = trackDetails?.channel || state.current?.channel || '';

  function getActiveArt() {
    if (trackDetails?.videoId) {
      return musicArt(trackDetails.videoId);
    }
    if (state.current?.thumbnail) {
      return state.current.thumbnail;
    }
    if (state.current?.videoId) {
      return musicArt(state.current.videoId);
    }
    return '';
  }

  return (
    <section ref={panelRef} className={`youtube-panel ${sizeClasses}`}>
      <header className="yt-toolbar">
        <button
          className="yt-icon-btn"
          title="Home (clear)"
          aria-label="Back to blank home"
          onClick={() => goHome()}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M3 11.5 12 4l9 7.5" />
            <path d="M5 10v9a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-9" />
          </svg>
        </button>
        <div className="yt-mode" role="tablist" aria-label="Search source">
          <button
            type="button"
            role="tab"
            aria-selected={state.mode === 'video'}
            className={`yt-mode-btn${state.mode === 'video' ? ' active' : ''}`}
            onClick={() => setMode('video')}
            title="Search YouTube videos"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polygon points="23 7 16 12 23 17 23 7" />
              <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
            </svg>
            <span className="yt-mode-text">Video</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={state.mode === 'music'}
            className={`yt-mode-btn${state.mode === 'music' ? ' active' : ''}`}
            onClick={() => setMode('music')}
            title="Search YouTube Music"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 18V5l12-2v13" />
              <circle cx="6" cy="18" r="3" />
              <circle cx="18" cy="16" r="3" />
            </svg>
            <span className="yt-mode-text">Music</span>
          </button>
        </div>
        {/* The search box drives both surfaces (keyless InnerTube search). It
            is only hidden while the embedded YT Music site is open — the site
            has its own search. */}
        {!musicSiteOpen && (
        <form className="yt-search" onSubmit={onSubmit}>
          <svg className="yt-search-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            value={state.query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={
              state.mode === 'music'
                ? isNarrow
                  ? 'Search Music…'
                  : 'Search YouTube Music, or paste a link…'
                : isNarrow
                  ? 'Search Video…'
                  : 'Search YouTube, or paste a video link…'
            }
            aria-label={state.mode === 'music' ? 'Search YouTube Music' : 'Search YouTube'}
          />
          <button type="submit" className="yt-go" disabled={state.loading} aria-label="Search">
            {state.loading ? '…' : (
              <>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="yt-go-icon">
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                <span className="yt-go-text">Search</span>
              </>
            )}
          </button>
        </form>
        )}
        {!musicSiteOpen && state.current && state.results.length > 0 && (
          <button
            className={`yt-icon-btn${resultsOpen ? ' active' : ''}`}
            title="Search results"
            aria-label="Toggle search results"
            onClick={() => setResultsOpen((v) => !v)}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
              <line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" />
              <line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" />
            </svg>
          </button>
        )}
        {isMusic && (
          <button
            className={`yt-icon-btn${musicSiteOpen ? ' active' : ''}`}
            title={musicSiteOpen ? 'Back to the player' : 'Open the YouTube Music site'}
            aria-label={musicSiteOpen ? 'Back to the player' : 'Open the YouTube Music site'}
            aria-pressed={musicSiteOpen}
            onClick={() => setMusicSiteOpen((v) => !v)}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <circle cx="12" cy="12" r="9" />
              <path d="M3 12h18" />
              <path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18" />
            </svg>
          </button>
        )}
        <button
          className={`yt-icon-btn${showSettings ? ' active' : ''}`}
          title="API key settings"
          aria-label="API key settings"
          onClick={() => setShowSettings((v) => !v)}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </header>

      {showSettings && (
        <div className="yt-settings">
          <label htmlFor="yt-api-key">YouTube Data API v3 key (optional)</label>
          <input
            id="yt-api-key"
            type="password"
            value={state.apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="Paste key to enable the search results grid"
          />
          <p className="yt-hint">
            Search works without a key. Adding a YouTube Data API key just switches
            search to the official API (useful if keyless results ever stop working).
          </p>
        </div>
      )}

      {/* Music sub-filters: what kind of result the keyless search returns.
          Hidden while the embedded site is open (it has its own filters). */}
      {isMusic && !musicSiteOpen && (
        <div className="yt-music-filters" role="tablist" aria-label="Music search filter">
          {(['songs', 'albums', 'playlists'] as MusicFilter[]).map((filter) => (
            <button
              key={filter}
              type="button"
              role="tab"
              aria-selected={state.musicFilter === filter}
              className={`yt-filter-pill${state.musicFilter === filter ? ' active' : ''}`}
              onClick={() => setMusicFilter(filter)}
            >
              {filter.charAt(0).toUpperCase() + filter.slice(1)}
            </button>
          ))}
        </div>
      )}

      <div className="yt-body">
        {/* Opt-in browsing surface: the real YouTube Music site, embedded
            through the background proxy (which strips its X-Frame-Options/CSP
            so it can render inside the panel). Unmounted when closed so its
            audio stops instead of fighting the custom player's. */}
        {isMusic && musicSiteOpen && (
          <div className="yt-music-site">
            {musicSitePort ? (
              <iframe
                className="yt-music-site-frame"
                title="YouTube Music"
                src={`http://127.0.0.1:${musicSitePort}/proxy/https/music.youtube.com/`}
                allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
              />
            ) : (
              <div className="yt-empty">
                <p>Starting YouTube Music…</p>
              </div>
            )}
          </div>
        )}

        {/* Results dropdown over the player — only while a video is playing. */}
        {!musicSiteOpen && resultsOpen && state.current && state.results.length > 0 && (
          <>
            <div className="yt-results-backdrop" onClick={() => setResultsOpen(false)} />
            <div className="yt-results-dropdown">
              <div className="yt-results-head">
                <span>Search results</span>
                <button
                  className="yt-results-close"
                  onClick={() => setResultsOpen(false)}
                  aria-label="Close results"
                >
                  ✕
                </button>
              </div>
              <div className="yt-results-list scrollable">
                {state.results.map((r) => (
                  <button
                    key={r.playlistId || r.videoId}
                    className={`yt-result-row${
                      (r.playlistId && r.playlistId === state.current?.playlistId) ||
                      (r.videoId && r.videoId === state.current?.videoId)
                        ? ' active'
                        : ''
                    }`}
                    onClick={() => {
                      void playMusicResult(r);
                      setResultsOpen(false);
                    }}
                  >
                    <div className="yt-result-thumb">
                      {r.thumbnail ? <img src={r.thumbnail} alt="" loading="lazy" /> : <div className="yt-thumb-fallback" />}
                      {r.type && r.type !== 'song' && r.type !== 'video' && (
                        <span className="yt-badge">{r.type}</span>
                      )}
                    </div>
                    <div className="yt-result-text">
                      <div className="yt-result-title" title={r.title}>{r.title}</div>
                      <div className="yt-result-channel">{r.channel}</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </>
        )}

        {/* The player host is always mounted (just hidden when idle) so the YT
            IFrame API can manage its lifecycle from the effect above. In music
            mode the host is pushed off-screen (it keeps the audio playing) and a
            dedicated music UI is shown instead — see .yt-player-music in the CSS. */}
        <div className={`yt-player${isMusic ? ' yt-player-music' : ''}`} style={{ display: !hasPlayer || musicSiteOpen ? 'none' : undefined }}>
          {state.current && (
            <button className="yt-back" onClick={() => youtubeState.update((s) => ({ ...s, current: null }))}>
              ← <span className="yt-back-text">Back to results</span>
            </button>
          )}

          {isMusic && state.current && (
            <div className="yt-music">
              <div className="yt-music-art">
                <img src={getActiveArt()} alt="" />
              </div>
              <div className="yt-music-details">
                <div className="yt-music-meta">
                  <div className="yt-music-title" title={activeTitle}>{activeTitle}</div>
                  {activeChannel && <div className="yt-music-artist">{activeChannel}</div>}
                </div>
                <div className="yt-music-controls">
                  <div className="yt-music-btns">
                    <button
                      type="button"
                      className="yt-music-prev"
                      onClick={playPrev}
                      disabled={!hasPlaylist}
                      title="Previous track"
                      aria-label="Previous track"
                    >
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M6 6h2v12H6zm3.5 6 8.5 6V6z" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      className="yt-music-play"
                      onClick={toggleMusicPlay}
                      aria-label={musicPlaying ? 'Pause' : 'Play'}
                      title={musicPlaying ? 'Pause' : 'Play'}
                    >
                      {musicPlaying ? (
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                          <rect x="6" y="5" width="4" height="14" rx="1" />
                          <rect x="14" y="5" width="4" height="14" rx="1" />
                        </svg>
                      ) : (
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M8 5v14l11-7z" />
                        </svg>
                      )}
                    </button>
                    <button
                      type="button"
                      className="yt-music-next"
                      onClick={playNext}
                      disabled={!hasPlaylist}
                      title="Next track"
                      aria-label="Next track"
                    >
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M6 18l8.5-6L6 6zm9-12h2v12h-2z" />
                      </svg>
                    </button>
                  </div>
                  <div className="yt-music-slider">
                    <span className="yt-music-time">{fmtTime(musicProgress)}</span>
                    <input
                      className="yt-music-seek"
                      type="range"
                      min={0}
                      max={musicDuration || 0}
                      step={1}
                      value={Math.min(musicProgress, musicDuration || 0)}
                      onChange={onMusicSeek}
                      aria-label="Seek"
                    />
                    <span className="yt-music-time">{fmtTime(musicDuration)}</span>
                  </div>
                </div>
              </div>

              {state.albumLoading && (
                <div className="yt-album-tracklist-loading">
                  Loading album tracks...
                </div>
              )}
              {!state.albumLoading && state.albumTracks && state.albumTracks.length > 0 && (
                <div className="yt-album-tracklist scrollable">
                  <div className="yt-tracklist-header">
                    {state.current?.type === 'album' ? 'Album Tracks' : 'Playlist Songs'}
                  </div>
                  <div className="yt-tracklist-rows">
                    {state.albumTracks.map((track, index) => {
                      const isCurrent = trackDetails?.videoId === track.videoId;
                      return (
                        <button
                          key={track.videoId}
                          className={`yt-track-row${isCurrent ? ' active' : ''}`}
                          onClick={() => {
                            const p = playerRef.current;
                            if (p && (p as any).playVideoAt) {
                              (p as any).playVideoAt(index);
                            }
                          }}
                        >
                          <span className="yt-track-num">
                            {isCurrent ? (
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M8 5v14l11-7z" />
                              </svg>
                            ) : (
                              index + 1
                            )}
                          </span>
                          <span className="yt-track-title" title={track.title}>{track.title}</span>
                          <span className="yt-track-duration">{track.channel}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="yt-player-frame" ref={playerHostRef} />

          {!isMusic && state.current?.title && <div className="yt-now-playing">{activeTitle}</div>}
        </div>

        {!musicSiteOpen && !state.current && state.results.length > 0 && (
          <div className="yt-grid scrollable">
            {state.results.map((r) => (
              <button key={r.playlistId || r.browseId || r.videoId} className="yt-card" onClick={() => void playMusicResult(r)}>
                <div className="yt-thumb">
                  {r.thumbnail ? <img src={r.thumbnail} alt="" loading="lazy" /> : <div className="yt-thumb-fallback" />}
                  {r.type && r.type !== 'song' && r.type !== 'video' && (
                    <span className="yt-badge">{r.type}</span>
                  )}
                </div>
                <div className="yt-card-title" title={r.title}>{r.title}</div>
                <div className="yt-card-channel">{r.channel}</div>
              </button>
            ))}
          </div>
        )}

        {!musicSiteOpen && !hasPlayer && state.results.length === 0 && (
          <div className="yt-empty">
            {isMusic ? (
              <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4">
                <path d="M9 18V5l12-2v13" />
                <circle cx="6" cy="18" r="3" />
                <circle cx="18" cy="16" r="3" />
              </svg>
            ) : (
              <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4">
                <rect x="2" y="5" width="20" height="14" rx="4" />
                <path d="m10 9 5 3-5 3z" />
              </svg>
            )}
            <p>
              {isMusic
                ? 'Search for songs, albums, or playlists — or paste a YouTube Music link.'
                : 'Search for something or paste a YouTube link to start watching.'}
            </p>
          </div>
        )}

        {state.status && <div className="yt-status">{state.status}</div>}
      </div>
    </section>
  );
}
