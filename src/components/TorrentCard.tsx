import React from 'react';
import {
  Download,
  Upload,
  Pause,
  Play,
  Trash2,
  FileCheck,
  CheckCircle2,
  Clock,
  Users,
  Activity,
  ChevronRight,
  FolderDown
} from 'lucide-react';
import { TorrentItem } from '../types/index.ts';
import { formatBytes, formatSpeed, formatETA } from '../utils/formatters.ts';

interface TorrentCardProps {
  torrent: TorrentItem;
  onPause: (hash: string) => Promise<void>;
  onResume: (hash: string) => Promise<void>;
  onDelete: (hash: string) => void;
  onSelectFiles: (torrent: TorrentItem) => void;
}

export const TorrentCard: React.FC<TorrentCardProps> = ({
  torrent,
  onPause,
  onResume,
  onDelete,
  onSelectFiles
}) => {
  const isCompleted = torrent.state === 'completed' || torrent.progress >= 1;
  const isDownloading = torrent.state === 'downloading';
  const isPaused = torrent.state === 'pausedDL';

  const totalFiles = torrent.files?.length || 1;
  const activeFiles = torrent.files ? torrent.files.filter(f => f.priority > 0).length : totalFiles;
  const skippedFiles = totalFiles - activeFiles;
  const downloadTargetSize = torrent.selected_size && torrent.selected_size > 0 ? torrent.selected_size : torrent.total_size;

  const progressPercent = Math.round(torrent.progress * 1000) / 10;

  return (
    <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800 hover:border-slate-700/80 transition shadow-lg flex flex-col gap-3 group">
      {/* Top row: Title and Status */}
      <div className="flex items-start justify-between gap-2">
        <div className="overflow-hidden flex-1">
          <div className="flex items-center gap-2">
            <span
              className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${
                isCompleted
                  ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                  : isDownloading
                  ? 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 animate-pulse'
                  : 'bg-slate-800 text-slate-400'
              }`}
            >
              {torrent.state}
            </span>
            <span className="text-[11px] text-slate-500 font-medium">
              {torrent.category || 'Downloads'}
            </span>
          </div>
          <h3 className="text-sm font-semibold text-slate-100 mt-1 truncate group-hover:text-cyan-400 transition" title={torrent.name}>
            {torrent.name}
          </h3>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-1 shrink-0">
          {/* Selective Files inspector */}
          <button
            onClick={() => onSelectFiles(torrent)}
            className="p-2 rounded-xl bg-slate-800/80 hover:bg-slate-700 text-slate-300 hover:text-cyan-400 text-xs font-medium transition flex items-center gap-1.5 tap-target justify-center"
            title="Inspect & Select Files"
          >
            <FileCheck className="w-4 h-4 text-cyan-400" />
            <span className="hidden sm:inline text-xs">
              {skippedFiles > 0 ? `${activeFiles}/${totalFiles} files (${skippedFiles} skipped)` : `${totalFiles} files`}
            </span>
          </button>

          {/* Direct Download for completed torrents */}
          {isCompleted && (
            <a
              href={`/api/torrents/download/${torrent.hash}`}
              download={activeFiles === 1 ? (torrent.files.find(f => f.priority > 0)?.name || torrent.name) : `${torrent.name}.zip`}
              className="px-2.5 py-1.5 rounded-xl bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-400 text-xs font-semibold transition tap-target flex items-center gap-1.5 justify-center"
              title={activeFiles === 1 ? 'Download Completed File' : 'Download All Files (.zip)'}
            >
              <Download className="w-4 h-4" />
              <span className="hidden sm:inline text-xs font-bold">
                {activeFiles === 1 ? 'Download' : 'Download ZIP'}
              </span>
            </a>
          )}

          {/* Pause / Resume */}
          {isDownloading && (
            <button
              onClick={() => onPause(torrent.hash)}
              className="p-2 rounded-xl bg-slate-800/80 hover:bg-slate-700 text-slate-300 hover:text-white transition tap-target flex items-center justify-center"
              title="Pause Transfer"
            >
              <Pause className="w-4 h-4" />
            </button>
          )}

          {isPaused && (
            <button
              onClick={() => onResume(torrent.hash)}
              className="p-2 rounded-xl bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-300 transition tap-target flex items-center justify-center"
              title="Resume Transfer"
            >
              <Play className="w-4 h-4 fill-current" />
            </button>
          )}

          {/* Delete */}
          <button
            onClick={() => onDelete(torrent.hash)}
            className="p-2 rounded-xl bg-slate-800/80 hover:bg-rose-500/20 text-slate-400 hover:text-rose-400 transition tap-target flex items-center justify-center"
            title="Remove Torrent Task"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Progress Bar */}
      <div>
        <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden flex">
          <div
            className={`h-full transition-all duration-300 ${
              isCompleted
                ? 'bg-emerald-500'
                : 'bg-gradient-to-r from-cyan-500 to-indigo-500'
            }`}
            style={{ width: `${progressPercent}%` }}
          />
        </div>
      </div>

      {/* Telemetry row */}
      <div className="flex items-center justify-between flex-wrap gap-2 text-xs font-mono text-slate-400">
        <div className="flex items-center gap-3">
          <span className="text-slate-200 font-semibold">{progressPercent}%</span>
          <span>
            {formatBytes(downloadTargetSize * torrent.progress)} / {formatBytes(downloadTargetSize)}
            {skippedFiles > 0 && (
              <span className="text-slate-500 text-[11px] ml-1">
                ({formatBytes(torrent.total_size)} total)
              </span>
            )}
          </span>
        </div>

        <div className="flex items-center gap-3">
          {isDownloading && (
            <>
              <span className="text-cyan-400 flex items-center gap-1">
                <Download className="w-3.5 h-3.5" />
                {formatSpeed(torrent.dlspeed)}
              </span>
              <span className="text-slate-500 flex items-center gap-1">
                <Clock className="w-3.5 h-3.5" />
                {formatETA(torrent.eta)}
              </span>
            </>
          )}

          {isCompleted && (
            <span className="text-emerald-400 flex items-center gap-1 font-sans">
              <CheckCircle2 className="w-3.5 h-3.5" />
              Direct Links Ready
            </span>
          )}

          <span className="flex items-center gap-1 text-slate-500 hidden sm:flex">
            <Users className="w-3.5 h-3.5" />
            {torrent.num_seeds} / {torrent.num_leechs}
          </span>
        </div>
      </div>
    </div>
  );
};
