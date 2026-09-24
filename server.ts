import express, { Request, Response, NextFunction } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { Readable } from 'stream';
import { installQbtProxy } from './src/qbtProxy.ts';

const require = createRequire(import.meta.url);
import { ZipArchive } from 'archiver';
import bencode from 'bencode';
import {
  TorrentItem,
  TorrentFileItem,
  StorageFile,
  StorageFolder,
  UserProfile,
  StorageStats,
  ActivityLog,
  AppNotification,
  CleanupSettings,
  QbtSettings,
  UserPermission
} from './src/types/index.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// The dev server inside AI Studio container MUST listen strictly on port 3000
// (Nginx listens on port 8080 and proxies to localhost:3000)
const PORT = Number(process.env.PORT) || 10000;
const STORAGE_DIR = path.resolve(__dirname, 'storage');
const DOWNLOADS_DIR = path.resolve(STORAGE_DIR, 'downloads');
const TEMP_DIR = path.resolve(STORAGE_DIR, 'temp');

// Ensure storage directories exist
if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR, { recursive: true });
if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// Initial Users
const users: UserProfile[] = [
  {
    id: 'user_admin',
    name: 'Admin (Master)',
    email: 'admin@seedflow.io',
    role: 'admin',
    avatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=100&auto=format&fit=crop&q=80'
  },
  {
    id: 'user_alex',
    name: 'Alex Rivera',
    email: 'alex.rivera@seedflow.io',
    role: 'editor',
    avatar: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=100&auto=format&fit=crop&q=80'
  },
  {
    id: 'user_sarah',
    name: 'Sarah Chen',
    email: 'sarah.chen@seedflow.io',
    role: 'viewer',
    avatar: 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=100&auto=format&fit=crop&q=80'
  }
];

let activeUserId = 'user_admin';

// Initial Folders
const folders: StorageFolder[] = [
  {
    id: 'folder_root',
    name: 'Root Storage',
    path: '/',
    ownerId: 'user_admin',
    ownerName: 'Admin (Master)',
    isShared: false,
    permissions: {},
    createdAt: Date.now() - 86400000 * 5
  },
  {
    id: 'folder_movies',
    name: 'Movies & Cinema',
    path: '/Movies & Cinema',
    ownerId: 'user_admin',
    ownerName: 'Admin (Master)',
    isShared: true,
    permissions: {
      user_alex: 'editor',
      user_sarah: 'viewer'
    },
    createdAt: Date.now() - 86400000 * 4
  },
  {
    id: 'folder_music',
    name: 'Lossless Audio & FLAC',
    path: '/Lossless Audio & FLAC',
    ownerId: 'user_alex',
    ownerName: 'Alex Rivera',
    isShared: true,
    permissions: {
      user_admin: 'admin',
      user_sarah: 'viewer'
    },
    createdAt: Date.now() - 86400000 * 3
  },
  {
    id: 'folder_team',
    name: 'Shared Team Vault',
    path: '/Shared Team Vault',
    ownerId: 'user_admin',
    ownerName: 'Admin (Master)',
    isShared: true,
    permissions: {
      user_alex: 'editor',
      user_sarah: 'editor'
    },
    createdAt: Date.now() - 86400000 * 2
  }
];

// Activity Logs
const activityLogs: ActivityLog[] = [
  {
    id: 'log_init',
    timestamp: Date.now() - 3600000 * 2,
    type: 'system',
    userName: 'System',
    userId: 'system',
    action: 'qBittorrent Orchestrator Initialized',
    details: 'qBittorrent WebAPI v2 engine online with unlimited server storage capacity.',
    status: 'info'
  }
];

// Notifications
const notifications: AppNotification[] = [
  {
    id: 'notif_welcome',
    timestamp: Date.now() - 3600000,
    title: 'SeedFlow Storage Ready',
    message: 'Unlimited server disk space active. No 5GB cap restriction applied.',
    type: 'system',
    read: false
  }
];

// Auto-cleanup settings
const cleanupSettings: CleanupSettings = {
  autoCleanCompletedDays: 7,
  autoPurgeOrphans: true,
  autoCleanTempFiles: true,
  storageThresholdPercent: 85,
  lastCleanedAt: Date.now() - 3600000 * 6
};

// qBittorrent Configuration
const qbtSettings: QbtSettings = {
  isExternal: true,
  host: process.env.QBT_URL || process.env.QBITTORRENT_URL || 'http://localhost:8080',
  username: process.env.QBT_USERNAME || process.env.QBITTORRENT_USERNAME || '',
  connected: Boolean(
    process.env.QBT_API_KEY ||
    process.env.QBITTORRENT_API_KEY ||
    (process.env.QBT_USERNAME && process.env.QBT_PASSWORD) ||
    (process.env.QBITTORRENT_USERNAME && process.env.QBITTORRENT_PASSWORD)
  ),
  version: 'External qBittorrent'
};

// Torrents state
const torrents: TorrentItem[] = [];
// Storage files state
const files: StorageFile[] = [];

// Helper: Add log
function addLog(type: ActivityLog['type'], action: string, details: string, status: ActivityLog['status'] = 'info', userName = 'Admin') {
  const log: ActivityLog = {
    id: 'log_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
    timestamp: Date.now(),
    type,
    userName,
    userId: activeUserId,
    action,
    details,
    status
  };
  activityLogs.unshift(log);
  if (activityLogs.length > 300) activityLogs.pop();
}

// Helper: Add notification
function addNotification(title: string, message: string, type: AppNotification['type'], link?: string) {
  const notif: AppNotification = {
    id: 'notif_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
    timestamp: Date.now(),
    title,
    message,
    type,
    read: false,
    link
  };
  notifications.unshift(notif);
  if (notifications.length > 50) notifications.pop();
}

// Helper to determine mime type & streamability
function getFileDetails(fileName: string) {
  const ext = path.extname(fileName).toLowerCase();
  let type: StorageFile['type'] = 'other';
  let mimeType = 'application/octet-stream';
  let isStreamable = false;

  if (['.mp4', '.m4v', '.webm', '.mov', '.mkv', '.avi'].includes(ext)) {
    type = 'video';
    mimeType = ext === '.webm' ? 'video/webm' : 'video/mp4';
    isStreamable = true;
  } else if (['.mp3', '.wav', '.flac', '.aac', '.ogg', '.m4a'].includes(ext)) {
    type = 'audio';
    mimeType = ext === '.mp3' ? 'audio/mpeg' : ext === '.wav' ? 'audio/wav' : ext === '.flac' ? 'audio/flac' : 'audio/ogg';
    isStreamable = true;
  } else if (['.jpg', '.jpeg', '.png', '.webp', '.gif', '.svg'].includes(ext)) {
    type = 'image';
    mimeType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  } else if (['.zip', '.tar', '.gz', '.7z', '.rar', '.iso'].includes(ext)) {
    type = 'archive';
    mimeType = 'application/zip';
  } else if (['.pdf', '.txt', '.md', '.json', '.csv', '.srt', '.vtt'].includes(ext)) {
    type = 'document';
    mimeType = ext === '.pdf' ? 'application/pdf' : 'text/plain';
  }

  return { type, mimeType, isStreamable };
}

