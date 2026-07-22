import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { isTauriRuntime } from '$lib/utils/tauri';
import { useStore } from '$lib/react/useStore';
import {
  musicLibraryState,
  scanFolder,
  refreshLibrary,
  playTrack,
  togglePlay,
  playNext,
  playPrevious,
  seek,
  setVolume,
  toggleShuffle,
  cycleRepeat,
  setFilter,
  revealInFolder,
  clearLibrary,
  visibleTracks,
  formatTime,
} from '$lib/stores/musicLibrary';
import './LocalMusicPanel.css';

/** Where to get a stream-safe library from. StreamBeats is free, needs no
 *  attribution, and every track is pre-registered with YouTube Content ID and
 *  Twitch Audible Magic as cleared — which is why it doesn't get claimed.
 *  Spacron only ever links to it; the files stay the user's own download. */
const STREAMBEATS_URL = 'https://streambeats.com/';

/** Local-files music source. Plays audio straight off disk through the asset
 *  protocol, so nothing here depends on the network, a playlist staying
 *  intact, or an embed that might serve an ad mid-stream. */
export default function LocalMusicPanel() {
  const state = useStore(musicLibraryState);
  const [picking, setPicking] = useState(false);
  const [showLicenses, setShowLicenses] = useState(false);
  // The library is scanned once per mount, not on every state change — the
  // scan also re-grants asset-protocol access, which is lost on restart.
  const restored = useRef(false);

  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    void refreshLibrary();
  }, []);

  async function openStreamBeats() {
    if (!isTauriRuntime()) {
      window.open(STREAMBEATS_URL, '_blank', 'noopener,noreferrer');
      return;
    }
    try {
      await invoke('preview_open_in_browser', { url: STREAMBEATS_URL });
    } catch {
      /* browser refused to open — the URL is shown in the hint below anyway */
    }
  }

  async function chooseFolder() {
    setPicking(true);
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const picked = await open({ directory: true, multiple: false, title: 'Choose your music folder' });
      if (typeof picked === 'string') await scanFolder(picked);
    } catch {
      /* user cancelled the dialog */
    } finally {
      setPicking(false);
    }
  }

  const tracks = visibleTracks(state);
  const current = state.tracks.find((t) => t.path === state.currentPath) ?? null;
  const progress = state.duration > 0 ? (state.position / state.duration) * 100 : 0;

  // --- empty state: no folder chosen yet ---------------------------------
  if (!state.folder) {
    return (
      <div className="lm-panel">
        <div className="lm-empty">
          <svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3">
            <path d="M9 18V5l12-2v13" />
            <circle cx="6" cy="18" r="3" />
            <circle cx="18" cy="16" r="3" />
          </svg>
          <h3>Play music from your own folder</h3>
          <p>
            Point Spacron at a folder of audio files and it plays them straight off disk — no ads,
            no network, nothing that can drop out mid-stream.
          </p>
          <div className="lm-empty-actions">
            <button type="button" className="lm-primary" onClick={chooseFolder} disabled={picking}>
              {picking ? 'Choosing…' : 'Choose music folder'}
            </button>
            <button type="button" className="lm-secondary" onClick={openStreamBeats}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <path d="M7 10l5 5 5-5" />
                <path d="M12 15V3" />
              </svg>
              Get StreamBeats
            </button>
          </div>

          <div className="lm-tip">
            <strong>No music yet?</strong> StreamBeats is free, needs no credit in your
            description, and is cleared with Content ID — so it won't get claimed. Download
            the genres you want, then pick that folder above.
          </div>

          {state.status && <div className="lm-status">{state.status}</div>}
        </div>
      </div>
    );
  }

  return (
    <div className="lm-panel">
      {/* --- library toolbar ------------------------------------------- */}
      <div className="lm-toolbar">
        <div className="lm-search">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            value={state.filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by title, artist, or album…"
            aria-label="Filter tracks"
          />
        </div>
        <span className="lm-count">
          {tracks.length}
          {tracks.length === 1 ? ' track' : ' tracks'}
        </span>
        {state.licenseFiles.length > 0 && (
          <button
            type="button"
            className={`lm-icon-btn${showLicenses ? ' active' : ''}`}
            title={`${state.licenseFiles.length} licence file(s) found — keep these for Content ID disputes`}
            aria-label="Show licence files"
            aria-pressed={showLicenses}
            onClick={() => setShowLicenses((v) => !v)}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <path d="M14 2v6h6" />
            </svg>
          </button>
        )}
        <button
          type="button"
          className="lm-icon-btn"
          title="Get more free, claim-free music from StreamBeats"
          aria-label="Get StreamBeats music"
          onClick={openStreamBeats}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <path d="M7 10l5 5 5-5" />
            <path d="M12 15V3" />
          </svg>
        </button>
        <button
          type="button"
          className="lm-icon-btn"
          title="Rescan folder"
          aria-label="Rescan folder"
          onClick={() => void refreshLibrary()}
          disabled={state.loading}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M21 12a9 9 0 1 1-2.64-6.36" />
            <path d="M21 3v6h-6" />
          </svg>
        </button>
        <button type="button" className="lm-icon-btn" title="Change folder" aria-label="Change folder" onClick={chooseFolder}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          </svg>
        </button>
      </div>

      <div className="lm-folder" title={state.folder}>
        {state.folder}
        <button type="button" className="lm-unlink" onClick={clearLibrary} title="Forget this folder">
          Forget
        </button>
      </div>

      {showLicenses && state.licenseFiles.length > 0 && (
        <div className="lm-licenses">
          <div className="lm-licenses-head">
            Licence files — proof of rights if a track is ever claimed
          </div>
          {state.licenseFiles.map((path) => (
            <button
              key={path}
              type="button"
              className="lm-license-row"
              onClick={() => void revealInFolder(path)}
              title={path}
            >
              {path.split(/[\\/]/).pop()}
            </button>
          ))}
        </div>
      )}

      {state.status && <div className="lm-status">{state.status}</div>}

      {/* --- track list ------------------------------------------------- */}
      <div className="lm-list scrollable">
        {state.loading && <div className="lm-loading">Scanning folder…</div>}
        {!state.loading && tracks.length === 0 && (
          <div className="lm-none">{state.filter ? 'No tracks match that filter.' : 'No audio files in this folder.'}</div>
        )}
        {tracks.map((track) => {
          const active = track.path === state.currentPath;
          return (
            <button
              key={track.path}
              type="button"
              className={`lm-row${active ? ' active' : ''}`}
              onClick={() => playTrack(track.path)}
              title={track.path}
            >
              <span className="lm-row-icon">
                {active && state.playing ? (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="6" y="4" width="4" height="16" rx="1" />
                    <rect x="14" y="4" width="4" height="16" rx="1" />
                  </svg>
                ) : (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                )}
              </span>
              <span className="lm-row-main">
                <span className="lm-row-title">{track.title}</span>
                <span className="lm-row-sub">
                  {track.artist || track.album || track.ext.toUpperCase()}
                </span>
              </span>
              <span className="lm-row-ext">{track.ext}</span>
            </button>
          );
        })}
      </div>

      {/* --- transport -------------------------------------------------- */}
      {current && (
        <div className="lm-transport">
          <div className="lm-now">
            <div className="lm-now-title" title={current.title}>{current.title}</div>
            {(current.artist || current.album) && (
              <div className="lm-now-sub">{current.artist || current.album}</div>
            )}
          </div>

          <div className="lm-seek">
            <span className="lm-time">{formatTime(state.position)}</span>
            <input
              type="range"
              className="lm-seek-bar"
              min={0}
              max={state.duration || 0}
              step={0.1}
              value={state.position}
              onChange={(e) => seek(Number(e.target.value))}
              aria-label="Seek"
              style={{ ['--lm-progress' as string]: `${progress}%` }}
            />
            <span className="lm-time">{formatTime(state.duration)}</span>
          </div>

          <div className="lm-controls">
            <button
              type="button"
              className={`lm-ctl${state.shuffle ? ' on' : ''}`}
              onClick={toggleShuffle}
              title="Shuffle"
              aria-pressed={state.shuffle}
              aria-label="Shuffle"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M16 3h5v5" />
                <path d="M4 20 21 3" />
                <path d="M21 16v5h-5" />
                <path d="m15 15 6 6" />
                <path d="M4 4l5 5" />
              </svg>
            </button>
            <button type="button" className="lm-ctl" onClick={playPrevious} title="Previous" aria-label="Previous track">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M6 6h2v12H6zm3 6 9 6V6z" />
              </svg>
            </button>
            <button
              type="button"
              className="lm-ctl lm-play"
              onClick={togglePlay}
              title={state.playing ? 'Pause' : 'Play'}
              aria-label={state.playing ? 'Pause' : 'Play'}
            >
              {state.playing ? (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="6" y="4" width="4" height="16" rx="1" />
                  <rect x="14" y="4" width="4" height="16" rx="1" />
                </svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M8 5v14l11-7z" />
                </svg>
              )}
            </button>
            <button type="button" className="lm-ctl" onClick={() => playNext()} title="Next" aria-label="Next track">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M16 6h2v12h-2zM6 18l9-6-9-6z" />
              </svg>
            </button>
            <button
              type="button"
              className={`lm-ctl${state.repeat !== 'off' ? ' on' : ''}`}
              onClick={cycleRepeat}
              title={`Repeat: ${state.repeat}`}
              aria-label={`Repeat ${state.repeat}`}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M17 2l4 4-4 4" />
                <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
                <path d="M7 22l-4-4 4-4" />
                <path d="M21 13v1a4 4 0 0 1-4 4H3" />
              </svg>
              {state.repeat === 'one' && <span className="lm-repeat-one">1</span>}
            </button>

            <div className="lm-volume">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M11 5 6 9H2v6h4l5 4z" />
                {state.volume > 0.05 && <path d="M15.5 8.5a5 5 0 0 1 0 7" />}
              </svg>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={state.volume}
                onChange={(e) => setVolume(Number(e.target.value))}
                aria-label="Volume"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
