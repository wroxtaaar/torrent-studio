/**
 * SeedFlow - Cloud Torrent & Media Streaming Application
 * Seedr-style webapp with qBittorrent WebAPI v2 orchestration,
 * unlimited server storage, HTTP range streaming, and selective downloads.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Cloud,
  Download,
  Upload,
  HardDrive,
  Folder,
  FolderPlus,
  Play,
  Share2,
  History,
  Settings,
  Bell,
  Plus,
  Search,
  Filter,
  Moon,
  Sun,
  ShieldCheck,
  AlertTriangle,
  RefreshCw,
  Cpu,
  Trash2,
  Users,
  ChevronRight,
  Sparkles,
  Layers,
  FileArchive,
  ArrowUpDown,
  ExternalLink,
  Film,
  Music,
  CheckCircle2
} from 'lucide-react';

import {
  TorrentItem,
  StorageFile,
  StorageFolder,
  UserProfile,
  StorageStats,
  ActivityLog,
  AppNotification,
  CleanupSettings,
  QbtSettings,
  UserPermission
} from './types/index.ts';

import { api } from './api/client.ts';
import { formatBytes, formatSpeed } from './utils/formatters.ts';
import { dispatchBrowserNotification, playNotificationSound } from './utils/notifications.ts';

import { TorrentCard } from './components/TorrentCard.tsx';
import { FileCard } from './components/FileCard.tsx';
import { MediaPlayerModal } from './components/MediaPlayerModal.tsx';
import { AddMagnetModal } from './components/AddMagnetModal.tsx';
import { FilePrioModal } from './components/FilePrioModal.tsx';
import { StorageCleanupModal } from './components/StorageCleanupModal.tsx';
import { FolderShareModal } from './components/FolderShareModal.tsx';
import { NotificationCenter } from './components/NotificationCenter.tsx';
import { ActivityLogView } from './components/ActivityLogView.tsx';
import { QbtSettingsModal } from './components/QbtSettingsModal.tsx';
import { CreateFolderModal } from './components/CreateFolderModal.tsx';
import { MoveFileModal } from './components/MoveFileModal.tsx';
import { RenameModal } from './components/RenameModal.tsx';
import { ConfirmDeleteModal } from './components/ConfirmDeleteModal.tsx';

export default function App() {
  // Navigation & Theme
  const [activeTab, setActiveTab] = useState<'transfers' | 'files' | 'shared' | 'activity' | 'storage'>('transfers');
  const [theme, setTheme] = useState<'dark' | 'dim' | 'light'>(() => {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        return (localStorage.getItem('seedflow_theme') as any) || 'dark';
      }
    } catch {
      // Sandboxed or iframe storage restricted
    }
    return 'dark';
  });

  // Core Data
  const [torrents, setTorrents] = useState<TorrentItem[]>([]);
  const [files, setFiles] = useState<StorageFile[]>([]);
  const [folders, setFolders] = useState<StorageFolder[]>([]);
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [activeUser, setActiveUser] = useState<UserProfile | null>(null);
  const [storageStats, setStorageStats] = useState<StorageStats | null>(null);
  const [activityLogs, setActivityLogs] = useState<ActivityLog[]>([]);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [qbtSettings, setQbtSettings] = useState<QbtSettings | null>(null);
  const [cleanupSettings, setCleanupSettings] = useState<CleanupSettings | null>(null);

  // File Explorer State
  const [currentFolder, setCurrentFolder] = useState<string>('/');
  const [fileSearch, setFileSearch] = useState<string>('');
  const [fileTypeFilter, setFileTypeFilter] = useState<string>('all');
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>([]);

  // Modals & Drawers
  const [isAddMagnetOpen, setIsAddMagnetOpen] = useState(false);
  const [prioTorrent, setPrioTorrent] = useState<TorrentItem | null>(null);
  const [isCleanupOpen, setIsCleanupOpen] = useState(false);
  const [isQbtSettingsOpen, setIsQbtSettingsOpen] = useState(false);
  const [isNotificationsOpen, setIsNotificationsOpen] = useState(false);
  const [shareFolder, setShareFolder] = useState<StorageFolder | null>(null);
  const [isCreateFolderOpen, setIsCreateFolderOpen] = useState(false);
  const [moveFile, setMoveFile] = useState<StorageFile | null>(null);
  const [renameItem, setRenameItem] = useState<{ id: string; name: string; isFolder: boolean } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{
    type: 'file' | 'torrent';
    id: string;
    name: string;
    details?: string;
  } | null>(null);

  // Media Player State
  const [activeMediaFile, setActiveMediaFile] = useState<StorageFile | null>(null);
  const [isPlayerMinimized, setIsPlayerMinimized] = useState(false);

  // Previous torrent hashes for completion tracking
  const prevTorrentStates = useRef<Record<string, string>>({});

  // Theme synchronization
  useEffect(() => {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        localStorage.setItem('seedflow_theme', theme);
      }
    } catch {}
    try {
      const root = document.documentElement;
      root.classList.remove('dark', 'dim', 'light');
      if (theme === 'dark') {
        root.classList.add('dark');
        root.style.backgroundColor = '#020617';
      } else if (theme === 'dim') {
        root.classList.add('dark');
        root.style.backgroundColor = '#0f172a';
      } else {
        root.classList.add('light');
        root.style.backgroundColor = '#f8fafc';
      }
    } catch {}
  }, [theme]);

  // Load all initial system data
  const loadInitialData = useCallback(async () => {
    try {
      const [uData, sStats, fData, foldData, logs, notifs, qbt, cleanup] = await Promise.all([
        api.getUsers(),
        api.getStorageStats(),
        api.getFiles(currentFolder, fileSearch, fileTypeFilter),
        api.getFolders(),
        api.getLogs(),
        api.getNotifications(),
        api.getQbtSettings(),
        api.getCleanupSettings()
      ]);

      setUsers(uData.users);
      setActiveUser(uData.activeUser);
      setStorageStats(sStats);
      setFiles(fData);
      setFolders(foldData);
      setActivityLogs(logs);
      setNotifications(notifs);
      setQbtSettings(qbt);
      setCleanupSettings(cleanup);
    } catch (e) {
      console.error('Failed to load initial seedflow data:', e);
    }
  }, [currentFolder, fileSearch, fileTypeFilter]);

  useEffect(() => {
    loadInitialData();
  }, [loadInitialData]);

  // Polling loop for active torrents, speeds, and push notifications
  useEffect(() => {
    let isMounted = true;

    const pollTorrents = async () => {
      try {
        const torrentList = await api.getTorrents();
        if (!isMounted) return;

        // Check for completions to fire push notifications
        torrentList.forEach(t => {
          const prevState = prevTorrentStates.current[t.hash];
          if (prevState === 'downloading' && (t.state === 'completed' || t.progress >= 1)) {
            // Transfer finished! Trigger sound and push alert
            playNotificationSound();
            dispatchBrowserNotification(
              `Download Finished: ${t.name}`,
              `Direct streaming and direct download links are now ready in your cloud storage.`
            );
            // Refresh storage & files list
            api.getFiles(currentFolder).then(setFiles).catch(console.error);
            api.getStorageStats().then(setStorageStats).catch(console.error);
            api.getNotifications().then(setNotifications).catch(console.error);
          }
          prevTorrentStates.current[t.hash] = t.state;
        });

        setTorrents(torrentList);
      } catch (e) {
        console.error('Polling error:', e);
      }
    };

    pollTorrents();
    const interval = setInterval(pollTorrents, 1800);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [currentFolder]);

  // Actions
  const handleAddMagnet = async (
    magnet: string,
    category: string,
    selectedFiles?: number[],
    manifest?: { name: string; size: number; priority: number }[]
  ) => {
    await api.addMagnet(magnet, category, selectedFiles, manifest);
    const updated = await api.getTorrents();
    setTorrents(updated);
    const stats = await api.getStorageStats();
    setStorageStats(stats);
    setActiveTab('transfers');
  };

  const handlePauseTorrent = async (hash: string) => {
    await api.pauseTorrent(hash);
    const updated = await api.getTorrents();
    setTorrents(updated);
  };

  const handleResumeTorrent = async (hash: string) => {
    await api.resumeTorrent(hash);
    const updated = await api.getTorrents();
    setTorrents(updated);
  };

  const handleDeleteTorrent = (hash: string) => {
    const torrent = torrents.find(t => t.hash === hash);
    if (!torrent) return;
    setDeleteTarget({
      type: 'torrent',
      id: torrent.hash,
      name: torrent.name,
      details: `${formatBytes(torrent.total_size)} • Progress: ${Math.round(torrent.progress * 100)}%`
    });
  };

  const handleUpdateFilePriority = async (hash: string, fileId: string, priority: number) => {
    await api.setFilePriority(hash, fileId, priority);
    const updated = await api.getTorrents();
    setTorrents(updated);
  };

  const handleDeleteFile = (id: string) => {
    const file = files.find(f => f.id === id);
    if (!file) return;
    setDeleteTarget({
      type: 'file',
      id: file.id,
      name: file.name,
      details: `${formatBytes(file.size)} • Folder: ${file.folder}`
    });
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      if (deleteTarget.type === 'file') {
        await api.deleteFile(deleteTarget.id);
        setFiles(prev => prev.filter(f => f.id !== deleteTarget.id));
        const stats = await api.getStorageStats();
        setStorageStats(stats);
      } else if (deleteTarget.type === 'torrent') {
        await api.deleteTorrent(deleteTarget.id, true);
        setTorrents(prev => prev.filter(t => t.hash !== deleteTarget.id));
        const stats = await api.getStorageStats();
        setStorageStats(stats);
        const f = await api.getFiles(currentFolder);
        setFiles(f);
      }
    } catch (err) {
      console.error('Failed to execute delete:', err);
    }
  };

  const handleCreateFolder = async (name: string, isShared: boolean) => {
    const newFolder = await api.createFolder(name, currentFolder, isShared);
    setFolders(prev => [...prev, newFolder]);
  };

  const handleMoveFile = async (fileId: string, targetFolder: string) => {
    await api.moveFile(fileId, targetFolder);
    const updated = await api.getFiles(currentFolder);
    setFiles(updated);
  };

  const handleRename = async (id: string, newName: string, isFolder: boolean) => {
    await api.renameItem(id, newName, isFolder);
    if (isFolder) {
      const f = await api.getFolders();
      setFolders(f);
    }
    const updated = await api.getFiles(currentFolder);
    setFiles(updated);
  };

  const handleFolderShareSave = async (folderId: string, isShared: boolean, permissions: Record<string, UserPermission>) => {
    await api.updateFolderShare(folderId, isShared, permissions);
    const f = await api.getFolders();
    setFolders(f);
  };

  const handleSwitchUser = async (userId: string) => {
    const { activeUser: newUser } = await api.switchUser(userId);
    setActiveUser(newUser);
  };

  const handleRunCleanup = async () => {
    const res = await api.runCleanup();
    const stats = await api.getStorageStats();
    setStorageStats(stats);
    const f = await api.getFiles(currentFolder);
    setFiles(f);
    const logs = await api.getLogs();
    setActivityLogs(logs);
    return res;
  };

  // Download batch zip
  const handleDownloadBatchZip = async () => {
    try {
      const res = await fetch('/api/files/zip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileIds: selectedFileIds.length > 0 ? selectedFileIds : undefined,
          folderPath: selectedFileIds.length === 0 ? currentFolder : undefined
        })
      });
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `SeedFlow_${currentFolder.replace(/[/\\?%*:|"<>]/g, '_')}_Archive.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (e) {
      console.error('Batch zip download failed:', e);
    }
  };

  // Global telemetry speeds
  const totalDlSpeed = torrents
    .filter(t => t.state === 'downloading')
    .reduce((acc, t) => acc + t.dlspeed, 0);
  const totalUpSpeed = torrents.reduce((acc, t) => acc + t.upspeed, 0);
  const activeDownloadsCount = torrents.filter(t => t.state === 'downloading').length;
  const unreadNotifsCount = notifications.filter(n => !n.read).length;

  return (
    <div className={`min-h-screen flex flex-col ${theme === 'dark' ? 'bg-slate-950 text-slate-100' : theme === 'dim' ? 'bg-slate-900 text-slate-100' : 'bg-slate-50 text-slate-900'} transition-colors duration-200`}>
      {/* Top Main Navigation Header */}
      <header className="sticky top-0 z-40 bg-slate-950/90 backdrop-blur-md border-b border-slate-800/80 px-3 sm:px-6 py-3">
        <div className="max-w-7xl mx-auto flex items-center justify-between gap-3">
          {/* Logo & Brand */}
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-cyan-500 via-blue-600 to-indigo-600 flex items-center justify-center shadow-lg shadow-cyan-500/25">
              <Cloud className="w-5 h-5 text-slate-950 font-black fill-current" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-base sm:text-lg font-black tracking-tight text-white">SeedFlow</h1>
                <span className="hidden sm:inline px-1.5 py-0.5 rounded text-[10px] font-bold bg-cyan-500/20 text-cyan-300 uppercase tracking-widest border border-cyan-500/30">
                  qBt WebAPI
                </span>
              </div>
              <p className="text-[10px] text-slate-400 hidden sm:block">
                Unlimited Cloud Seedbox & Media Streamer
              </p>
            </div>
          </div>

          {/* Center: Live speeds & Storage Indicator */}
          <div className="hidden md:flex items-center gap-4">
            {/* Speed Pointers */}
            <div className="flex items-center gap-3 px-3 py-1.5 rounded-xl bg-slate-900 border border-slate-800 text-xs font-mono">
              <div className="flex items-center gap-1 text-cyan-400">
                <Download className="w-3.5 h-3.5" />
                <span>{formatSpeed(totalDlSpeed)}</span>
              </div>
              <span className="text-slate-700">|</span>
              <div className="flex items-center gap-1 text-indigo-400">
                <Upload className="w-3.5 h-3.5" />
                <span>{formatSpeed(totalUpSpeed)}</span>
              </div>
            </div>

            {/* Storage Pill (Uncapped, No 5GB Limit) */}
            {storageStats && (
              <button
                onClick={() => setIsCleanupOpen(true)}
                className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-slate-900 border border-slate-800 hover:border-slate-700 text-xs transition group"
                title="View Server Storage & Auto-Cleanup"
              >
                <HardDrive className={`w-3.5 h-3.5 ${storageStats.alertLevel === 'critical' ? 'text-rose-400 animate-pulse' : storageStats.alertLevel === 'warning' ? 'text-amber-400' : 'text-cyan-400'}`} />
                <span className="text-slate-300 font-mono text-[11px]">
                  {formatBytes(storageStats.usedBytes)} / {formatBytes(storageStats.totalBytes)} ({storageStats.usedPercentage}%)
                </span>
                <span className="text-[10px] px-1.5 py-0.2 rounded bg-cyan-500/10 text-cyan-400 font-semibold group-hover:bg-cyan-500/20">
                  Uncapped
                </span>
              </button>
            )}
          </div>

          {/* Right: Quick actions & User Switcher */}
          <div className="flex items-center gap-2">
            {/* "+ Add Magnet" Primary CTA */}
            <button
              onClick={() => setIsAddMagnetOpen(true)}
              className="px-3 sm:px-4 py-2 rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-slate-950 text-xs sm:text-sm font-bold flex items-center gap-1.5 shadow-lg shadow-cyan-500/20 transition tap-target"
            >
              <Plus className="w-4 h-4 stroke-[3]" />
              <span className="hidden sm:inline">Add Magnet</span>
              <span className="sm:hidden">Add</span>
            </button>

            {/* Notification Bell */}
            <button
              onClick={() => setIsNotificationsOpen(true)}
              className="p-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-slate-300 relative transition tap-target flex items-center justify-center border border-slate-800"
              title="Notifications & Push Alerts"
            >
              <Bell className="w-4 h-4" />
              {unreadNotifsCount > 0 && (
                <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-cyan-500 text-slate-950 font-bold text-[9px] flex items-center justify-center">
                  {unreadNotifsCount}
                </span>
              )}
            </button>

            {/* qBittorrent WebAPI Settings */}
            <button
              onClick={() => setIsQbtSettingsOpen(true)}
              className="p-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-slate-300 transition tap-target hidden sm:flex items-center justify-center border border-slate-800"
              title="qBittorrent WebAPI Settings"
            >
              <Cpu className="w-4 h-4 text-cyan-400" />
            </button>

            {/* Theme Toggle */}
            <button
              onClick={() => setTheme(theme === 'dark' ? 'dim' : theme === 'dim' ? 'light' : 'dark')}
              className="p-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-slate-300 transition tap-target hidden sm:flex items-center justify-center border border-slate-800"
              title={`Theme: ${theme}`}
            >
              {theme === 'light' ? <Sun className="w-4 h-4 text-amber-400" /> : <Moon className="w-4 h-4 text-cyan-400" />}
            </button>

            {/* Active User Switcher dropdown */}
            {activeUser && (
              <div className="flex items-center pl-1 border-l border-slate-800">
                <select
                  value={activeUser.id}
                  onChange={(e) => handleSwitchUser(e.target.value)}
                  className="bg-slate-900 border border-slate-800 text-slate-200 text-xs rounded-xl px-2.5 py-1.5 focus:outline-none focus:border-cyan-500 cursor-pointer"
                  title="Switch Active User Profile"
                >
                  {users.map(u => (
                    <option key={u.id} value={u.id}>
                      {u.name} ({u.role.toUpperCase()})
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Desktop Subheader Navigation Tabs */}
      <div className="hidden md:block bg-slate-900/60 border-b border-slate-800/80 px-6">
        <div className="max-w-7xl mx-auto flex items-center gap-2 py-2">
          <button
            onClick={() => setActiveTab('transfers')}
            className={`px-3.5 py-1.5 rounded-xl text-xs font-semibold flex items-center gap-2 transition ${
              activeTab === 'transfers'
                ? 'bg-cyan-500 text-slate-950 shadow-md shadow-cyan-500/20'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
            }`}
          >
            <Download className="w-4 h-4" />
            <span>Transfers & Seedbox</span>
            {activeDownloadsCount > 0 && (
              <span className={`px-1.5 py-0.2 rounded-full text-[10px] font-bold ${activeTab === 'transfers' ? 'bg-slate-950 text-cyan-400' : 'bg-cyan-500/20 text-cyan-300'}`}>
                {activeDownloadsCount}
              </span>
            )}
          </button>

          <button
            onClick={() => setActiveTab('files')}
            className={`px-3.5 py-1.5 rounded-xl text-xs font-semibold flex items-center gap-2 transition ${
              activeTab === 'files'
                ? 'bg-cyan-500 text-slate-950 shadow-md shadow-cyan-500/20'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
            }`}
          >
            <Folder className="w-4 h-4" />
            <span>My Cloud Files</span>
            <span className="text-[10px] opacity-70">({files.length})</span>
          </button>

          <button
            onClick={() => setActiveTab('shared')}
            className={`px-3.5 py-1.5 rounded-xl text-xs font-semibold flex items-center gap-2 transition ${
              activeTab === 'shared'
                ? 'bg-cyan-500 text-slate-950 shadow-md shadow-cyan-500/20'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
            }`}
          >
            <Share2 className="w-4 h-4" />
            <span>Shared Storage</span>
          </button>

          <button
            onClick={() => setActiveTab('activity')}
            className={`px-3.5 py-1.5 rounded-xl text-xs font-semibold flex items-center gap-2 transition ${
              activeTab === 'activity'
                ? 'bg-cyan-500 text-slate-950 shadow-md shadow-cyan-500/20'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
            }`}
          >
            <History className="w-4 h-4" />
            <span>Activity Log</span>
          </button>

          <button
            onClick={() => setActiveTab('storage')}
            className={`px-3.5 py-1.5 rounded-xl text-xs font-semibold flex items-center gap-2 transition ${
              activeTab === 'storage'
                ? 'bg-cyan-500 text-slate-950 shadow-md shadow-cyan-500/20'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
            }`}
          >
            <Sparkles className="w-4 h-4" />
            <span>Auto-Cleanup & Disk</span>
          </button>
        </div>
      </div>

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-3 sm:p-6 pb-24 md:pb-12">
        {/* Storage Alert Warning Banner if capacity high */}
        {storageStats && storageStats.alertLevel !== 'normal' && (
          <div className="mb-4 p-3.5 rounded-2xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-between text-xs text-amber-300">
            <div className="flex items-center gap-2.5">
              <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0" />
              <span>
                Storage capacity advisory: {storageStats.usedPercentage}% of server disk is occupied. Auto-cleanup is active.
              </span>
            </div>
            <button
              onClick={() => setIsCleanupOpen(true)}
              className="px-3 py-1 rounded-xl bg-amber-500/20 hover:bg-amber-500/30 font-bold transition shrink-0 ml-2"
            >
              Inspect Disk
            </button>
          </div>
        )}

        {/* TAB 1: TRANSFERS & SEEDBOX */}
        {activeTab === 'transfers' && (
          <div className="space-y-4">
            {/* Action header */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 rounded-2xl bg-slate-900 border border-slate-800">
              <div>
                <h2 className="text-base font-bold text-slate-100 flex items-center gap-2">
                  <Download className="w-5 h-5 text-cyan-400" />
                  <span>Ongoing Downloads & Active Torrents</span>
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  High-speed server torrent downloader with real-time ETA, selective files, and zero 5GB caps.
                </p>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => setIsAddMagnetOpen(true)}
                  className="px-3.5 py-2 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold text-xs flex items-center gap-1.5 shadow-md shadow-cyan-500/20 transition"
                >
                  <Plus className="w-4 h-4" />
                  <span>Add Magnet</span>
                </button>
              </div>
            </div>

            {/* Torrents List */}
            {torrents.length === 0 ? (
              <div className="py-16 text-center rounded-2xl bg-slate-900 border border-slate-800 p-8">
                <Cloud className="w-12 h-12 text-slate-700 mx-auto mb-3" />
                <h3 className="text-sm font-bold text-slate-300">No active torrent transfers</h3>
                <p className="text-xs text-slate-500 mt-1 max-w-sm mx-auto">
                  Paste any magnet link to start cloud downloading at high server speeds.
                </p>
                <button
                  onClick={() => setIsAddMagnetOpen(true)}
                  className="mt-4 px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-cyan-400 text-xs font-semibold transition"
                >
                  + Add First Magnet Link
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3">
                {torrents.map((torrent) => (
                  <TorrentCard
                    key={torrent.hash}
                    torrent={torrent}
                    onPause={handlePauseTorrent}
                    onResume={handleResumeTorrent}
                    onDelete={handleDeleteTorrent}
                    onSelectFiles={(t) => setPrioTorrent(t)}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {/* TAB 2: MY CLOUD FILES */}
        {activeTab === 'files' && (
          <div className="space-y-4">
            {/* Header & Breadcrumb & Search */}
            <div className="flex flex-col gap-3 p-4 rounded-2xl bg-slate-900 border border-slate-800">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                {/* Folder Breadcrumb */}
                <div className="flex items-center gap-2 overflow-x-auto text-xs font-semibold">
                  <button
                    onClick={() => setCurrentFolder('/')}
                    className={`px-2.5 py-1.5 rounded-lg transition ${
                      currentFolder === '/'
                        ? 'bg-cyan-500/20 text-cyan-400'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    Root
                  </button>

                  {folders
                    .filter(f => f.path !== '/')
                    .map(folder => (
                      <React.Fragment key={folder.id}>
                        <ChevronRight className="w-3.5 h-3.5 text-slate-600 shrink-0" />
                        <button
                          onClick={() => setCurrentFolder(folder.path)}
                          className={`px-2.5 py-1.5 rounded-lg whitespace-nowrap transition ${
                            currentFolder === folder.path
                              ? 'bg-cyan-500/20 text-cyan-400'
                              : 'text-slate-400 hover:text-slate-200'
                          }`}
                        >
                          {folder.name}
                        </button>
                      </React.Fragment>
                    ))}
                </div>

                {/* Explorer Action Buttons */}
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setIsCreateFolderOpen(true)}
                    className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium flex items-center gap-1.5 transition"
                  >
                    <FolderPlus className="w-3.5 h-3.5 text-cyan-400" />
                    <span>New Folder</span>
                  </button>

                  <button
                    onClick={handleDownloadBatchZip}
                    className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium flex items-center gap-1.5 transition"
                    title="Download Current Folder as Zip Archive"
                  >
                    <FileArchive className="w-3.5 h-3.5 text-amber-400" />
                    <span className="hidden sm:inline">Zip Archive</span>
                  </button>
                </div>
              </div>

              {/* Search & Category Filter */}
              <div className="flex flex-col sm:flex-row items-center gap-2.5 pt-2 border-t border-slate-800/80">
                <div className="relative flex-1 w-full">
                  <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
                  <input
                    type="text"
                    placeholder="Search files by name..."
                    value={fileSearch}
                    onChange={(e) => setFileSearch(e.target.value)}
                    className="w-full pl-9 pr-3 py-1.5 rounded-xl bg-slate-950 border border-slate-800 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-cyan-500"
                  />
                </div>

                <div className="flex items-center gap-1 overflow-x-auto w-full sm:w-auto text-xs">
                  {['all', 'video', 'audio', 'document', 'archive'].map((t) => (
                    <button
                      key={t}
                      onClick={() => setFileTypeFilter(t)}
                      className={`px-2.5 py-1 rounded-lg capitalize font-medium transition ${
                        fileTypeFilter === t
                          ? 'bg-cyan-500 text-slate-950 font-bold'
                          : 'bg-slate-850 text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Files Grid / List */}
            {files.length === 0 ? (
              <div className="py-16 text-center rounded-2xl bg-slate-900 border border-slate-800 p-8">
                <Folder className="w-12 h-12 text-slate-700 mx-auto mb-3" />
                <h3 className="text-sm font-bold text-slate-300">No files found in this folder</h3>
                <p className="text-xs text-slate-500 mt-1">
                  Completed torrent downloads and uploaded media appear here instantly.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-2.5">
                {files.map((file) => (
                  <FileCard
                    key={file.id}
                    file={file}
                    onPlay={(f) => {
                      setActiveMediaFile(f);
                      setIsPlayerMinimized(false);
                    }}
                    onDelete={handleDeleteFile}
                    onRename={(f) => setRenameItem({ id: f.id, name: f.name, isFolder: false })}
                    onMove={(f) => setMoveFile(f)}
                    canEdit={activeUser?.role !== 'viewer'}
                    canDelete={activeUser?.role === 'admin'}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {/* TAB 3: SHARED STORAGE & MULTI-USER */}
        {activeTab === 'shared' && (
          <div className="space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 rounded-2xl bg-slate-900 border border-slate-800">
              <div>
                <h2 className="text-base font-bold text-slate-100 flex items-center gap-2">
                  <Users className="w-5 h-5 text-cyan-400" />
                  <span>Shared Team Folders & Access Controls</span>
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Multi-user folder permissions with customizable Viewer, Editor, and Admin roles.
                </p>
              </div>

              <button
                onClick={() => setIsCreateFolderOpen(true)}
                className="px-3.5 py-2 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold text-xs flex items-center gap-1.5 transition"
              >
                <FolderPlus className="w-4 h-4" />
                <span>New Shared Folder</span>
              </button>
            </div>

            {/* Folders List */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {folders.filter(f => f.path !== '/').map((folder) => {
                const isOwner = folder.ownerId === activeUser?.id;
                const userPerm = isOwner ? 'admin' : folder.permissions[activeUser?.id || ''] || 'viewer';

                return (
                  <div
                    key={folder.id}
                    className="p-4 rounded-2xl bg-slate-900 border border-slate-800 hover:border-slate-700 transition flex flex-col justify-between gap-3"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2.5 overflow-hidden">
                        <div className="p-2.5 rounded-xl bg-cyan-500/10 text-cyan-400 shrink-0">
                          <Folder className="w-5 h-5" />
                        </div>
                        <div className="truncate">
                          <h4 className="text-sm font-semibold text-slate-100 truncate">{folder.name}</h4>
                          <p className="text-[11px] text-slate-400 mt-0.5">
                            Created by {folder.ownerName}
                          </p>
                        </div>
                      </div>

                      <span
                        className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase ${
                          folder.isShared
                            ? 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/20'
                            : 'bg-slate-800 text-slate-400'
                        }`}
                      >
                        {folder.isShared ? 'Shared' : 'Private'}
                      </span>
                    </div>

                    <div className="flex items-center justify-between text-xs text-slate-400 pt-2 border-t border-slate-800/60">
                      <span>{folder.filesCount || 0} files ({formatBytes(folder.totalSize || 0)})</span>
                      <span className="text-cyan-400 font-medium capitalize">Role: {userPerm}</span>
                    </div>

                    <div className="flex items-center gap-2 pt-1">
                      <button
                        onClick={() => {
                          setCurrentFolder(folder.path);
                          setActiveTab('files');
                        }}
                        className="flex-1 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold transition"
                      >
                        Open Folder
                      </button>

                      <button
                        onClick={() => setShareFolder(folder)}
                        className="p-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-cyan-400 transition"
                        title="Manage Permissions"
                      >
                        <Share2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* TAB 4: ACTIVITY LOG */}
        {activeTab === 'activity' && (
          <ActivityLogView
            logs={activityLogs}
            onClearLogs={async () => {
              await api.clearLogs();
              setActivityLogs([]);
            }}
            onRefresh={async () => {
              const logs = await api.getLogs();
              setActivityLogs(logs);
            }}
          />
        )}

        {/* TAB 5: STORAGE & AUTO-CLEANUP */}
        {activeTab === 'storage' && storageStats && cleanupSettings && (
          <div className="space-y-4">
            <div className="p-5 rounded-2xl bg-slate-900 border border-slate-800 flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div>
                <h2 className="text-base font-bold text-slate-100 flex items-center gap-2">
                  <HardDrive className="w-5 h-5 text-cyan-400" />
                  <span>Uncapped Server Disk Storage & Auto-Cleanup</span>
                </h2>
                <p className="text-xs text-slate-400 mt-1 max-w-xl">
                  Unlike conventional cloud seedboxes with 5GB caps, SeedFlow utilizes your full host storage allocation with automated orphan & temp fragment garbage collection.
                </p>
              </div>

              <button
                onClick={() => setIsCleanupOpen(true)}
                className="px-4 py-2.5 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold text-xs flex items-center gap-2 shadow-lg shadow-cyan-500/20 transition self-start md:self-auto"
              >
                <Sparkles className="w-4 h-4" />
                <span>Configure Auto-Cleanup</span>
              </button>
            </div>

            {/* Storage Cards Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800">
                <p className="text-xs text-slate-400 uppercase font-semibold tracking-wider">Used Storage</p>
                <p className="text-xl font-bold font-mono text-cyan-400 mt-1">{formatBytes(storageStats.usedBytes)}</p>
                <p className="text-[11px] text-slate-500 mt-1">{storageStats.usedPercentage}% of total server capacity</p>
              </div>

              <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800">
                <p className="text-xs text-slate-400 uppercase font-semibold tracking-wider">Available Free Space</p>
                <p className="text-xl font-bold font-mono text-emerald-400 mt-1">{formatBytes(storageStats.freeBytes)}</p>
                <p className="text-[11px] text-slate-500 mt-1">Ready for high-bandwidth downloads</p>
              </div>

              <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800">
                <p className="text-xs text-slate-400 uppercase font-semibold tracking-wider">Total Server Disk</p>
                <p className="text-xl font-bold font-mono text-slate-100 mt-1">{formatBytes(storageStats.totalBytes)}</p>
                <p className="text-[11px] text-cyan-400 mt-1 flex items-center gap-1">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>Unlimited Server Storage (No 5GB cap)</span>
                </p>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Floating Bottom Media Player (when minimized or active) */}
      <MediaPlayerModal
        file={activeMediaFile}
        onClose={() => setActiveMediaFile(null)}
        isMinimized={isPlayerMinimized}
        onToggleMinimize={() => setIsPlayerMinimized(!isPlayerMinimized)}
      />

      {/* Mobile Floating Action Button (FAB) for Add Magnet */}
      <button
        onClick={() => setIsAddMagnetOpen(true)}
        className="md:hidden fixed right-4 bottom-20 z-30 p-4 rounded-2xl bg-gradient-to-r from-cyan-500 to-blue-600 text-slate-950 shadow-xl shadow-cyan-500/30 flex items-center justify-center font-bold"
        title="Add Magnet Link"
      >
        <Plus className="w-6 h-6 stroke-[2.5]" />
      </button>

      {/* Mobile Bottom Navigation Bar (Requirement 10: mobile friendly) */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-slate-950/95 backdrop-blur-lg border-t border-slate-800 px-2 py-2 flex items-center justify-around">
        <button
          onClick={() => setActiveTab('transfers')}
          className={`flex flex-col items-center gap-1 p-2 rounded-xl transition ${
            activeTab === 'transfers' ? 'text-cyan-400' : 'text-slate-400'
          }`}
        >
          <Download className="w-5 h-5" />
          <span className="text-[10px] font-semibold">Transfers</span>
        </button>

        <button
          onClick={() => setActiveTab('files')}
          className={`flex flex-col items-center gap-1 p-2 rounded-xl transition ${
            activeTab === 'files' ? 'text-cyan-400' : 'text-slate-400'
          }`}
        >
          <Folder className="w-5 h-5" />
          <span className="text-[10px] font-semibold">Files</span>
        </button>

        <button
          onClick={() => setActiveTab('shared')}
          className={`flex flex-col items-center gap-1 p-2 rounded-xl transition ${
            activeTab === 'shared' ? 'text-cyan-400' : 'text-slate-400'
          }`}
        >
          <Share2 className="w-5 h-5" />
          <span className="text-[10px] font-semibold">Shared</span>
        </button>

        <button
          onClick={() => setActiveTab('activity')}
          className={`flex flex-col items-center gap-1 p-2 rounded-xl transition ${
            activeTab === 'activity' ? 'text-cyan-400' : 'text-slate-400'
          }`}
        >
          <History className="w-5 h-5" />
          <span className="text-[10px] font-semibold">Logs</span>
        </button>

        <button
          onClick={() => setActiveTab('storage')}
          className={`flex flex-col items-center gap-1 p-2 rounded-xl transition ${
            activeTab === 'storage' ? 'text-cyan-400' : 'text-slate-400'
          }`}
        >
          <Sparkles className="w-5 h-5" />
          <span className="text-[10px] font-semibold">Storage</span>
        </button>
      </nav>

      {/* Modals */}
      <AddMagnetModal
        isOpen={isAddMagnetOpen}
        onClose={() => setIsAddMagnetOpen(false)}
        onAdd={handleAddMagnet}
        defaultFolder={currentFolder === '/' ? 'Downloads' : currentFolder.replace('/', '')}
      />

      <FilePrioModal
        torrent={prioTorrent}
        onClose={() => setPrioTorrent(null)}
        onUpdatePriority={handleUpdateFilePriority}
      />

      <StorageCleanupModal
        isOpen={isCleanupOpen}
        onClose={() => setIsCleanupOpen(false)}
        stats={storageStats}
        settings={cleanupSettings}
        onUpdateSettings={async (settings) => {
          const updated = await api.updateCleanupSettings(settings);
          setCleanupSettings(updated);
        }}
        onRunCleanup={handleRunCleanup}
      />

      <FolderShareModal
        folder={shareFolder}
        users={users}
        onClose={() => setShareFolder(null)}
        onSave={handleFolderShareSave}
      />

      <NotificationCenter
        notifications={notifications}
        isOpen={isNotificationsOpen}
        onClose={() => setIsNotificationsOpen(false)}
        onMarkRead={async () => {
          await api.markNotificationsRead();
          setNotifications(prev => prev.map(n => ({ ...n, read: true })));
        }}
        onTestPush={async () => {
          await api.testNotification();
          dispatchBrowserNotification('SeedFlow Push Notification Test', 'Push alert successfully triggered! Everything is running smoothly.');
          const notifs = await api.getNotifications();
          setNotifications(notifs);
        }}
      />

      <QbtSettingsModal
        isOpen={isQbtSettingsOpen}
        onClose={() => setIsQbtSettingsOpen(false)}
        settings={qbtSettings}
        onSave={async (s) => {
          const updated = await api.updateQbtSettings(s);
          setQbtSettings(updated);
        }}
      />

      <CreateFolderModal
        isOpen={isCreateFolderOpen}
        onClose={() => setIsCreateFolderOpen(false)}
        onCreate={handleCreateFolder}
        currentPath={currentFolder}
      />

      <MoveFileModal
        file={moveFile}
        folders={folders}
        onClose={() => setMoveFile(null)}
        onMove={handleMoveFile}
      />

      <RenameModal
        item={renameItem}
        onClose={() => setRenameItem(null)}
        onRename={handleRename}
      />

      {deleteTarget && (
        <ConfirmDeleteModal
          isOpen={Boolean(deleteTarget)}
          title={deleteTarget.type === 'file' ? 'Delete File' : 'Remove Torrent Task'}
          itemName={deleteTarget.name}
          itemDetails={deleteTarget.details}
          itemType={deleteTarget.type}
          onConfirm={handleConfirmDelete}
          onClose={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}
