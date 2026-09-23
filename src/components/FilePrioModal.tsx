import React, { useState } from 'react';
import {
  X,
  FileCheck,
  CheckSquare,
  Square,
  ArrowUpCircle,
  Ban,
  Check,
  Loader2,
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
  const [selectedIndexes, setSelectedIndexes] = useState<number[]>([]);
  const [isUpdating, setIsUpdating] = useState(false);

  if (!torrent) return null;

  const toggleSelect = (index: number) => {
    setSelectedIndexes(prev =>
      prev.includes(index) ? prev.filter(i => i !== index) : [...prev, index]
    );
  };

  const selectAll = (all: boolean) => {
    if (all) {
      setSelectedIndexes(torrent.files.map(f => f.index));
    } else {
      setSelectedIndexes([]);
    }
  };

  const handleSetPriority = async (priority: number, specificIndex?: number) => {
    const targetIds = specificIndex !== undefined ? [specificIndex] : selectedIndexes;
    if (targetIds.length === 0) return;
    try {
      setIsUpdating(true);
      await onUpdatePriority(torrent.hash, targetIds.join('|'), priority);
      // update local file priority representation
      torrent.files.forEach(f => {
        if (targetIds.includes(f.index)) {
          f.priority = priority;
          if (priority === 0) {
            f.progress = 0;
          }
        }
      });
      if (specificIndex === undefined) {
        setSelectedIndexes([]);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setIsUpdating(false);
    }
  };

  const activeFiles = torrent.files.filter(f => f.priority > 0);
  const activeSize = activeFiles.reduce((acc, f) => acc + f.size, 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 md:p-6 bg-black/80 backdrop-blur-sm animate-fadeIn">
      <div 
        className="relative w-full max-w-2xl bg-slate-900 border border-slate-700/80 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800 bg-slate-900/90">
          <div className="flex items-center gap-3 overflow-hidden">
            <div className="p-2.5 rounded-xl bg-cyan-500/10 text-cyan-400">
              <FileCheck className="w-5 h-5" />
            </div>
            <div className="truncate">
              <h3 className="text-base font-bold text-slate-100 truncate">{torrent.name}</h3>
              <p className="text-xs text-slate-400">
                {activeFiles.length} of {torrent.files.length} files downloading ({formatBytes(activeSize)}) • {torrent.files.length - activeFiles.length} skipped
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

        {/* Priority Batch Controls Bar */}
        <div className="px-5 py-3 bg-slate-950/60 border-b border-slate-800 flex items-center justify-between flex-wrap gap-2 text-xs">
          <div className="flex items-center gap-2">
            <button
              onClick={() => selectAll(true)}
              className="text-slate-400 hover:text-slate-200 text-xs font-medium"
            >
              Select All
            </button>
            <span className="text-slate-600">•</span>
            <button
              onClick={() => selectAll(false)}
              className="text-slate-400 hover:text-slate-200 text-xs font-medium"
            >
              Clear
            </button>
            {selectedIndexes.length > 0 && (
              <span className="text-cyan-400 font-medium ml-2">
                ({selectedIndexes.length} selected for batch action)
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              disabled={selectedIndexes.length === 0 || isUpdating}
              onClick={() => handleSetPriority(1)}
              className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-200 font-medium transition flex items-center gap-1 text-[11px]"
            >
              <Check className="w-3.5 h-3.5 text-emerald-400" />
              <span>Download</span>
            </button>

            <button
              disabled={selectedIndexes.length === 0 || isUpdating}
              onClick={() => handleSetPriority(7)}
              className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-200 font-medium transition flex items-center gap-1 text-[11px]"
            >
              <ArrowUpCircle className="w-3.5 h-3.5 text-cyan-400" />
              <span>High Prio</span>
            </button>

            <button
              disabled={selectedIndexes.length === 0 || isUpdating}
              onClick={() => handleSetPriority(0)}
              className="px-2.5 py-1.5 rounded-lg bg-rose-500/10 border border-rose-500/30 hover:bg-rose-500/20 disabled:opacity-40 text-rose-300 font-medium transition flex items-center gap-1 text-[11px]"
            >
              <Ban className="w-3.5 h-3.5 text-rose-400" />
              <span>Do Not Download</span>
            </button>
          </div>
        </div>

        {/* Files list with 1-click toggle on each row */}
        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {torrent.files.map((file) => {
            const isBatchSelected = selectedIndexes.includes(file.index);
            const isExcluded = file.priority === 0;

            return (
              <div
                key={file.index}
                className={`p-3 rounded-xl border text-xs transition flex items-center justify-between gap-3 ${
                  isBatchSelected
                    ? 'bg-cyan-950/40 border-cyan-500/50'
                    : isExcluded
                    ? 'bg-slate-950/30 border-slate-800/60 opacity-60'
                    : 'bg-slate-850 border-slate-800 hover:border-slate-700'
                }`}
              >
                <div 
                  onClick={() => toggleSelect(file.index)}
                  className="flex items-center gap-3 overflow-hidden cursor-pointer flex-1"
                >
                  <div className="shrink-0">
                    {isBatchSelected ? (
                      <CheckSquare className="w-4 h-4 text-cyan-400" />
                    ) : (
                      <Square className="w-4 h-4 text-slate-600" />
                    )}
                  </div>
                  <div className="truncate">
                    <p className={`font-medium font-mono truncate ${isExcluded ? 'line-through text-slate-500' : 'text-slate-200'}`}>
                      {file.name}
                    </p>
                    <div className="flex items-center gap-2 mt-1 text-[11px] text-slate-400">
                      <span>{formatBytes(file.size)}</span>
                      <span>•</span>
                      <span className={isExcluded ? 'text-slate-500' : file.progress >= 1 ? 'text-emerald-400 font-semibold' : 'text-cyan-400 font-medium'}>
                        {isExcluded ? 'Skipped (0%)' : `${(file.progress * 100).toFixed(1)}% downloaded`}
                      </span>
                    </div>
                  </div>
                </div>

                {/* 1-Click Toggle Download vs Skip */}
                <div className="flex items-center gap-2 shrink-0">
                  {file.progress >= 1 && !isExcluded && (
                    <a
                      href={`/api/files/download/file_${torrent.hash.slice(0, 8)}_${file.index}`}
                      download={file.name}
                      className="px-2 py-1 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 border border-emerald-500/40 text-[11px] font-bold flex items-center gap-1 transition"
                      title="Download file to device"
                    >
                      <Download className="w-3 h-3" />
                      <span>Download</span>
                    </a>
                  )}

                  {isExcluded ? (
                    <button
                      type="button"
                      disabled={isUpdating}
                      onClick={() => handleSetPriority(1, file.index)}
                      className="px-2.5 py-1 rounded-lg bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 text-[11px] font-bold flex items-center gap-1 transition"
                      title="Click to start downloading this file"
                    >
                      <Check className="w-3 h-3" />
                      <span>Start Download</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={isUpdating}
                      onClick={() => handleSetPriority(0, file.index)}
                      className="px-2.5 py-1 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/30 text-[11px] font-bold flex items-center gap-1 transition"
                      title="Click to stop and skip downloading this file"
                    >
                      <Ban className="w-3 h-3" />
                      <span>Skip File</span>
                    </button>
                  )}

                  <span
                    className={`px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider ${
                      file.priority === 0
                        ? 'bg-rose-500/10 text-rose-400 border border-rose-500/20'
                        : file.priority >= 6
                        ? 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/20'
                        : 'bg-slate-800 text-slate-300'
                    }`}
                  >
                    {file.priority === 0 ? 'Ignored' : file.priority >= 6 ? 'High' : 'Normal'}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-slate-800 bg-slate-900 flex justify-between items-center">
          <div className="text-xs text-slate-400">
            Click <strong className="text-emerald-400">Start Download</strong> or <strong className="text-rose-400">Skip File</strong> on any file above.
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
