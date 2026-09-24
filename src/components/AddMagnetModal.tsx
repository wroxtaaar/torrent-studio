import React, { useState, useEffect, useRef } from 'react';
import {
  Link2,
  X,
  FileCheck,
  Film,
  Music,
  FileArchive,
  FileText,
  FolderDown,
  Sparkles,
  CheckSquare,
  Square,
  AlertCircle,
  HelpCircle,
  UploadCloud,
  Loader2,
  Sliders,
  Check,
  Ban,
  Plus,
  Trash2,
  RotateCcw
} from 'lucide-react';
import { api } from '../api/client.ts';
import { formatBytes } from '../utils/formatters.ts';

interface AddMagnetModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAdd: (
    magnet: string,
    category: string,
    selectedFiles?: number[],
    manifest?: { name: string; size: number; priority: number }[]
  ) => Promise<void>;
  defaultFolder?: string;
}

interface InspectFileItem {
  index: number;
  name: string;
  size: number;
  type: 'video' | 'audio' | 'archive' | 'document' | 'other';
  selected: boolean;
}



export const AddMagnetModal: React.FC<AddMagnetModalProps> = ({
  isOpen,
  onClose,
  onAdd,
  defaultFolder = 'Downloads'
}) => {
  const [magnetInput, setMagnetInput] = useState('');
  const [category, setCategory] = useState(defaultFolder);
  const [inspectedFiles, setInspectedFiles] = useState<InspectFileItem[]>([]);
  const [isInspecting, setIsInspecting] = useState(false);
  const [inspectionSource, setInspectionSource] = useState<string>('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [showManifestEditor, setShowManifestEditor] = useState(false);
  const [customFileCount, setCustomFileCount] = useState<number>(16);
  const [pasteManifestText, setPasteManifestText] = useState('');

  const fileInputRef = useRef<HTMLInputElement>(null);
  const inspectTimeoutRef = useRef<any>(null);

  // Reset or initialize modal state
  useEffect(() => {
    if (isOpen) {
      setError('');
      setShowManifestEditor(false);
      setPasteManifestText('');
      // If modal opens empty, start clean so user pastes their real link
      if (!magnetInput) {
        setInspectedFiles([]);
      }
    }
  }, [isOpen]);

  // Inspect magnet link metadata via server
  const triggerInspect = async (link: string) => {
    if (!link.trim()) {
      setInspectedFiles([]);
      setInspectionSource('');
      return;
    }

    try {
      setIsInspecting(true);
      setError('');
      const data = await api.inspectMagnet(link.trim());
      if (!data || !Array.isArray(data.files) || data.files.length === 0) {
        throw new Error(
          data?.message ||
          'qBittorrent is still resolving this torrent. Please try Load File List again in a few seconds.'
        );
      }

      setInspectedFiles(
        data.files.map((f) => ({
          index: f.index,
          name: f.name,
          size: f.size,
          type: (f.type as any) || 'other',
          selected: false
        }))
      );
      setCustomFileCount(data.files.length);
      if (data.source === 'itorrents_cache') {
        setInspectionSource('✓ Verified File Manifest (Real BitTorrent Metadata)');
      } else if (data.source === 'apibay_metadata') {
        setInspectionSource('✓ Verified File Manifest (Public Metadata Index)');
      } else {
        setInspectionSource('Active Metadata Breakdown');
      }
    } catch (err: any) {
      console.warn('Inspect magnet error:', err);
      setInspectedFiles([]);
      setInspectionSource('');
      setError(err?.message || 'Could not resolve real torrent metadata from qBittorrent.');
    } finally {
      setIsInspecting(false);
    }
  };

  const handleInputChange = (val: string) => {
    setMagnetInput(val);
    setError('');
    if (inspectTimeoutRef.current) clearTimeout(inspectTimeoutRef.current);
    inspectTimeoutRef.current = setTimeout(() => {
      triggerInspect(val);
    }, 400);
  };

  // Handle direct .torrent file upload
  const handleTorrentFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      setIsInspecting(true);
      setError('');
      const data = await api.uploadTorrentFile(file);
      setMagnetInput(data.magnetUri);
      setInspectedFiles(
        data.files.map((f) => ({
          index: f.index,
          name: f.name,
          size: f.size,
          type: (f.type as any) || 'other',
          selected: false
        }))
      );
      setCustomFileCount(data.files.length);
      setInspectionSource(`✓ Loaded from .torrent file (${data.files.length} exact files)`);
    } catch (err: any) {
      setError(err.message || 'Failed to read .torrent file');
    } finally {
      setIsInspecting(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const toggleFile = (index: number) => {
    setInspectedFiles(prev =>
      prev.map(f => (f.index === index ? { ...f, selected: !f.selected } : f))
    );
  };

  const selectAll = (selected: boolean) => {
    setInspectedFiles(prev => prev.map(f => ({ ...f, selected })));
  };

  const selectOnlyVideos = () => {
    setInspectedFiles(prev =>
      prev.map(f => ({ ...f, selected: f.type === 'video' }))
    );
  };

  const selectOnlyAudio = () => {
    setInspectedFiles(prev =>
      prev.map(f => ({ ...f, selected: f.type === 'audio' }))
    );
  };

  const selectedFiles = inspectedFiles.filter(f => f.selected);
  const selectedCount = selectedFiles.length;
  const totalSelectedSize = selectedFiles.reduce((acc, f) => acc + f.size, 0);
  const totalTorrentSize = inspectedFiles.reduce((acc, f) => acc + f.size, 0);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!magnetInput.trim()) {
      setError('Please provide a magnet link or hash.');
      return;
    }

    if (isInspecting) {
      setError('Please wait while the torrent file list is being loaded.');
      return;
    }

    if (inspectedFiles.length === 0) {
      setError('Please wait for the torrent file list to load before starting the download.');
      return;
    }

    if (selectedCount === 0) {
      setError('Please select at least 1 file to download from this torrent.');
      return;
    }

    const selectedFileIndexes = inspectedFiles.filter(f => f.selected).map(f => f.index);
    const manifest = inspectedFiles.map(f => ({
      name: f.name,
      size: f.size,
      priority: f.selected ? 1 : 0
    }));

    try {
      setIsLoading(true);
      setError('');
      await onAdd(magnetInput.trim(), category, selectedFileIndexes, manifest);
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to start cloud torrent download');
    } finally {
      setIsLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 md:p-6 bg-black/80 backdrop-blur-sm animate-fadeIn">
      <div 
        className="relative w-full max-w-3xl bg-slate-900 border border-slate-700/80 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[94vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800 bg-slate-900/95">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-gradient-to-tr from-cyan-500 to-blue-600 text-slate-950 font-bold shadow-md shadow-cyan-500/20">
              <Link2 className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-slate-100">Add Magnet / .Torrent & Select Files</h3>
              <p className="text-xs text-slate-400">
                qBittorrent WebAPI • Real File Metadata & Selective Downloading
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

        {/* Modal Body */}
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-5 space-y-4">
          {error && (
            <div className="p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-400 text-xs flex items-center gap-2.5">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span className="font-medium">{error}</span>
            </div>
          )}

          {/* Magnet link input & .torrent upload */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="block text-xs font-semibold text-slate-300">
                Magnet URI / Torrent Hash
              </label>
              <div className="flex items-center gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".torrent"
                  onChange={handleTorrentFileUpload}
                  className="hidden"
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-cyan-400 hover:text-cyan-300 border border-slate-700 text-[11px] font-medium flex items-center gap-1.5 transition"
                >
                  <UploadCloud className="w-3.5 h-3.5" />
                  <span>Upload .torrent</span>
                </button>
              </div>
            </div>

            <div className="relative">
              <textarea
                rows={2}
                value={magnetInput}
                onChange={(e) => handleInputChange(e.target.value)}
                placeholder="Paste magnet:?xt=urn:btih:... or torrent hash"
                className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-slate-200 placeholder-slate-500 text-xs font-mono focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 transition resize-none pr-10"
              />
              {isInspecting && (
                <div className="absolute right-3 top-3 text-cyan-400 flex items-center gap-1.5 text-xs font-medium animate-pulse">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span className="text-[11px]">Resolving...</span>
                </div>
              )}
            </div>
          </div>

          {/* Selective File Download Selection Checklist */}
          {inspectedFiles.length > 0 && (
            <div className="rounded-xl bg-slate-950/90 border border-slate-800/90 overflow-hidden shadow-inner">
              {/* Header with question and bulk controls */}
              <div className="p-3.5 bg-slate-900/90 border-b border-slate-800 flex items-center justify-between flex-wrap gap-2">
                <div>
                  <div className="flex items-center gap-2">
                    <FileCheck className="w-4 h-4 text-cyan-400" />
                    <span className="text-xs font-bold text-white">
                      Which files do you want to download? ({inspectedFiles.length} files found)
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-400 mt-0.5">
                    {inspectionSource && (
                      <span className="text-cyan-400 font-medium mr-2">{inspectionSource} •</span>
                    )}
                    Only checked files will be downloaded. Unchecked files will be skipped.
                  </p>
                </div>

                {/* Bulk selection pills */}
                <div className="flex items-center gap-1.5 text-xs">
                  <button
                    type="button"
                    onClick={() => selectAll(true)}
                    className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition text-[11px] font-medium"
                  >
                    Select All ({inspectedFiles.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => selectAll(false)}
                    className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition text-[11px] font-medium"
                  >
                    Deselect All
                  </button>
                  <button
                    type="button"
                    onClick={selectOnlyVideos}
                    className="px-2 py-1 rounded-lg bg-indigo-950/60 border border-indigo-500/30 text-indigo-300 hover:text-indigo-200 transition text-[11px] font-medium"
                  >
                    Videos Only
                  </button>
                  {inspectedFiles.some(f => f.type === 'audio') && (
                    <button
                      type="button"
                      onClick={selectOnlyAudio}
                      className="px-2 py-1 rounded-lg bg-cyan-950/60 border border-cyan-500/30 text-cyan-300 hover:text-cyan-200 transition text-[11px] font-medium"
                    >
                      Audio Only
                    </button>
                  )}
                </div>
              </div>

              {/* File item list */}
              <div className="max-h-60 overflow-y-auto divide-y divide-slate-800/60 p-1">
                {inspectedFiles.map((file) => (
                  <div
                    key={file.index}
                    onClick={() => toggleFile(file.index)}
                    className={`flex items-center justify-between p-2.5 rounded-lg cursor-pointer transition select-none ${
                      file.selected
                        ? 'bg-cyan-950/20 hover:bg-cyan-950/30 text-slate-100'
                        : 'hover:bg-slate-900/50 text-slate-500 opacity-60'
                    }`}
                  >
                    <div className="flex items-center gap-3 overflow-hidden pr-2">
                      <div className="shrink-0">
                        {file.selected ? (
                          <CheckSquare className="w-4 h-4 text-cyan-400" />
                        ) : (
                          <Square className="w-4 h-4 text-slate-600" />
                        )}
                      </div>
                      <div className="shrink-0">
                        {file.type === 'video' && <Film className="w-4 h-4 text-indigo-400" />}
                        {file.type === 'audio' && <Music className="w-4 h-4 text-cyan-400" />}
                        {file.type === 'document' && <FileText className="w-4 h-4 text-emerald-400" />}
                        {file.type === 'archive' && <FileArchive className="w-4 h-4 text-amber-400" />}
                        {file.type === 'other' && <HelpCircle className="w-4 h-4 text-slate-400" />}
                      </div>
                      <span className={`text-xs font-mono truncate ${file.selected ? 'font-medium text-slate-200' : 'line-through text-slate-500'}`}>
                        {file.name}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className={`text-[10px] uppercase font-bold px-2 py-0.5 rounded ${
                        file.selected
                          ? 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/20'
                          : 'bg-rose-500/10 text-rose-400 border border-rose-500/20'
                      }`}>
                        {file.selected ? '✓ Download' : '✕ Skip'}
                      </span>
                      <span className="font-mono text-xs text-slate-300 w-20 text-right">
                        {formatBytes(file.size)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>

              {/* Selection summary bar */}
              <div className="p-2.5 bg-slate-950 border-t border-slate-800 flex items-center justify-between text-xs text-slate-400">
                <span>
                  Selected: <strong className="text-cyan-400">{selectedCount}</strong> of {inspectedFiles.length} files ({inspectedFiles.length - selectedCount} skipped)
                </span>
                <span>
                  Selected Download Size: <strong className="text-cyan-400 font-mono">{formatBytes(totalSelectedSize)}</strong> / {formatBytes(totalTorrentSize)} total
                </span>
              </div>
            </div>
          )}

          {/* Category & Folder */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                Target Folder
              </label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-slate-200 text-xs focus:outline-none focus:border-cyan-500"
              >
                <option value="Downloads">Downloads (Default)</option>
                <option value="Movies & Cinema">Movies & Cinema</option>
                <option value="Lossless Audio & FLAC">Lossless Audio & FLAC</option>
                <option value="Operating Systems">Operating Systems</option>
                <option value="Shared Team Vault">Shared Team Vault</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                Storage Allocation
              </label>
              <div className="px-3 py-2 rounded-xl bg-slate-950/80 border border-slate-800 text-slate-400 text-xs flex items-center gap-2">
                <Sparkles className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                <span className="truncate">Uncapped Server Storage (No 5GB cap)</span>
              </div>
            </div>
          </div>
        </form>

        {/* Modal Footer */}
        <div className="flex items-center justify-between gap-3 px-5 py-3.5 border-t border-slate-800 bg-slate-900/95">
          <div className="text-xs text-slate-400">
            {selectedCount > 0 ? (
              <span>Downloading <strong className="text-cyan-400">{selectedCount}</strong> file(s) ({formatBytes(totalSelectedSize)}) • {inspectedFiles.length - selectedCount} skipped</span>
            ) : inspectedFiles.length > 0 ? (
              <span className="text-rose-400">No files selected</span>
            ) : (
              <span>Paste a magnet link or upload a .torrent to load the file list first</span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-300 transition"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                if (selectedCount > 0) {
                  void handleSubmit({ preventDefault: () => {} } as React.FormEvent);
                } else if (magnetInput.trim() && !isInspecting) {
                  void triggerInspect(magnetInput.trim());
                } else if (!magnetInput.trim()) {
                  setError('Paste a magnet link, torrent hash, or upload a .torrent file first.');
                }
              }}
              disabled={
                isLoading ||
                isInspecting ||
                (inspectedFiles.length > 0 && selectedCount === 0)
              }
              className="px-5 py-2.5 rounded-xl bg-cyan-500 hover:bg-cyan-400 disabled:opacity-40 disabled:cursor-not-allowed text-slate-950 text-xs font-bold transition flex items-center gap-2 shadow-lg shadow-cyan-500/20"
            >
              {isInspecting ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <FolderDown className="w-4 h-4" />
              )}
              <span>
                {isLoading
                  ? 'Adding Task...'
                  : selectedCount > 0
                  ? `Download ${selectedCount} Selected File(s)`
                  : isInspecting
                  ? 'Loading File List...'
                  : !magnetInput.trim()
                  ? 'Paste Magnet First'
                  : inspectedFiles.length === 0
                  ? 'Load File List'
                  : 'Select Files to Continue'}
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
