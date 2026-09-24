import React, { useEffect, useState } from 'react';
import {
  X,
  FileCheck,
  CheckSquare,
  Square,
  Ban,
  Check,
  Download
} from 'lucide-react';
import { TorrentItem } from '../types/index.ts';
import { formatBytes } from '../utils/formatters.ts';

interface FilePrioModalProps {
  torrent: TorrentItem | null;
  onClose: () => void;
  onUpdatePriority: (hash: string, fileId: string, priority: number) => Promise<void>;
}

export const FilePrioModal: React.FC<FilePrioModalProps> = ({
  torrent,
  onClose,
  onUpdatePriority
}) => {
  const [isUpdating, setIsUpdating] = useState(false);
  const [localFiles, setLocalFiles] = useState(torrent?.files || []);

  useEffect(() => {
    setLocalFiles(torrent?.files || []);
  }, [torrent]);

  if (!torrent) return null;

  const applyPriority = async (targetIds: number[], priority: number) => {
    if (targetIds.length === 0 || isUpdating) return;

    const previous = localFiles;
    const targetSet = new Set(targetIds);

    // Optimistic UI: checkbox/row status changes immediately.
    setLocalFiles(prev =>
      prev.map(file =>
        targetSet.has(file.index)
          ? { ...file, priority }
          : file
      )
    );

    // Keep the parent torrent in sync immediately too.
    torrent.files.forEach(file => {
      if (targetSet.has(file.index)) {
        file.priority = priority;
      }
    });

    try {
      setIsUpdating(true);
      await onUpdatePriority(torrent.hash, targetIds.join('|'), priority);
    } catch (e) {
      console.error(e);
      setLocalFiles(previous);
      await Promise.all(
        previous
          .filter(file => targetSet.has(file.index))
          .map(file => onUpdatePriority(torrent.hash, String(file.index), file.priority).catch(() => undefined))
      );
    } finally {
      setIsUpdating(false);
    }
  };

  // Clicking the checkbox toggles the actual qBittorrent download priority.
  const toggleDownload = async (index: number) => {
    const file = localFiles.find(f => f.index === index);
    if (!file) return;
    await applyPriority([index], file.priority > 0 ? 0 : 1);
  };

  const selectAll = async (all: boolean) => {
    const ids = localFiles.map(f => f.index);
    await applyPriority(ids, all ? 1 : 0);
  };

  const activeFiles = localFiles.filter(f => f.priority > 0);
  const activeSize = activeFiles.reduce((acc, f) => acc + f.size, 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 md:p-6 bg-black/80 backdrop-blur-sm animate-fadeIn">
      <div
        className="relative w-full max-w-2xl bg-slate-900 border border-slate-700/80 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800 bg-slate-900/90">
          <div className="flex items-center gap-3 overflow-hidden">
            <div className="p-2.5 rounded-xl bg-cyan-500/10 text-cyan-400">
              <FileCheck className="w-5 h-5" />
            </div>
            <div className="truncate">
              <h3 className="text-base font-bold text-slate-100 truncate">{torrent.name}</h3>
              <p className="text-xs text-slate-400">
                {activeFiles.length} of {localFiles.length} files downloading ({formatBytes(activeSize)}) • {localFiles.length - activeFiles.length} skipped
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-5 py-3 bg-slate-950/60 border-b border-slate-800 flex items-center gap-2 text-xs">
          <button
            onClick={() => void selectAll(true)}
            disabled={isUpdating}
            className="text-slate-400 hover:text-slate-200 disabled:opacity-40 text-xs font-medium"
          >
            Select All
          </button>
          <span className="text-slate-600">•</span>
          <button
            onClick={() => void selectAll(false)}
            disabled={isUpdating}
            className="text-slate-400 hover:text-slate-200 disabled:opacity-40 text-xs font-medium"
          >
            Clear
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {localFiles.map((file) => {
            const isChecked = file.priority > 0;
            return (
              <div
                key={file.index}
                className="p-3 rounded-xl border text-xs transition flex items-center justify-between gap-3 bg-slate-850 border-slate-800 hover:border-slate-700"
              >
                <div
                  onClick={() => void toggleDownload(file.index)}
                  className="flex items-center gap-3 overflow-hidden cursor-pointer flex-1"
                  title={isChecked ? 'Click to skip this file' : 'Click to download this file'}
                >
                  <div className="shrink-0">
                    {isChecked ? (
                      <CheckSquare className="w-4 h-4 text-cyan-400" />
                    ) : (
                      <Square className="w-4 h-4 text-slate-500" />
                    )}
                  </div>

                  <div className="truncate">
                    <p className="font-medium font-mono truncate text-slate-200">
                      {file.name}
                    </p>
                    <div className="flex items-center gap-2 mt-1 text-[11px] text-slate-400">
                      <span>{formatBytes(file.size)}</span>
                      <span>•</span>
                      <span className={file.progress >= 1 ? 'text-emerald-400 font-semibold' : isChecked ? 'text-cyan-400 font-medium' : 'text-slate-500'}>
                        {file.progress >= 1
                          ? `${(file.progress * 100).toFixed(1)}% downloaded`
                          : isChecked
                          ? `${(file.progress * 100).toFixed(1)}% downloaded`
                          : 'Skipped'}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {file.progress >= 1 && isChecked && (
                    <a
                      href={`/api/torrents/download/${torrent.hash}/${file.index}`}
                      download={file.name}
                      className="px-2 py-1 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 border border-emerald-500/40 text-[11px] font-bold flex items-center gap-1 transition"
                      title="Download file to device"
                    >
                      <Download className="w-3 h-3" />
                      <span>Download</span>
                    </a>
                  )}

                  <button
                    type="button"
                    disabled={isUpdating}
                    onClick={() => void toggleDownload(file.index)}
                    className={`px-2.5 py-1 rounded-lg font-bold flex items-center gap-1 transition text-[11px] ${
                      isChecked
                        ? 'bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/30'
                        : 'bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                    }`}
                  >
                    {isChecked ? (
                      <>
                        <Ban className="w-3 h-3" />
                        <span>Skip File</span>
                      </>
                    ) : (
                      <>
                        <Check className="w-3 h-3" />
                        <span>Start Download</span>
                      </>
                    )}
                  </button>

                </div>
              </div>
            );
          })}
        </div>

        <div className="px-5 py-3 border-t border-slate-800 bg-slate-900 flex justify-between items-center">
          <div className="text-xs text-slate-400">
            Checked files are downloaded. Unchecked files are skipped.
          </div>
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-200 transition"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
