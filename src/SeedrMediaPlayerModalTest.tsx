import React, { useState } from 'react';
import { MediaPlayerModal } from './components/MediaPlayerModal';
import { StorageFile } from './types/index';

const initialUrl = '';

export default function SeedrMediaPlayerModalTest() {
  const [url, setUrl] = useState(initialUrl);
  const [activeUrl, setActiveUrl] = useState('');
  const [open, setOpen] = useState(false);

  const startTest = () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    setActiveUrl(trimmed);
    setOpen(true);
  };

  const file: StorageFile | null = activeUrl
    ? {
        id: 'seedr-browser-modal-test',
        name: 'Seedr Browser Test.mkv',
        path: 'Seedr Browser Test.mkv',
        folder: '/',
        size: 0,
        type: 'video',
        mimeType: 'video/x-matroska',
        createdAt: Date.now(),
        isStreamable: true,
        ownerId: 'test',
        ownerName: 'Seedr Test',
        downloadUrl: activeUrl,
        streamUrl: activeUrl
      }
    : null;

  return (
    <main style={{
      minHeight: '100vh',
      background: '#020617',
      color: '#e2e8f0',
      padding: '32px',
      fontFamily: 'system-ui, sans-serif'
    }}>
      <div style={{ maxWidth: 1100, margin: '0 auto' }}>
        <h1 style={{ fontSize: 30, marginBottom: 8 }}>Seedr → MediaPlayerModal Test</h1>
        <p style={{ color: '#94a3b8', marginBottom: 24 }}>
          Same direct Seedr URL, but now rendered by Torrent Studio's actual MediaPlayerModal component.
          No qBittorrent stream endpoint or Torrent Studio backend is used.
        </p>

        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Paste the direct Seedr URL"
          style={{
            width: '100%',
            boxSizing: 'border-box',
            padding: '14px',
            borderRadius: 10,
            border: '1px solid #334155',
            background: '#0f172a',
            color: '#e2e8f0',
            marginBottom: 12
          }}
        />

        <button
          type="button"
          onClick={startTest}
          style={{
            padding: '11px 18px',
            borderRadius: 9,
            border: 0,
            background: '#06b6d4',
            color: '#020617',
            fontWeight: 800,
            cursor: 'pointer'
          }}
        >
          Open MediaPlayerModal
        </button>

        <div style={{
          marginTop: 24,
          padding: 16,
          borderRadius: 10,
          border: '1px solid #1e293b',
          background: '#0f172a',
          color: '#94a3b8',
          lineHeight: 1.6
        }}>
          <strong style={{ color: '#e2e8f0' }}>Test:</strong> play the video, seek forward/backward several times,
          pause/resume, and try fullscreen/PiP. If playback fails, the modal should display its media error.
        </div>
      </div>

      <MediaPlayerModal
        file={open ? file : null}
        onClose={() => setOpen(false)}
        isMinimized={false}
        onToggleMinimize={() => {}}
      />
    </main>
  );
}
