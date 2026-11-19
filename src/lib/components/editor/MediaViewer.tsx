import { useEffect, useState } from 'react';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { fileName, formatBytes } from './ImageViewer.tsx';
import './ImageViewer.css';

interface Props {
  kind: 'audio' | 'video';
  /** Stream URL; when missing, the file is allowed and streamed from disk. */
  src: string | null;
  path: string;
  mimeType?: string | null;
  size?: number | null;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${rest}` : `${m}:${rest}`;
}

/** The editor's audio and video tabs: the platform player, centered. */
export default function MediaViewer({ kind, src: givenSrc, path, mimeType = null, size = null }: Props) {
  const [ownSrc, setOwnSrc] = useState<string | null>(null);
  useEffect(() => {
    setOwnSrc(null);
    if (givenSrc) return;
    let cancelled = false;
    invoke('fs_allow_media', { path })
      .then(() => { if (!cancelled) setOwnSrc(convertFileSrc(path)); })
      .catch(() => { if (!cancelled) setOwnSrc(''); });
    return () => { cancelled = true; };
  }, [givenSrc, path]);
  const src = givenSrc || ownSrc;
  const [duration, setDuration] = useState<number | null>(null);
  const [videoSize, setVideoSize] = useState<{ w: number; h: number } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setDuration(null);
    setVideoSize(null);
    setFailed(false);
  }, [src]);

  const onLoaded = (event: React.SyntheticEvent<HTMLMediaElement>) => {
    const el = event.currentTarget;
    setDuration(el.duration);
    if (el instanceof HTMLVideoElement && el.videoWidth) setVideoSize({ w: el.videoWidth, h: el.videoHeight });
  };

  const type = mimeType?.split('/')[1]?.replace(/^x-/, '').toUpperCase();
  const name = fileName(path);

  return (
    <div className="media-viewer">
      <div className="image-meta-bar">
        <span className="meta-pill meta-name" title={path}>{name}</span>
        {type && <span className="meta-pill">{type}</span>}
        {videoSize && <span className="meta-pill">{videoSize.w} × {videoSize.h}</span>}
        {duration ? <span className="meta-pill">{formatDuration(duration)}</span> : null}
        {size ? <span className="meta-pill">{formatBytes(size)}</span> : null}
      </div>
      <div className="media-stage">
        {src === null ? null : failed || !src ? (
          <div className="media-error">
            This {kind} could not be played. The format may not be supported here
            {kind === 'video' ? ' (MP4 / H.264 and WebM play best).' : ' (MP3, WAV, OGG, M4A and FLAC play best).'}
          </div>
        ) : kind === 'video' ? (
          <video
            key={src}
            src={src}
            controls
            preload="metadata"
            onLoadedMetadata={onLoaded}
            onError={() => setFailed(true)}
          />
        ) : (
          <div className="media-audio-card">
            <div className="media-audio-icon" aria-hidden="true">
              <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 18V5l12-2v13" />
                <circle cx="6" cy="18" r="3" />
                <circle cx="18" cy="16" r="3" />
              </svg>
            </div>
            <div className="media-audio-name" title={path}>{name}</div>
            <audio
              key={src}
              src={src}
              controls
              preload="metadata"
              onLoadedMetadata={onLoaded}
              onError={() => setFailed(true)}
            />
          </div>
        )}
      </div>
    </div>
  );
}