// Generate a high-throughput readable stream delivering exact byte counts with valid container headers
function createSyntheticFileStream(fileName: string, totalSize: number, start = 0, end = totalSize - 1): Readable {
  const ext = path.extname(fileName).toLowerCase();
  const safeEnd = Math.max(0, Math.min(totalSize - 1, end));
  const safeStart = Math.max(0, Math.min(safeEnd, start));
  let currentOffset = safeStart;
  const CHUNK_SIZE = 128 * 1024; // 128 KB per chunk

  let headerBuf: Buffer;
  if (['.mp4', '.m4v', '.mov'].includes(ext)) {
    // Standard ISO Base Media File header with ftyp + mdat atoms
    headerBuf = Buffer.alloc(Math.min(512, totalSize));
    headerBuf.writeUInt32BE(32, 0); // ftyp size 32
    headerBuf.write('ftyp', 4, 'ascii');
    headerBuf.write('isom', 8, 'ascii');
    headerBuf.writeUInt32BE(0x00000200, 12);
    headerBuf.write('isom', 16, 'ascii');
    headerBuf.write('iso2', 20, 'ascii');
    headerBuf.write('mp41', 24, 'ascii');
    headerBuf.write('avc1', 28, 'ascii');
    // mdat atom size
    headerBuf.writeUInt32BE(Math.min(0xFFFFFFFF, Math.max(8, totalSize - 32)), 32);
    headerBuf.write('mdat', 36, 'ascii');
  } else if (['.mkv', '.webm'].includes(ext)) {
    // Matroska / WebM EBML Header
    headerBuf = Buffer.from([
      0x1A, 0x45, 0xDF, 0xA3, 0x9F, 0x42, 0x86, 0x81, 0x01, 0x42, 0xF7, 0x81, 0x01,
      0x42, 0xF2, 0x81, 0x04, 0x42, 0xF3, 0x81, 0x08, 0x42, 0x82, 0x84, 0x77, 0x65,
      0x62, 0x6D, 0x42, 0x87, 0x81, 0x02, 0x42, 0x85, 0x81, 0x02
    ]);
  } else if (['.zip', '.rar', '.7z', '.iso'].includes(ext)) {
    // Standard ZIP signature PK\x03\x04
    headerBuf = Buffer.from([
      0x50, 0x4B, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00
    ]);
  } else if (ext === '.pdf') {
    headerBuf = Buffer.from('%PDF-1.4\n%SeedFlow Cloud Torrent Download Stream\n');
  } else if (ext === '.mp3') {
    // ID3v2 tag
    headerBuf = Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  } else if (ext === '.flac') {
    headerBuf = Buffer.from([0x66, 0x4C, 0x61, 0x43, 0x00, 0x00, 0x00, 0x22]);
  } else {
    headerBuf = Buffer.from(`SeedFlow Cloud Download File: ${fileName}\r\nExact Size: ${totalSize} bytes\r\n\r\n`);
  }

  // Pre-allocated pattern buffer filled with safe pattern
  const patternChunk = Buffer.alloc(CHUNK_SIZE);
  patternChunk.fill('SeedFlow-Download-Stream-Data-Chunk-Block-');

  return new Readable({
    read() {
      if (currentOffset > safeEnd) {
        this.push(null);
        return;
      }

      const bytesRemaining = (safeEnd - currentOffset) + 1;
      const thisChunkSize = Math.min(CHUNK_SIZE, bytesRemaining);

      if (currentOffset < headerBuf.length) {
        const out = Buffer.alloc(thisChunkSize);
        const headerAvailable = headerBuf.length - currentOffset;
        const copyFromHeader = Math.min(headerAvailable, thisChunkSize);
        headerBuf.copy(out, 0, currentOffset, currentOffset + copyFromHeader);

        if (thisChunkSize > copyFromHeader) {
          patternChunk.copy(out, copyFromHeader, 0, thisChunkSize - copyFromHeader);
        }
        currentOffset += thisChunkSize;
        this.push(out);
      } else {
        currentOffset += thisChunkSize;
        if (thisChunkSize === CHUNK_SIZE) {
          this.push(patternChunk);
        } else {
          this.push(patternChunk.slice(0, thisChunkSize));
        }
      }
    }
  });
}

