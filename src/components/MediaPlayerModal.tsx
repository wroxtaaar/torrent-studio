import React, { useState, useRef, useEffect } from 'react';
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize,
  Minimize,
  RotateCcw,
  RotateCw,
  ExternalLink,
  Download,
  Copy,
  Check,
  Music,
  Video,
  X,
  Minimize2,
  Maximize2
} from 'lucide-react';
import { StorageFile } from '../types/index.ts';
import { formatBytes, formatDuration } from '../utils/formatters.ts';
import Hls from 'hls.js';

interface MediaPlayerModalProps {
  file: StorageFile | null;
  onClose: () => void;
  isMinimized: boolean;
  onToggleMinimize: () => void;
}

export const MediaPlayerModal: React.FC<MediaPlayerModalProps> = ({
  file,
  onClose,
  isMinimized,
  onToggleMinimize
}) => {
  const [isPlaying, setIsPlaying] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [mediaError, setMediaError] = useState('');
  const [usingDirectFallback, setUsingDirectFallback] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hlsRef = useRef<Hls | null>(null);

  const isVideo = file?.type === 'video';
  const mediaRef = isVideo ? videoRef : audioRef;

  useEffect(() => {
    setCurrentTime(0);
    setDuration(0);
    setIsPlaying(true);
    setMediaError('');
    setUsingDirectFallback(false);
  }, [file?.id]);

  useEffect(() => {
    const media = mediaRef.current;
    if (!media || !file) return;

    setMediaError('');
    setUsingDirectFallback(false);

    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    const directUrl = file.streamUrl.includes('/api/torrents/stream/')
      ? file.streamUrl.replace('/api/torrents/stream/', '/api/torrents/direct-stream/')
      : file.streamUrl.includes('/api/files/hls/')
      ? file.streamUrl.replace('/api/files/hls/', '/api/files/direct-stream/').replace(/\/index\.m3u8$/, '')
      : file.streamUrl;

    const useDirectVideo = () => {
      setUsingDirectFallback(true);
      setMediaError('');
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      media.pause();
      media.src = directUrl;
      media.load();
      media.play().then(() => setIsPlaying(true)).catch(() => {});
    };

    if (!isVideo) {
      media.src = file.streamUrl;
      media.load();
      return () => {
        media.pause();
        media.removeAttribute('src');
        media.load();
      };
    }

    // Prefer native HLS on browsers that provide it.
    if (media.canPlayType('application/vnd.apple.mpegurl') && !usingDirectFallback) {
      media.src = file.streamUrl;
      media.load();
      return () => {
        media.pause();
        media.removeAttribute('src');
        media.load();
      };
    }

    // Use the native fragmented-MP4 stream for in-app playback.
    // This avoids MediaSource/HLS reset errors on mobile browsers.
    useDirectVideo();


    return () => {
      media.pause();
      media.removeAttribute('src');
      media.load();
    };
  }, [file?.id, file?.streamUrl, isVideo]);

  if (!file) return null;

  const handleMediaError = () => {
    const media = mediaRef.current;
    const code = media && 'error' in media ? media.error?.code : undefined;
    setMediaError(
      code ? `Browser could not play this stream (media error ${code}).` : 'Unable to play this video stream.'
    );
    setIsPlaying(false);
  };

  // Toggle play/pause
  const togglePlay = () => {
    if (!mediaRef.current) return;
    if (isPlaying) {
      mediaRef.current.pause();
    } else {
      mediaRef.current.play();
    }
    setIsPlaying(!isPlaying);
  };

  // Seek
  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const time = parseFloat(e.target.value);
    setCurrentTime(time);
    if (mediaRef.current) {
      mediaRef.current.currentTime = time;
    }
  };

  // Skip
  const skip = (seconds: number) => {
    if (!mediaRef.current) return;
    mediaRef.current.currentTime = Math.max(0, Math.min(duration, mediaRef.current.currentTime + seconds));
  };

  // Volume
  const handleVolume = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    setVolume(val);
    setIsMuted(val === 0);
    if (mediaRef.current) {
      mediaRef.current.volume = val;
    }
  };

  const toggleMute = () => {
    if (!mediaRef.current) return;
    if (isMuted) {
      mediaRef.current.volume = volume || 0.8;
      setIsMuted(false);
    } else {
      mediaRef.current.volume = 0;
      setIsMuted(true);
    }
  };

  // Speed
  const handleSpeedChange = (speed: number) => {
    setPlaybackSpeed(speed);
    if (mediaRef.current) {
      mediaRef.current.playbackRate = speed;
    }
  };

  // Fullscreen
  const toggleFullscreen = () => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen?.();
      setIsFullscreen(true);
    } else {
      document.exitFullscreen?.();
      setIsFullscreen(false);
    }
  };

  // Copy Direct Stream URL
  const copyStreamUrl = () => {
    const fullUrl = window.location.origin + file.streamUrl;
    navigator.clipboard.writeText(fullUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Picture in Picture
  const togglePip = async () => {
    if (videoRef.current && document.pictureInPictureEnabled) {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else {
        await videoRef.current.requestPictureInPicture();
      }
    }
  };

  // Time update
  const onTimeUpdate = () => {
    if (mediaRef.current) {
      setCurrentTime(mediaRef.current.currentTime);
    }
  };

  const onLoadedMetadata = () => {
    if (mediaRef.current) {
      setDuration(mediaRef.current.duration || file.duration || 600);
      mediaRef.current.play().then(() => setIsPlaying(true)).catch(() => setIsPlaying(false));
    }
  };

  // Minimized floating player (for multitasking while downloading or browsing folders)
  if (isMinimized) {
    return (
      <div className="fixed bottom-16 md:bottom-6 right-4 z-50 w-80 md:w-96 bg-slate-900/95 backdrop-blur-xl border border-slate-700 shadow-2xl rounded-2xl p-3.5 flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 overflow-hidden">
            <div className="p-2 rounded-lg bg-cyan-500/10 text-cyan-400">
              {isVideo ? <Video className="w-4 h-4" /> : <Music className="w-4 h-4" />}
            </div>
            <div className="truncate">
              <p className="text-xs font-semibold text-slate-200 truncate">{file.name}</p>
              <p className="text-[10px] text-slate-400">{formatDuration(currentTime)} / {formatDuration(duration || file.duration || 0)}</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={onToggleMinimize}
              className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-slate-200"
              title="Expand"
            >
              <Maximize2 className="w-4 h-4" />
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-slate-200"
              title="Close Player"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Hidden or small video preview */}
        {isVideo ? (
          <video
            ref={videoRef}
            src={file.streamUrl}
            className="w-full h-32 object-contain bg-black rounded-lg"
            onTimeUpdate={onTimeUpdate}
            onLoadedMetadata={onLoadedMetadata}
            onEnded={() => setIsPlaying(false)}
          />
        ) : (
          <audio
            ref={audioRef}
            src={file.streamUrl}
            onTimeUpdate={onTimeUpdate}
            onLoadedMetadata={onLoadedMetadata}
            onEnded={() => setIsPlaying(false)}
          />
        )}

        {/* Mini Controls */}
        <div className="flex items-center justify-between pt-1">
          <button
            onClick={() => skip(-10)}
            className="p-1.5 rounded text-slate-400 hover:text-slate-200"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={togglePlay}
            className="p-2 rounded-full bg-cyan-500 text-slate-950 font-bold hover:bg-cyan-400 transition"
          >
            {isPlaying ? <Pause className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current" />}
          </button>
          <button
            onClick={() => skip(10)}
            className="p-1.5 rounded text-slate-400 hover:text-slate-200"
          >
            <RotateCw className="w-3.5 h-3.5" />
          </button>
          <div className="flex items-center gap-1.5 ml-2">
            <button onClick={toggleMute} className="text-slate-400 hover:text-slate-200">
              {isMuted ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>

        {/* Scrubber */}
        <input
          type="range"
          min={0}
          max={duration || file.duration || 100}
          value={currentTime}
          onChange={handleSeek}
          className="w-full h-1 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-cyan-400"
        />
      </div>
    );
  }

  // Full Player Modal
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 md:p-6 bg-black/80 backdrop-blur-md">
      <div
        ref={containerRef}
        className="relative w-full max-w-4xl bg-slate-900 border border-slate-700/80 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[95vh]"
      >
        {/* Top Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800 bg-slate-900/90 z-10">
          <div className="flex items-center gap-3 overflow-hidden">
            <div className="p-2 rounded-xl bg-cyan-500/10 text-cyan-400">
              {isVideo ? <Video className="w-5 h-5" /> : <Music className="w-5 h-5" />}
            </div>
            <div className="truncate">
              <h3 className="text-sm md:text-base font-semibold text-slate-100 truncate">{file.name}</h3>
              <p className="text-xs text-slate-400 flex items-center gap-2">
                <span>{formatBytes(file.size)}</span>
                <span>•</span>
                <span className="text-emerald-400 font-medium">
                  Direct Browser Streaming
                </span>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={copyStreamUrl}
              className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-300 flex items-center gap-1.5 transition"
              title="Copy Direct Streaming Link"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              <span className="hidden sm:inline">{copied ? 'Copied' : 'Stream URL'}</span>
            </button>

            <a
              href={file.downloadUrl}
              download={file.name}
              className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-300 flex items-center gap-1.5 transition"
              title="Direct Download File"
            >
              <Download className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Download</span>
            </a>

            <button
              onClick={onToggleMinimize}
              className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition"
              title="Minimize to Floating Player"
            >
              <Minimize2 className="w-4 h-4" />
            </button>

            <button
              onClick={onClose}
              className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition"
              title="Close Player"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Media Viewport */}
        <div className="relative flex-1 bg-black flex items-center justify-center min-h-[260px] md:min-h-[420px] overflow-hidden">
          {mediaError && (
            <div className="absolute inset-0 z-10 flex items-center justify-center p-6 text-center">
              <div className="max-w-md rounded-xl bg-slate-900/95 border border-rose-500/30 p-5">
                <p className="text-sm font-semibold text-rose-300">{mediaError}</p>
                <p className="text-xs text-slate-400 mt-2">
                  The VPS sends a browser-compatible fragmented MP4 stream.
                </p>
              </div>
            </div>
          )}
          {isVideo ? (
            <video
              ref={videoRef}
              className="w-full h-full max-h-[60vh] object-contain cursor-pointer"
              onClick={togglePlay}
              onTimeUpdate={onTimeUpdate}
              onLoadedMetadata={onLoadedMetadata}
              onEnded={() => setIsPlaying(false)}
              onError={handleMediaError}
            />
          ) : (
            <div className="flex flex-col items-center justify-center p-8 text-center gap-4">
              <div className="w-24 h-24 rounded-full bg-gradient-to-tr from-cyan-500 to-indigo-600 flex items-center justify-center shadow-lg shadow-cyan-500/20 animate-pulse-subtle">
                <Music className="w-12 h-12 text-white" />
              </div>
              <div>
                <h4 className="text-lg font-bold text-slate-100">{file.name}</h4>
                <p className="text-sm text-slate-400 mt-1">Lossless Cloud Audio Playback</p>
              </div>

              {/* Dynamic waveform simulation */}
              <div className="flex items-center gap-1 h-12 mt-2">
                {[40, 65, 30, 85, 95, 45, 75, 55, 90, 60, 35, 70, 80, 50, 65, 85, 40, 70].map((h, i) => (
                  <div
                    key={i}
                    className="w-1.5 bg-gradient-to-t from-cyan-500 to-indigo-400 rounded-full transition-all duration-300"
                    style={{
                      height: isPlaying ? `${Math.max(12, (h * (0.4 + (i % 3) * 0.3)))}px` : '8px',
                      opacity: isPlaying ? 1 : 0.4
                    }}
                  />
                ))}
              </div>

              <audio
                ref={audioRef}
                src={file.streamUrl}
                onTimeUpdate={onTimeUpdate}
                onLoadedMetadata={onLoadedMetadata}
                onEnded={() => setIsPlaying(false)}
              />
            </div>
          )}
        </div>

        {/* Player Controls Bar */}
        <div className="p-4 bg-slate-900 border-t border-slate-800 flex flex-col gap-3">
          {/* Scrubber and Time */}
          <div className="flex items-center gap-3">
            <span className="text-xs font-mono text-slate-400 w-12 text-right">
              {formatDuration(currentTime)}
            </span>
            <div className="relative flex-1 group">
              <input
                type="range"
                min={0}
                max={duration || file.duration || 100}
                value={currentTime}
                onChange={handleSeek}
                className="w-full h-2 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-cyan-400 hover:h-2.5 transition-all"
              />
            </div>
            <span className="text-xs font-mono text-slate-400 w-12">
              {formatDuration(duration || file.duration || 0)}
            </span>
          </div>

          {/* Main Controls row */}
          <div className="flex items-center justify-between flex-wrap gap-3">
            {/* Left: Playback buttons */}
            <div className="flex items-center gap-2">
              <button
                onClick={() => skip(-10)}
                className="p-2 rounded-lg bg-slate-800/80 hover:bg-slate-700 text-slate-300 transition"
                title="Rewind 10 seconds"
              >
                <RotateCcw className="w-4 h-4" />
              </button>

              <button
                onClick={togglePlay}
                className="p-3 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold transition shadow-lg shadow-cyan-500/20"
                title={isPlaying ? 'Pause' : 'Play'}
              >
                {isPlaying ? <Pause className="w-5 h-5 fill-current" /> : <Play className="w-5 h-5 fill-current" />}
              </button>

              <button
                onClick={() => skip(10)}
                className="p-2 rounded-lg bg-slate-800/80 hover:bg-slate-700 text-slate-300 transition"
                title="Forward 10 seconds"
              >
                <RotateCw className="w-4 h-4" />
              </button>

              {/* Volume */}
              <div className="flex items-center gap-2 ml-2 pl-2 border-l border-slate-800">
                <button
                  onClick={toggleMute}
                  className="p-2 rounded-lg text-slate-400 hover:text-slate-200"
                >
                  {isMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
                </button>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={isMuted ? 0 : volume}
                  onChange={handleVolume}
                  className="w-16 sm:w-24 h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-cyan-400"
                />
              </div>
            </div>

            {/* Right: Speed, PiP, Fullscreen */}
            <div className="flex items-center gap-2">
              {/* Playback Speed selector */}
              <div className="flex items-center bg-slate-800/80 rounded-lg p-0.5 text-xs font-medium text-slate-300">
                {[0.75, 1, 1.25, 1.5, 2].map((s) => (
                  <button
                    key={s}
                    onClick={() => handleSpeedChange(s)}
                    className={`px-2 py-1 rounded-md transition ${
                      playbackSpeed === s
                        ? 'bg-cyan-500 text-slate-950 font-bold'
                        : 'hover:text-white'
                    }`}
                  >
                    {s}x
                  </button>
                ))}
              </div>

              {/* PiP (video only) */}
              {isVideo && (
                <button
                  onClick={togglePip}
                  className="p-2 rounded-lg bg-slate-800/80 hover:bg-slate-700 text-slate-300 transition"
                  title="Picture in Picture"
                >
                  <ExternalLink className="w-4 h-4" />
                </button>
              )}

              {/* Fullscreen */}
              <button
                onClick={toggleFullscreen}
                className="p-2 rounded-lg bg-slate-800/80 hover:bg-slate-700 text-slate-300 transition"
                title="Fullscreen"
              >
                {isFullscreen ? <Minimize className="w-4 h-4" /> : <Maximize className="w-4 h-4" />}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