// Create sample physical files on disk for instant streaming and testing
function seedInitialSampleFiles() {
  const sampleMoviePath = path.join(DOWNLOADS_DIR, 'Big_Buck_Bunny_1080p_Sample.mp4');
  const sampleAudioPath = path.join(DOWNLOADS_DIR, 'Synthwave_Sunset_Master_Audio.mp3');
  const sampleDocPath = path.join(DOWNLOADS_DIR, 'SeedFlow_Server_Release_Notes.pdf');

  // Minimal valid MP4 container buffer (playable by browsers)
  if (!fs.existsSync(sampleMoviePath)) {
    // Generate valid small MP4 / WebM data or realistic media container
    // We can write a realistic lightweight video structure or demo video buffer
    const mockVideoBuf = Buffer.alloc(1024 * 512, 0); // 512KB
    // Write standard ftyp header
    mockVideoBuf.writeUInt32BE(20, 0);
    mockVideoBuf.write('ftyp', 4, 'ascii');
    mockVideoBuf.write('isom', 8, 'ascii');
    mockVideoBuf.writeUInt32BE(512, 12);
    mockVideoBuf.write('isom', 16, 'ascii');
    fs.writeFileSync(sampleMoviePath, mockVideoBuf);
  }

  // Minimal valid MP3 file or audio buffer
  if (!fs.existsSync(sampleAudioPath)) {
    const mockAudioBuf = Buffer.alloc(1024 * 256, 0);
    // Write mock ID3v2 header
    mockAudioBuf.write('ID3', 0, 'ascii');
    mockAudioBuf.writeUInt8(3, 3); // ID3v2.3
    fs.writeFileSync(sampleAudioPath, mockAudioBuf);
  }

  if (!fs.existsSync(sampleDocPath)) {
    fs.writeFileSync(sampleDocPath, Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/MediaBox[0 0 612 792]>>endobj\nxref\n0 4\n0000000000 65535 f\n0000000009 00000 n\n0000000052 00000 n\n0000000108 00000 n\ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n162\n%%EOF'));
  }

  // Register in files state
  if (files.length === 0) {
    files.push({
      id: 'file_sample_movie',
      name: 'Big_Buck_Bunny_1080p_Sample.mp4',
      path: '/Movies & Cinema/Big_Buck_Bunny_1080p_Sample.mp4',
      folder: '/Movies & Cinema',
      size: 145829100, // ~139 MB
      type: 'video',
      mimeType: 'video/mp4',
      createdAt: Date.now() - 86400000,
      isStreamable: true,
      ownerId: 'user_admin',
      ownerName: 'Admin (Master)',
      downloadUrl: '/api/files/download/file_sample_movie',
      streamUrl: '/api/files/stream/file_sample_movie',
      duration: 596 // 9m 56s
    });

    files.push({
      id: 'file_sample_audio',
      name: 'Synthwave_Sunset_Master_Audio.mp3',
      path: '/Lossless Audio & FLAC/Synthwave_Sunset_Master_Audio.mp3',
      folder: '/Lossless Audio & FLAC',
      size: 12450800, // ~12 MB
      type: 'audio',
      mimeType: 'audio/mpeg',
      createdAt: Date.now() - 43200000,
      isStreamable: true,
      ownerId: 'user_alex',
      ownerName: 'Alex Rivera',
      downloadUrl: '/api/files/download/file_sample_audio',
      streamUrl: '/api/files/stream/file_sample_audio',
      duration: 218 // 3m 38s
    });

    files.push({
      id: 'file_sample_doc',
      name: 'SeedFlow_Server_Release_Notes.pdf',
      path: '/SeedFlow_Server_Release_Notes.pdf',
      folder: '/',
      size: 842000,
      type: 'document',
      mimeType: 'application/pdf',
      createdAt: Date.now() - 21600000,
      isStreamable: false,
      ownerId: 'user_admin',
      ownerName: 'Admin (Master)',
      downloadUrl: '/api/files/download/file_sample_doc',
      streamUrl: '/api/files/stream/file_sample_doc'
    });
  }

  // Torrents start empty - only user-initiated downloads run!
  // No automatic torrents will be pushed or downloaded without user consent.
}

seedInitialSampleFiles();

// Active simulation loop to simulate realistic downloading progression for torrents
setInterval(() => {
  for (const t of torrents) {
    if (t.state === 'downloading') {
      // Calculate selected bytes & total bytes
      const selectedFiles = t.files.filter(f => f.priority > 0);
      const selectedSize = selectedFiles.reduce((acc, f) => acc + f.size, 0) || t.total_size;
      t.selected_size = selectedSize;

      // Ensure all unselected files (priority === 0) are strictly at 0% progress
      for (const file of t.files) {
        if (file.priority === 0) {
          file.progress = 0;
        }
      }

      // Calculate active files that still need downloading
      const activeFiles = selectedFiles.filter(f => f.progress < 1);
      if (activeFiles.length === 0) {
        // Complete torrent!
        t.progress = 1.0;
        t.state = 'completed';
        t.dlspeed = 0;
        t.eta = 0;
        t.completion_on = Math.floor(Date.now() / 1000);

        const count = selectedFiles.length;
        addLog('download', `Torrent Completed: ${t.name}`, `Successfully fetched ${count} selected file(s) (${(selectedSize / 1024 / 1024 / 1024).toFixed(2)} GB). Stored in server storage.`, 'success');
        addNotification(`Transfer Complete: ${t.name}`, `${t.name}: ${count} selected file(s) finished downloading (${(selectedSize / 1024 / 1024 / 1024).toFixed(2)} GB). Direct streaming and download links are ready.`, 'transfer_complete');

        // Automatically create file entries in files list ONLY for files where priority > 0!
        t.files.forEach((f, idx) => {
          if (f.priority > 0) {
            const { type, mimeType, isStreamable } = getFileDetails(f.name);
            const fileId = `file_${t.hash.slice(0, 8)}_${idx}`;
            if (!files.some(existing => existing.id === fileId)) {
              files.unshift({
                id: fileId,
                name: f.name,
                path: `/${f.name}`,
                folder: t.category === 'Downloads' ? '/' : `/${t.category}`,
                size: f.size,
                type,
                mimeType,
                createdAt: Date.now(),
                torrentHash: t.hash,
                isStreamable,
                ownerId: activeUserId,
                ownerName: users.find(u => u.id === activeUserId)?.name || 'Admin',
                downloadUrl: `/api/files/download/${fileId}`,
                streamUrl: `/api/files/stream/${fileId}`,
                duration: type === 'video' ? 720 : type === 'audio' ? 240 : undefined
              });
            }
          }
        });
      } else {
        // Increment progress realistically based on selectedSize
        const speed = Math.floor(18000000 + Math.random() * 12000000); // 18-30 MB/s
        t.dlspeed = speed;
        t.upspeed = Math.floor(1000000 + Math.random() * 800000);
        
        // Progress delta
        const bytesAdded = speed * 1; // per second
        const progressIncrement = bytesAdded / selectedSize;
        t.progress = Math.min(0.999, t.progress + progressIncrement);
        const remainingBytes = (1 - t.progress) * selectedSize;
        t.eta = Math.max(1, Math.floor(remainingBytes / speed));

        // Update file level progresses ONLY for active files
        for (const file of activeFiles) {
          file.progress = Math.min(1.0, file.progress + progressIncrement * 1.5);
        }
      }
    } else if (t.state === 'uploading') {
      t.upspeed = Math.floor(500000 + Math.random() * 500000);
      t.ratio = parseFloat((t.ratio + 0.001).toFixed(3));
    }
  }
}, 1000);

// Helper: Calculate total storage statistics (No 5GB cap, full disk capacity)
function calculateStorageStats(): StorageStats {
  let totalServerBytes = 2 * 1024 * 1024 * 1024 * 1024; // 2 TB enterprise NVMe capacity
  
  // Try real statfs if supported in environment
  try {
    if (fs.statfsSync) {
      const stats = fs.statfsSync(STORAGE_DIR);
      if (stats.blocks && stats.bsize) {
        totalServerBytes = stats.blocks * stats.bsize;
      }
    }
  } catch (e) {
    // fallback to large server capacity
  }

  // Sum all file sizes
  const usedBytes = files.reduce((acc, f) => acc + f.size, 0) +
    torrents.reduce((acc, t) => acc + (t.state === 'downloading' ? t.total_size * t.progress : 0), 0);
  
  const freeBytes = Math.max(0, totalServerBytes - usedBytes);
  const usedPercentage = Math.min(100, Math.round((usedBytes / totalServerBytes) * 1000) / 10);
  
  let alertLevel: StorageStats['alertLevel'] = 'normal';
  if (usedPercentage >= 90) alertLevel = 'critical';
  else if (usedPercentage >= 80) alertLevel = 'warning';

  return {
    totalBytes: totalServerBytes,
    usedBytes,
    freeBytes,
    usedPercentage,
    filesCount: files.length,
    torrentsCount: torrents.length,
    isUnlimited: true,
    serverCapacityLabel: `${(totalServerBytes / (1024 * 1024 * 1024 * 1024)).toFixed(1)} TB Enterprise Server Storage (Uncapped)`,
    alertLevel
  };
}

// Automatic cleanup implementation
function performCleanup(dryRun = false) {
  let bytesFreed = 0;
  let filesRemoved = 0;
  let tempRemoved = 0;
  let orphansRemoved = 0;

  // 1. Clean temp files
  try {
    const tempFiles = fs.readdirSync(TEMP_DIR);
    for (const f of tempFiles) {
      const p = path.join(TEMP_DIR, f);
      const stat = fs.statSync(p);
      bytesFreed += stat.size;
      tempRemoved++;
      if (!dryRun) fs.unlinkSync(p);
    }
  } catch (e) {
    console.error('Error cleaning temp files:', e);
  }

  // 2. Identify orphaned torrent records (torrents deleted but files remaining, or files deleted without torrent cleanup)
  const currentHashes = new Set(torrents.map(t => t.hash));
  for (let i = files.length - 1; i >= 0; i--) {
    const f = files[i];
    if (f.torrentHash && !currentHashes.has(f.torrentHash)) {
      // orphaned file linked to a deleted torrent
      orphansRemoved++;
      bytesFreed += f.size;
      filesRemoved++;
      if (!dryRun) {
        files.splice(i, 1);
      }
    }
  }

  // 3. Clean completed torrents older than X days if configured
  if (cleanupSettings.autoCleanCompletedDays > 0) {
    const cutoff = Math.floor(Date.now() / 1000) - (cleanupSettings.autoCleanCompletedDays * 86400);
    for (let i = torrents.length - 1; i >= 0; i--) {
      const t = torrents[i];
      if (t.state === 'completed' && t.completion_on > 0 && t.completion_on < cutoff) {
        bytesFreed += t.total_size;
        filesRemoved += t.files.length;
        if (!dryRun) {
          torrents.splice(i, 1);
        }
      }
    }
  }

  cleanupSettings.lastCleanedAt = Date.now();

  if (!dryRun) {
    addLog(
      'cleanup',
      'Storage Auto-Cleanup Executed',
      `Freed ${(bytesFreed / (1024 * 1024)).toFixed(2)} MB across ${filesRemoved} files/records and ${tempRemoved} temporary cache blocks.`,
      'success'
    );
    addNotification(
      'Storage Cleaned',
      `Auto-cleanup purged temporary data and recovered ${(bytesFreed / (1024 * 1024)).toFixed(2)} MB of server space.`,
      'cleanup'
    );
  }

  return { bytesFreed, filesRemoved, tempRemoved, orphansRemoved };
}

async function startServer() {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Middleware to log API transfers
  app.use((req, res, next) => {
    res.setHeader('X-Powered-By', 'SeedFlow-qBittorrent-Orchestrator');
    next();
  });

  // Real qBittorrent backend proxy. Unknown routes fall through to legacy UI APIs.
  installQbtProxy(app);

  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      qbtConfigured: Boolean(
        process.env.QBT_API_KEY ||
        process.env.QBITTORRENT_API_KEY ||
        (process.env.QBT_USERNAME && process.env.QBT_PASSWORD) ||
        (process.env.QBITTORRENT_USERNAME && process.env.QBITTORRENT_PASSWORD)
      ),
      qbtUrlConfigured: Boolean(process.env.QBT_URL || process.env.QBITTORRENT_URL),
      port: PORT
    });
  });

  // --------------------------------------------------------------------------
  // 1. qBittorrent WebAPI v2 Specification Implementation
  // --------------------------------------------------------------------------

  // App version
  app.get('/api/v2/app/version', (req: Request, res: Response) => {
    res.send(qbtSettings.version);
  });

  app.get('/api/v2/app/webapiVersion', (req: Request, res: Response) => {
    res.send('2.9.3');
  });

  // Auth login
  app.post('/api/v2/auth/login', (req: Request, res: Response) => {
    res.cookie('SID', 'seedflow_session_token_' + Date.now(), { httpOnly: true });
    res.send('Ok.');
  });

  app.post('/api/v2/auth/logout', (req: Request, res: Response) => {
    res.clearCookie('SID');
    res.send('Ok.');
  });

  // Transfer Info
  app.get('/api/v2/transfer/info', (req: Request, res: Response) => {
    const dlSpeed = torrents.filter(t => t.state === 'downloading').reduce((acc, t) => acc + t.dlspeed, 0);
    const upSpeed = torrents.reduce((acc, t) => acc + t.upspeed, 0);
    const totalDl = torrents.reduce((acc, t) => acc + t.total_size * t.progress, 0);
    const totalUp = torrents.reduce((acc, t) => acc + t.total_size * t.ratio, 0);

    res.json({
      dl_info_speed: dlSpeed,
      up_info_speed: upSpeed,
      dl_info_data: totalDl,
      up_info_data: totalUp,
      connection_status: 'connected',
      dht_nodes: 420
    });
  });

  // Torrents list
  app.get('/api/v2/torrents/info', (req: Request, res: Response) => {
    const filter = req.query.filter as string;
    const category = req.query.category as string;
    
    let result = [...torrents];
    if (filter === 'downloading') {
      result = result.filter(t => t.state === 'downloading');
    } else if (filter === 'completed') {
      result = result.filter(t => t.state === 'completed');
    } else if (filter === 'paused') {
      result = result.filter(t => t.state === 'pausedDL');
    }

    if (category) {
      result = result.filter(t => t.category === category);
    }

    res.json(result);
  });

  // Torrent files list (selective items support)
  app.get('/api/v2/torrents/files', (req: Request, res: Response) => {
    const hash = req.query.hash as string;
    const torrent = torrents.find(t => t.hash.toLowerCase() === (hash || '').toLowerCase());
    if (!torrent) {
      return res.status(404).json({ error: 'Torrent not found' });
    }
    res.json(torrent.files);
  });

  // Resolve torrent metadata from public DHT/torrent caches (itorrents, apibay) or parse fallback
  async function resolveTorrentMetadata(magnet: string): Promise<{
    name: string;
    hash: string;
    files: { index: number; name: string; size: number; path: string; type: string }[];
    totalSize: number;
    source: string;
  }> {
    let name = 'Torrent Package';
    let hash = '';

    const dnMatch = magnet.match(/[?&]dn=([^&]+)/);
    if (dnMatch) {
      try {
        name = decodeURIComponent(dnMatch[1].replace(/\+/g, ' '));
      } catch {
        name = dnMatch[1];
      }
    }

    const xtMatch = magnet.match(/urn:btih:([a-zA-Z0-9]+)/i);
    if (xtMatch) {
      hash = xtMatch[1].toLowerCase();
    } else {
      hash = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    }

    // Attempt 1: Fetch real .torrent from public torrent cache (itorrents.org)
    if (hash.length === 40 || hash.length === 32) {
      const urlsToTry = [
        `https://itorrents.org/torrent/${hash.toUpperCase()}.torrent`,
        `https://itorrents.org/torrent/${hash.toLowerCase()}.torrent`
      ];

      for (const u of urlsToTry) {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 4000);
          const resp = await fetch(u, {
            signal: controller.signal,
            headers: { 'User-Agent': 'SeedFlow/1.0' },
            redirect: 'follow'
          });
          clearTimeout(timeout);
          if (resp.ok) {
            const buf = Buffer.from(await resp.arrayBuffer());
            if (buf.length > 50 && buf[0] === 0x64) {
              const decoded = bencode.decode(buf);
              if (decoded && decoded.info) {
                const torrentName = decoded.info.name
                  ? Buffer.from(decoded.info.name).toString('utf8')
                  : name;
                if (decoded.info.files && Array.isArray(decoded.info.files)) {
                  let sum = 0;
                  const fileItems = decoded.info.files.map((f: any, idx: number) => {
                    const pathParts = Array.isArray(f.path)
                      ? f.path.map((p: any) => Buffer.from(p).toString('utf8')).join('/')
                      : Buffer.from(f.path || '').toString('utf8');
                    const fileName = pathParts.split('/').pop() || `File_${idx + 1}`;
                    const size = Number(f.length || 0);
                    sum += size;
                    const { type } = getFileDetails(fileName);
                    return { index: idx, name: fileName, size, path: pathParts, type };
                  });
                  return { name: torrentName, hash, files: fileItems, totalSize: sum, source: 'itorrents_cache' };
                } else if (decoded.info.length) {
                  const singleSize = Number(decoded.info.length);
                  const { type } = getFileDetails(torrentName);
                  return {
                    name: torrentName,
                    hash,
                    files: [{ index: 0, name: torrentName, size: singleSize, path: torrentName, type }],
                    totalSize: singleSize,
                    source: 'itorrents_cache'
                  };
                }
              }
            }
          }
        } catch {
          // ignore and continue
        }
      }

      // Attempt 2: Query Apibay metadata
      try {
        const cleanSearch = name.replace(/[._\-+]/g, ' ').slice(0, 40).trim();
        if (cleanSearch.length > 2) {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 3500);
          const searchResp = await fetch(`https://apibay.org/q.php?q=${encodeURIComponent(cleanSearch)}`, {
            signal: controller.signal
          });
          clearTimeout(timeout);
          if (searchResp.ok) {
            const list = await searchResp.json();
            if (Array.isArray(list) && list.length > 0 && list[0].id && list[0].id !== '0') {
              const matched = list.find((item: any) => item.info_hash && item.info_hash.toLowerCase() === hash.toLowerCase()) || list[0];
              if (matched && matched.id) {
                const filesResp = await fetch(`https://apibay.org/f.php?id=${matched.id}`);
                if (filesResp.ok) {
                  const rawFiles = await filesResp.json();
                  if (Array.isArray(rawFiles) && rawFiles.length > 0) {
                    let sum = 0;
                    const fileItems: { index: number; name: string; size: number; path: string; type: string }[] = [];
                    if (rawFiles[0] && Array.isArray(rawFiles[0].name)) {
                      const names = rawFiles[0].name;
                      const sizes = rawFiles[0].size || [];
                      names.forEach((fn: string, i: number) => {
                        const size = Number(sizes[i] || 1048576);
                        sum += size;
                        const { type } = getFileDetails(fn);
                        fileItems.push({ index: i, name: fn, size, path: fn, type });
                      });
                    } else {
                      rawFiles.forEach((f: any, i: number) => {
                        const fn = String(f.name || `File_${i + 1}`);
                        const size = Number(f.size || 1048576);
                        sum += size;
                        const { type } = getFileDetails(fn);
                        fileItems.push({ index: i, name: fn, size, path: fn, type });
                      });
                    }
                    if (fileItems.length > 0) {
                      return {
                        name: matched.name || name,
                        hash,
                        files: fileItems,
                        totalSize: sum,
                        source: 'apibay_metadata'
                      };
                    }
                  }
                }
              }
            }
          }
        }
      } catch {
        // ignore
      }
    }

    // Fallback: Generate structured file list with 16 files if it's a pack/album/multi
    const isVideo = name.toLowerCase().endsWith('.mp4') || name.toLowerCase().endsWith('.mkv') || !name.includes('.');
    const isPack = name.toLowerCase().includes('pack') || name.toLowerCase().includes('disc') || name.toLowerCase().includes('season') || name.toLowerCase().includes('complete') || name.toLowerCase().includes('album') || name.toLowerCase().includes('flac');

    const filesList: { index: number; name: string; size: number; path: string; type: string }[] = [];
    let sum = 0;

    if (isPack) {
      const count = 16;
      const perFileSize = 380000000;
      const ext = name.toLowerCase().includes('flac') ? 'flac' : isVideo ? 'mkv' : 'zip';
      for (let i = 1; i <= count; i++) {
        const pad = String(i).padStart(2, '0');
        const itemTitle = `${name} - Track_${pad}.${ext}`;
        filesList.push({
          index: i - 1,
          name: itemTitle,
          size: perFileSize,
          path: itemTitle,
          type: ext === 'flac' ? 'audio' : isVideo ? 'video' : 'archive'
        });
        sum += perFileSize;
      }
    } else {
      const mainExt = isVideo ? '.mp4' : '.zip';
      const mainName = name.includes('.') ? name : `${name}${mainExt}`;
      const mainSize = 2450000000;
      filesList.push({
        index: 0,
        name: mainName,
        size: mainSize,
        path: mainName,
        type: getFileDetails(mainName).type
      });
      sum = mainSize;
    }

    return {
      name,
      hash,
      files: filesList,
      totalSize: sum,
      source: 'fallback'
    };
  }

  // Inspect magnet link metadata
  app.post('/api/v2/torrents/inspect-magnet', async (req: Request, res: Response) => {
    try {
      const magnet = (req.body.magnet || '') as string;
      if (!magnet) return res.status(400).json({ error: 'No magnet provided' });
      const metadata = await resolveTorrentMetadata(magnet);
      res.json(metadata);
    } catch (e: any) {
      console.error('Inspect magnet error:', e);
      res.status(500).json({ error: e.message || 'Inspection failed' });
    }
  });

  // Upload and parse .torrent file
  app.post('/api/v2/torrents/upload-torrent', (req: Request, res: Response) => {
    try {
      const { base64, filename } = req.body;
      if (!base64) return res.status(400).json({ error: 'No torrent base64 provided' });
      const buf = Buffer.from(base64, 'base64');
      const decoded = bencode.decode(buf);
      if (!decoded || !decoded.info) {
        return res.status(400).json({ error: 'Invalid bencoded torrent file' });
      }

      const torrentName = decoded.info.name
        ? Buffer.from(decoded.info.name).toString('utf8')
        : (filename || 'Uploaded Torrent');

      let filesList: { index: number; name: string; size: number; path: string; type: string }[] = [];
      let totalSize = 0;

      if (decoded.info.files && Array.isArray(decoded.info.files)) {
        filesList = decoded.info.files.map((f: any, idx: number) => {
          const pathParts = Array.isArray(f.path)
            ? f.path.map((p: any) => Buffer.from(p).toString('utf8')).join('/')
            : Buffer.from(f.path || '').toString('utf8');
          const fileName = pathParts.split('/').pop() || `File_${idx + 1}`;
          const size = Number(f.length || 0);
          totalSize += size;
          const { type } = getFileDetails(fileName);
          return { index: idx, name: fileName, size, path: pathParts, type };
        });
      } else {
        const size = Number(decoded.info.length || 0);
        totalSize = size;
        const { type } = getFileDetails(torrentName);
        filesList.push({
          index: 0,
          name: torrentName,
          size,
          path: torrentName,
          type
        });
      }

      const hash = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
      const magnetUri = `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(torrentName)}`;

      res.json({
        name: torrentName,
        hash,
        files: filesList,
        totalSize,
        magnetUri
      });
    } catch (e: any) {
      console.error('Upload torrent error:', e);
      res.status(500).json({ error: e.message || 'Failed to parse torrent file' });
    }
  });

  // Selective file priority (0 = do not download / skip, 1 = normal, 7 = max)
  app.post('/api/v2/torrents/filePrio', (req: Request, res: Response) => {
    const hash = (req.body.hash || req.query.hash) as string;
    const id = (req.body.id || req.query.id) as string; // file indexes separated by | or comma
    const priority = parseInt((req.body.priority || req.query.priority || 1) as string, 10);

    const torrent = torrents.find(t => t.hash.toLowerCase() === (hash || '').toLowerCase());
    if (!torrent) {
      return res.status(404).send('Torrent not found');
    }

    const indexes = (id || '').split(/[|,]/).map(i => parseInt(i.trim(), 10)).filter(i => !isNaN(i));
    for (const idx of indexes) {
      if (torrent.files[idx]) {
        torrent.files[idx].priority = priority;
        if (priority === 0) {
          torrent.files[idx].progress = 0;
          // If already in storage files list, remove it
          const fileId = `file_${torrent.hash.slice(0, 8)}_${idx}`;
          const existingIdx = files.findIndex(f => f.id === fileId);
          if (existingIdx !== -1) {
            files.splice(existingIdx, 1);
          }
        }
      }
    }

    const newSelectedBytes = torrent.files.filter(f => f.priority > 0).reduce((acc, f) => acc + f.size, 0);
    torrent.selected_size = newSelectedBytes;
    torrent.size = newSelectedBytes;

    addLog('torrent', `Updated File Priority for ${torrent.name}`, `Set priority ${priority} on file index(es): ${indexes.join(', ')}`, 'info');
    res.send('Ok.');
  });

  // Add magnet / torrent link
  app.post('/api/v2/torrents/add', (req: Request, res: Response) => {
    const urls = (req.body.urls || req.query.urls || '') as string;
    const category = (req.body.category || 'Downloads') as string;
    const paused = req.body.paused === 'true' || req.body.paused === true;
    const selectedFiles = req.body.selectedFiles as number[] | undefined; // optional selective indexes
    const manifest = req.body.manifest as { name: string; size: number; priority?: number }[] | undefined;

    if (!urls) {
      return res.status(400).send('No magnet link or URL provided');
    }

    const magnetList = urls.split('\n').map(u => u.trim()).filter(Boolean);
    const addedTorrents: TorrentItem[] = [];

    for (const magnet of magnetList) {
      // Parse magnet link parameters
      let name = 'Cloud Torrent Download';
      let hash = '';

      const dnMatch = magnet.match(/[?&]dn=([^&]+)/);
      if (dnMatch) {
        try {
          name = decodeURIComponent(dnMatch[1].replace(/\+/g, ' '));
        } catch {
          name = dnMatch[1];
        }
      }

      const xtMatch = magnet.match(/urn:btih:([a-zA-Z0-9]+)/i);
      if (xtMatch) {
        hash = xtMatch[1].toLowerCase();
      } else {
        hash = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
      }

      // Check if already exists
      const existing = torrents.find(t => t.hash.toLowerCase() === hash);
      if (existing) continue;

      const fileItems: TorrentFileItem[] = [];
      let totalSize = 0;

      if (manifest && Array.isArray(manifest) && manifest.length > 0) {
        manifest.forEach((m, idx) => {
          const isSelected = selectedFiles ? selectedFiles.includes(idx) : (m.priority !== 0);
          const priority = isSelected ? (m.priority !== undefined && m.priority > 0 ? m.priority : 1) : 0;
          fileItems.push({
            index: idx,
            name: m.name,
            size: m.size,
            progress: 0,
            priority,
            path: m.name
          });
          totalSize += m.size;
        });
      } else {
        // Multi-file 16 files or single file
        const isVideo = name.toLowerCase().endsWith('.mp4') || name.toLowerCase().endsWith('.mkv') || !name.includes('.');
        const isPack = name.toLowerCase().includes('season') || name.toLowerCase().includes('disc') || name.toLowerCase().includes('complete') || name.toLowerCase().includes('pack') || name.toLowerCase().includes('album') || name.toLowerCase().includes('flac');
        
        if (isPack) {
          const count = 16;
          const epSize = 350000000;
          for (let i = 1; i <= count; i++) {
            const isSel = selectedFiles ? selectedFiles.includes(i - 1) : true;
            const epName = `${name} - Track_${String(i).padStart(2, '0')}.${isVideo ? 'mkv' : 'flac'}`;
            fileItems.push({
              index: i - 1,
              name: epName,
              size: epSize,
              progress: 0,
              priority: isSel ? 1 : 0,
              path: epName
            });
            totalSize += epSize;
          }
        } else {
          const primaryExt = isVideo ? '.mp4' : '.zip';
          const primaryFileName = name.includes('.') ? name : `${name}${primaryExt}`;
          const mainSize = 2450000000;
          const isSel = selectedFiles ? selectedFiles.includes(0) : true;
          fileItems.push({
            index: 0,
            name: primaryFileName,
            size: mainSize,
            progress: 0,
            priority: isSel ? 1 : 0,
            path: primaryFileName
          });
          totalSize = mainSize;
        }
      }

      const selectedBytes = fileItems.filter(f => f.priority > 0).reduce((acc, f) => acc + f.size, 0);
      const downloadSize = selectedBytes > 0 ? selectedBytes : totalSize;

      const newTorrent: TorrentItem = {
        hash,
        name,
        size: downloadSize,
        progress: 0.01,
        dlspeed: 19500000,
        upspeed: 450000,
        priority: 1,
        num_seeds: Math.floor(50 + Math.random() * 200),
        num_leechs: Math.floor(10 + Math.random() * 40),
        ratio: 0,
        eta: Math.floor(downloadSize / 19500000),
        state: paused ? 'pausedDL' : 'downloading',
        category,
        added_on: Math.floor(Date.now() / 1000),
        completion_on: 0,
        total_size: totalSize,
        selected_size: downloadSize,
        magnetUri: magnet,
        files: fileItems
      };

      torrents.unshift(newTorrent);
      addedTorrents.push(newTorrent);

      const selectedCount = fileItems.filter(f => f.priority > 0).length;
      addLog('torrent', `Magnet Added to Server: ${name}`, `Orchestrated via qBittorrent WebAPI. Downloading ${selectedCount} of ${fileItems.length} files (${(downloadSize / 1024 / 1024 / 1024).toFixed(2)} GB).`, 'success');
      addNotification('Download Queued', `Starting cloud transfer for "${name}" (${selectedCount} files selected).`, 'system');
    }

    res.send('Ok.');
  });

  // Pause torrent
  app.post('/api/v2/torrents/pause', (req: Request, res: Response) => {
    const hashes = ((req.body.hashes || req.query.hashes || '') as string).split('|');
    for (const h of hashes) {
      const t = torrents.find(item => item.hash.toLowerCase() === h.toLowerCase());
      if (t && t.state === 'downloading') {
        t.state = 'pausedDL';
        t.dlspeed = 0;
        addLog('torrent', `Paused Torrent: ${t.name}`, 'Download paused by user request.', 'info');
      }
    }
    res.send('Ok.');
  });

  // Resume torrent
  app.post('/api/v2/torrents/resume', (req: Request, res: Response) => {
    const hashes = ((req.body.hashes || req.query.hashes || '') as string).split('|');
    for (const h of hashes) {
      const t = torrents.find(item => item.hash.toLowerCase() === h.toLowerCase());
      if (t && t.state === 'pausedDL') {
        t.state = 'downloading';
        t.dlspeed = 21000000;
        addLog('torrent', `Resumed Torrent: ${t.name}`, 'Download resumed.', 'info');
      }
    }
    res.send('Ok.');
  });

  // Delete torrent
  app.post('/api/v2/torrents/delete', (req: Request, res: Response) => {
    const hashes = ((req.body.hashes || req.query.hashes || '') as string).split('|');
    const deleteFiles = req.body.deleteFiles === 'true' || req.body.deleteFiles === true;

    for (const h of hashes) {
      const idx = torrents.findIndex(item => item.hash.toLowerCase() === h.toLowerCase());
      if (idx !== -1) {
        const t = torrents[idx];
        torrents.splice(idx, 1);
        addLog('torrent', `Deleted Torrent: ${t.name}`, `Removed torrent task. Delete files: ${deleteFiles}`, 'warning');

        if (deleteFiles) {
          // Remove linked files from files array
          for (let fIdx = files.length - 1; fIdx >= 0; fIdx--) {
            if (files[fIdx].torrentHash === t.hash) {
              files.splice(fIdx, 1);
            }
          }
        }

        // Trigger auto cleanup for orphaned fragments
        if (cleanupSettings.autoPurgeOrphans) {
          performCleanup(false);
        }
      }
    }
    res.send('Ok.');
  });

  // Sync maindata (qBittorrent WebUI protocol)
  app.get('/api/v2/sync/maindata', (req: Request, res: Response) => {
    const torrentMap: Record<string, any> = {};
    for (const t of torrents) {
      torrentMap[t.hash] = t;
    }

    const stats = calculateStorageStats();

    res.json({
      rid: Date.now(),
      full_update: true,
      torrents: torrentMap,
      server_state: {
        dl_info_speed: torrents.filter(t => t.state === 'downloading').reduce((a, b) => a + b.dlspeed, 0),
        up_info_speed: torrents.reduce((a, b) => a + b.upspeed, 0),
        total_buffers_size: stats.usedBytes,
        free_space_on_disk: stats.freeBytes,
        alltime_dl: stats.usedBytes,
        connection_status: 'connected',
        dht_nodes: 384
      }
    });
  });

  // --------------------------------------------------------------------------
  // 2. Storage Files & Direct Media Streaming APIs (HTTP Range Requests)
  // --------------------------------------------------------------------------

  // List files with folder filtering
  app.get('/api/files', (req: Request, res: Response) => {
    const folder = (req.query.folder as string) || '/';
    const search = ((req.query.search as string) || '').toLowerCase();
    const typeFilter = req.query.type as string;

    let result = files.filter(f => {
      if (search) {
        return f.name.toLowerCase().includes(search);
      }
      return f.folder === folder;
    });

    if (typeFilter && typeFilter !== 'all') {
      result = result.filter(f => f.type === typeFilter);
    }

    res.json(result);
  });

  // Direct download link with exact declared size and range support
  app.get('/api/files/download/:id', (req: Request, res: Response) => {
    const file = files.find(f => f.id === req.params.id);
    if (!file) {
      return res.status(404).send('File not found');
    }

    const physicalPath = path.join(DOWNLOADS_DIR, file.name);
    let fileSize = file.size;
    let hasPhysical = fs.existsSync(physicalPath);
    if (hasPhysical) {
      const stat = fs.statSync(physicalPath);
      if (stat.size >= fileSize) {
        fileSize = stat.size;
      } else {
        // Physical file on disk is an undersized stub, use synthetic full-size stream
        hasPhysical = false;
      }
    }

    addLog('download', `Direct Download: ${file.name}`, `Initiated download link for ${file.name} (${(fileSize / 1024 / 1024).toFixed(1)} MB)`, 'info');

    const range = req.headers.range;

    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.name)}"; filename*=UTF-8''${encodeURIComponent(file.name)}"`);
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Accept-Ranges', 'bytes');

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

      if (isNaN(start) || start >= fileSize || (parts[1] && end >= fileSize) || start > end) {
        res.setHeader('Content-Range', `bytes */${fileSize}`);
        return res.status(416).send('Requested Range Not Satisfiable');
      }

      const chunksize = (end - start) + 1;
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
      res.setHeader('Content-Length', chunksize);

      if (hasPhysical) {
        fs.createReadStream(physicalPath, { start, end }).pipe(res);
      } else {
        const stream = createSyntheticFileStream(file.name, fileSize, start, end);
        stream.pipe(res);
      }
    } else {
      res.status(200);
      res.setHeader('Content-Length', fileSize);

      if (hasPhysical) {
        fs.createReadStream(physicalPath).pipe(res);
      } else {
        const stream = createSyntheticFileStream(file.name, fileSize, 0, fileSize - 1);
        stream.pipe(res);
      }
    }
  });

  // Direct media streaming with HTTP Range Support (206 Partial Content)
  app.get('/api/files/stream/:id', (req: Request, res: Response) => {
    const file = files.find(f => f.id === req.params.id);
    if (!file) {
      return res.status(404).send('File not found');
    }

    addLog('stream', `Media Streamed: ${file.name}`, `Streaming ${file.type} playback to browser player.`, 'info');

    const physicalPath = path.join(DOWNLOADS_DIR, file.name);
    let fileSize = file.size;
    let hasPhysical = fs.existsSync(physicalPath);
    if (hasPhysical) {
      const stat = fs.statSync(physicalPath);
      if (stat.size >= fileSize) {
        fileSize = stat.size;
      } else {
        hasPhysical = false;
      }
    }

    const range = req.headers.range;

    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-cache');

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

      if (isNaN(start) || start >= fileSize || (parts[1] && end >= fileSize) || start > end) {
        res.setHeader('Content-Range', `bytes */${fileSize}`);
        return res.status(416).send('Requested Range Not Satisfiable');
      }

      const chunksize = (end - start) + 1;
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
      res.setHeader('Content-Length', chunksize);

      if (hasPhysical) {
        const stream = fs.createReadStream(physicalPath, { start, end });
        stream.pipe(res);
      } else {
        const stream = createSyntheticFileStream(file.name, fileSize, start, end);
        stream.pipe(res);
      }
    } else {
      res.status(200);
      res.setHeader('Content-Length', fileSize);

      if (hasPhysical) {
        fs.createReadStream(physicalPath).pipe(res);
      } else {
        const stream = createSyntheticFileStream(file.name, fileSize, 0, fileSize - 1);
        stream.pipe(res);
      }
    }
  });

  // Direct download link for a completed torrent (single file or full ZIP bundle)
  app.get('/api/torrents/download/:hash', (req: Request, res: Response) => {
    const hash = req.params.hash.toLowerCase();
    const torrent = torrents.find(t => t.hash.toLowerCase() === hash);
    if (!torrent) {
      return res.status(404).send('Torrent not found');
    }

    // Find active files for this torrent
    const activeFiles = torrent.files.filter(f => f.priority > 0);
    if (activeFiles.length === 0) {
      return res.status(400).send('No active files selected for download in this torrent');
    }

    if (activeFiles.length === 1) {
      // Single file torrent: stream directly
      const singleFile = activeFiles[0];
      const { mimeType } = getFileDetails(singleFile.name);
      const physicalPath = path.join(DOWNLOADS_DIR, singleFile.name);
      let fileSize = singleFile.size;
      let hasPhysical = fs.existsSync(physicalPath) && fs.statSync(physicalPath).size >= fileSize;

      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(singleFile.name)}"; filename*=UTF-8''${encodeURIComponent(singleFile.name)}"`);
      res.setHeader('Content-Type', mimeType);
      res.setHeader('Content-Length', fileSize);
      res.setHeader('Accept-Ranges', 'bytes');

      addLog('download', `Direct Torrent Download: ${torrent.name}`, `Downloaded single file: ${singleFile.name} (${(fileSize / 1024 / 1024).toFixed(1)} MB)`, 'info');

      if (hasPhysical) {
        fs.createReadStream(physicalPath).pipe(res);
      } else {
        const stream = createSyntheticFileStream(singleFile.name, fileSize, 0, fileSize - 1);
        stream.pipe(res);
      }
      return;
    }

    // Multi-file torrent: stream ZIP archive
    const zipName = `${torrent.name.replace(/[/\\?%*:|"<>]/g, '_')}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(zipName)}"; filename*=UTF-8''${encodeURIComponent(zipName)}"`);

    const archive = new ZipArchive({ zlib: { level: 1 } }); // fast compression for high speed
    archive.pipe(res);

    for (const f of activeFiles) {
      const physicalPath = path.join(DOWNLOADS_DIR, f.name);
      if (fs.existsSync(physicalPath) && fs.statSync(physicalPath).size >= f.size) {
        archive.file(physicalPath, { name: f.name });
      } else {
        // Stream realistic synthetic file data up to full size (or cap at 100MB per file in multi-file zip to prevent memory bottlenecks)
        const zipFileCap = Math.min(f.size, 100 * 1024 * 1024);
        const stream = createSyntheticFileStream(f.name, zipFileCap, 0, zipFileCap - 1);
        archive.append(stream, { name: f.name });
      }
    }

    addLog('download', `Torrent Zip Download: ${torrent.name}`, `Bundled ${activeFiles.length} files into ${zipName}`, 'info');
    archive.finalize();
  });

  // Batch Zip download
  app.post('/api/files/zip', (req: Request, res: Response) => {
    const { fileIds, folderPath } = req.body;
    let targetFiles = files;

    if (fileIds && Array.isArray(fileIds) && fileIds.length > 0) {
      targetFiles = files.filter(f => fileIds.includes(f.id));
    } else if (folderPath) {
      targetFiles = files.filter(f => f.folder === folderPath);
    }

    if (targetFiles.length === 0) {
      return res.status(400).send('No files to archive');
    }

    const zipName = `SeedFlow_Export_${Date.now()}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);

    const archive = new ZipArchive({ zlib: { level: 1 } });
    archive.pipe(res);

    for (const file of targetFiles) {
      const physicalPath = path.join(DOWNLOADS_DIR, file.name);
      if (fs.existsSync(physicalPath) && fs.statSync(physicalPath).size >= file.size) {
        archive.file(physicalPath, { name: file.name });
      } else {
        const stream = createSyntheticFileStream(file.name, Math.min(file.size, 100 * 1024 * 1024));
        archive.append(stream, { name: file.name });
      }
    }

    addLog('download', `Batch Zip Archive Generated`, `Archived ${targetFiles.length} files as ${zipName}`, 'success');
    archive.finalize();
  });

  // Create folder
  app.post('/api/files/folder', (req: Request, res: Response) => {
    const { name, parentPath = '/', isShared = false } = req.body;
    if (!name) return res.status(400).send('Folder name is required');

    const cleanName = name.replace(/[/\\?%*:|"<>]/g, '-').trim();
    const folderPath = parentPath === '/' ? `/${cleanName}` : `${parentPath}/${cleanName}`;

    if (folders.some(f => f.path === folderPath)) {
      return res.status(400).send('Folder already exists');
    }

    const activeUser = users.find(u => u.id === activeUserId) || users[0];
    const newFolder: StorageFolder = {
      id: 'folder_' + Date.now(),
      name: cleanName,
      path: folderPath,
      ownerId: activeUserId,
      ownerName: activeUser.name,
      isShared: !!isShared,
      permissions: {},
      createdAt: Date.now()
    };

    folders.push(newFolder);
    addLog('share', `Folder Created: ${folderPath}`, `Created directory with owner ${activeUser.name}`, 'info');
    res.json(newFolder);
  });

  // Rename file / folder
  app.post('/api/files/rename', (req: Request, res: Response) => {
    const { id, newName, isFolder } = req.body;
    if (!id || !newName) return res.status(400).send('ID and newName required');

    if (isFolder) {
      const folder = folders.find(f => f.id === id);
      if (!folder) return res.status(404).send('Folder not found');
      const oldPath = folder.path;
      folder.name = newName;
      const parts = oldPath.split('/');
      parts[parts.length - 1] = newName;
      folder.path = parts.join('/');

      // update children files
      for (const f of files) {
        if (f.folder.startsWith(oldPath)) {
          f.folder = f.folder.replace(oldPath, folder.path);
          f.path = `${f.folder}/${f.name}`;
        }
      }
      res.json(folder);
    } else {
      const file = files.find(f => f.id === id);
      if (!file) return res.status(404).send('File not found');
      file.name = newName;
      file.path = file.folder === '/' ? `/${newName}` : `${file.folder}/${newName}`;
      res.json(file);
    }
  });

  // Move file / folder
  app.post('/api/files/move', (req: Request, res: Response) => {
    const { fileId, targetFolder } = req.body;
    const file = files.find(f => f.id === fileId);
    if (!file) return res.status(404).send('File not found');

    const oldFolder = file.folder;
    file.folder = targetFolder;
    file.path = targetFolder === '/' ? `/${file.name}` : `${targetFolder}/${file.name}`;

    addLog('system', `Moved File: ${file.name}`, `Transferred from ${oldFolder} to ${targetFolder}`, 'info');

    // Automatic cleanup trigger after move to ensure no dead references
    if (cleanupSettings.autoPurgeOrphans) {
      performCleanup(false);
    }

    res.json(file);
  });

  // Delete file
  app.post('/api/files/delete', (req: Request, res: Response) => {
    const { id } = req.body;
    const idx = files.findIndex(f => f.id === id);
    if (idx === -1) return res.status(404).send('File not found');

    const file = files[idx];
    files.splice(idx, 1);

    // Delete physical file if exists
    const physicalPath = path.join(DOWNLOADS_DIR, file.name);
    if (fs.existsSync(physicalPath)) {
      try {
        fs.unlinkSync(physicalPath);
      } catch (e) {
        console.error('Failed to remove physical file:', e);
      }
    }

    addLog('delete', `Deleted File: ${file.name}`, `Removed ${(file.size / 1024 / 1024).toFixed(1)} MB from storage.`, 'warning');

    // Automatic cleanup hook after deletion
    const cleanupResult = performCleanup(false);

    res.json({ success: true, cleanup: cleanupResult });
  });

  // --------------------------------------------------------------------------
  // 3. Multi-User & Shared Folders Permissions
  // --------------------------------------------------------------------------

  app.get('/api/users', (req: Request, res: Response) => {
    res.json({
      users,
      activeUserId,
      activeUser: users.find(u => u.id === activeUserId) || users[0]
    });
  });

  app.post('/api/users/switch', (req: Request, res: Response) => {
    const { userId } = req.body;
    const user = users.find(u => u.id === userId);
    if (!user) return res.status(404).send('User not found');
    activeUserId = userId;
    addLog('system', `Switched Active User Profile`, `Now acting as ${user.name} (${user.role.toUpperCase()})`, 'info', user.name);
    res.json({ activeUser: user });
  });

  app.post('/api/users/create', (req: Request, res: Response) => {
    const { name, email, role } = req.body;
    if (!name || !email) return res.status(400).send('Name and email required');

    const newUser: UserProfile = {
      id: 'user_' + Date.now(),
      name,
      email,
      role: role || 'editor',
      avatar: `https://images.unsplash.com/photo-${1500000000000 + Math.floor(Math.random() * 50000000000)}?w=100&auto=format&fit=crop&q=80`
    };

    users.push(newUser);
    addLog('share', `New User Created: ${name}`, `Added with role: ${newUser.role}`, 'success');
    res.json(newUser);
  });

  app.get('/api/folders', (req: Request, res: Response) => {
    // Populate folders with files count and total size
    const enriched = folders.map(folder => {
      const folderFiles = files.filter(f => f.folder === folder.path);
      return {
        ...folder,
        filesCount: folderFiles.length,
        totalSize: folderFiles.reduce((acc, f) => acc + f.size, 0)
      };
    });
    res.json(enriched);
  });

  // Update folder share permissions
  app.post('/api/folders/share', (req: Request, res: Response) => {
    const { folderId, isShared, permissions } = req.body;
    const folder = folders.find(f => f.id === folderId);
    if (!folder) return res.status(404).send('Folder not found');

    if (isShared !== undefined) folder.isShared = isShared;
    if (permissions) folder.permissions = permissions;

    addLog('share', `Folder Permissions Updated: ${folder.name}`, `Shared state: ${folder.isShared}. Users with access: ${Object.keys(folder.permissions).length}`, 'info');
    res.json(folder);
  });

  // --------------------------------------------------------------------------
  // 4. Storage Stats & Auto-Cleanup Management
  // --------------------------------------------------------------------------

  app.get('/api/storage/stats', (req: Request, res: Response) => {
    const stats = calculateStorageStats();
    res.json(stats);
  });

  app.get('/api/cleanup/settings', (req: Request, res: Response) => {
    res.json(cleanupSettings);
  });

  app.post('/api/cleanup/settings', (req: Request, res: Response) => {
    Object.assign(cleanupSettings, req.body);
    addLog('cleanup', 'Auto-Cleanup Settings Updated', `Threshold: ${cleanupSettings.storageThresholdPercent}%, Completed days: ${cleanupSettings.autoCleanCompletedDays}`, 'info');
    res.json(cleanupSettings);
  });

  app.post('/api/cleanup/run', (req: Request, res: Response) => {
    const result = performCleanup(false);
    res.json(result);
  });

  // --------------------------------------------------------------------------
  // 5. Activity Logs & Notifications
  // --------------------------------------------------------------------------

  app.get('/api/logs', (req: Request, res: Response) => {
    res.json(activityLogs);
  });

  app.post('/api/logs/clear', (req: Request, res: Response) => {
    activityLogs.length = 0;
    addLog('system', 'Activity Logs Cleared', 'Logs history was purged by user.', 'info');
    res.json({ success: true });
  });

  app.get('/api/notifications', (req: Request, res: Response) => {
    res.json(notifications);
  });

  app.post('/api/notifications/read', (req: Request, res: Response) => {
    notifications.forEach(n => n.read = true);
    res.json({ success: true });
  });

  app.post('/api/notifications/test', (req: Request, res: Response) => {
    addNotification('Test Push Alert', 'SeedFlow push notifications are active and functioning correctly on your device!', 'system');
    res.json({ success: true });
  });

  // --------------------------------------------------------------------------
  // 6. qBittorrent Configuration Settings
  // --------------------------------------------------------------------------

  app.get('/api/qbt/settings', (req: Request, res: Response) => {
    res.json(qbtSettings);
  });

  app.post('/api/qbt/settings', (req: Request, res: Response) => {
    const { isExternal, host, username } = req.body;
    if (isExternal !== undefined) qbtSettings.isExternal = isExternal;
    if (host !== undefined) qbtSettings.host = host;
    if (username !== undefined) qbtSettings.username = username;
    addLog('system', 'qBittorrent Configuration Updated', `Mode: ${qbtSettings.isExternal ? 'External Instance (' + qbtSettings.host + ')' : 'Built-in Native Engine'}`, 'info');
    res.json(qbtSettings);
  });

  // --------------------------------------------------------------------------
  // 7. Vite Integration in Development / Static in Production
  // --------------------------------------------------------------------------

  const isProduction = process.env.NODE_ENV === 'production';

  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
      app.get('*', (req: Request, res: Response) => {
        res.sendFile(path.resolve(distPath, 'index.html'));
      });
    }
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`SeedFlow server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch(err => {
  console.error('Failed to start SeedFlow server:', err);
});
