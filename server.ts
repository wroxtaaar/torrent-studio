import 'dotenv/config';
import express, { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import * as archiver from 'archiver';
import { installQbtProxy } from './src/qbtProxy.ts';
import type {
  StorageFile, StorageFolder, UserProfile, StorageStats,
  ActivityLog, AppNotification, CleanupSettings, QbtSettings
} from './src/types/index.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT) || 3000;

const STORAGE_DIR = path.resolve(process.env.STORAGE_DIR || path.join(__dirname, 'storage'));
const defaultDownloadsDir = fs.existsSync(path.resolve(process.cwd(), 'downloads'))
  ? path.resolve(process.cwd(), 'downloads')
  : path.join(STORAGE_DIR, 'downloads');
const DOWNLOADS_DIR = path.resolve(process.env.DOWNLOADS_DIR || defaultDownloadsDir);
const META_DIR = path.join(STORAGE_DIR, 'meta');
const STREAM_CACHE_DIR = path.join(STORAGE_DIR, 'stream-cache');
const HLS_CACHE_DIR = path.join(STORAGE_DIR, 'hls-cache');
const USERS_FILE = path.join(META_DIR, 'users.json');
const FOLDERS_FILE = path.join(META_DIR, 'folders.json');
const LOGS_FILE = path.join(META_DIR, 'logs.json');
const NOTIFICATIONS_FILE = path.join(META_DIR, 'notifications.json');
const CLEANUP_FILE = path.join(META_DIR, 'cleanup.json');

for (const dir of [STORAGE_DIR, DOWNLOADS_DIR, META_DIR, STREAM_CACHE_DIR, HLS_CACHE_DIR]) fs.mkdirSync(dir, { recursive: true });

const qbtBase = (process.env.QBT_URL || process.env.QBITTORRENT_URL || 'http://qbittorrent:8080').replace(/\/$/, '');
const qbtUser = process.env.QBT_USERNAME || process.env.QBITTORRENT_USERNAME || '';
const qbtPassword = process.env.QBT_PASSWORD || process.env.QBITTORRENT_PASSWORD || '';
const qbtApiKey = process.env.QBT_API_KEY || process.env.QBITTORRENT_API_KEY || '';

function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return fallback; }
}
function writeJson(file: string, value: unknown) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

const defaultUser: UserProfile = {
  id: 'user_admin',
  name: 'Admin',
  email: 'admin@localhost',
  role: 'admin',
  avatar: 'https://ui-avatars.com/api/?name=Admin&background=random'
};

let users = readJson<UserProfile[]>(USERS_FILE, [defaultUser]);
if (!users.length) users = [defaultUser];
let activeUserId = users[0].id;

type FolderMeta = Omit<StorageFolder, 'filesCount' | 'totalSize'>;
let folderMeta = readJson<FolderMeta[]>(FOLDERS_FILE, [{
  id: 'folder_root',
  name: 'Root Storage',
  path: '/',
  ownerId: users[0].id,
  ownerName: users[0].name,
  isShared: false,
  permissions: {},
  createdAt: Date.now()
}]);

let logs = readJson<ActivityLog[]>(LOGS_FILE, []);
let notifications = readJson<AppNotification[]>(NOTIFICATIONS_FILE, []);
let cleanupSettings = readJson<CleanupSettings>(CLEANUP_FILE, {
  autoCleanCompletedDays: 7,
  autoPurgeOrphans: true,
  autoCleanTempFiles: true,
  storageThresholdPercent: 85,
  lastCleanedAt: undefined
});

function activeUser() { return users.find(u => u.id === activeUserId) || users[0]; }
function log(type: ActivityLog['type'], action: string, details: string, status: ActivityLog['status'] = 'info') {
  const u = activeUser();
  logs.unshift({
    id: crypto.randomUUID(), timestamp: Date.now(), type,
    userName: u.name, userId: u.id, action, details, status
  });
  logs = logs.slice(0, 300);
  writeJson(LOGS_FILE, logs);
}
function notify(title: string, message: string, type: AppNotification['type'], link?: string) {
  notifications.unshift({
    id: crypto.randomUUID(), timestamp: Date.now(), title, message,
    type, read: false, link
  });
  notifications = notifications.slice(0, 100);
  writeJson(NOTIFICATIONS_FILE, notifications);
}

function safeRelative(input: string) {
  const normalized = path.posix.normalize('/' + String(input).replace(/\\/g, '/')).replace(/^\/+/, '');
  if (!normalized || normalized === '.') return '';
  if (normalized.split('/').includes('..')) throw new Error('Invalid path');
  return normalized;
}
function physicalFromRelative(relative: string) {
  const rel = safeRelative(relative);
  const full = path.resolve(DOWNLOADS_DIR, rel);
  if (full !== DOWNLOADS_DIR && !full.startsWith(DOWNLOADS_DIR + path.sep)) throw new Error('Invalid path');
  return full;
}
function relativeFromPhysical(full: string) {
  return path.relative(DOWNLOADS_DIR, full).split(path.sep).join('/');
}
function fileId(relative: string) {
  return 'file_' + crypto.createHash('sha256').update(relative).digest('hex').slice(0, 24);
}
function folderId(relative: string) {
  return 'folder_' + crypto.createHash('sha256').update(relative || '/').digest('hex').slice(0, 24);
}
function fileType(name: string): StorageFile['type'] {
  const e = path.extname(name).toLowerCase();
  if (['.mp4','.m4v','.webm','.mov','.mkv','.avi'].includes(e)) return 'video';
  if (['.mp3','.wav','.flac','.aac','.ogg','.m4a'].includes(e)) return 'audio';
  if (['.jpg','.jpeg','.png','.webp','.gif','.svg'].includes(e)) return 'image';
  if (['.zip','.tar','.gz','.7z','.rar','.iso'].includes(e)) return 'archive';
  if (['.pdf','.txt','.md','.json','.csv','.srt','.vtt'].includes(e)) return 'document';
  return 'other';
}
function mimeFor(name: string) {
  const e = path.extname(name).toLowerCase();
  const map: Record<string,string> = {
    '.mp4':'video/mp4','.m4v':'video/mp4','.webm':'video/webm','.mov':'video/quicktime',
    '.mkv':'video/x-matroska','.avi':'video/x-msvideo','.mp3':'audio/mpeg','.wav':'audio/wav',
    '.flac':'audio/flac','.aac':'audio/aac','.ogg':'audio/ogg','.m4a':'audio/mp4',
    '.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp',
    '.gif':'image/gif','.svg':'image/svg+xml','.zip':'application/zip','.pdf':'application/pdf',
    '.txt':'text/plain','.md':'text/markdown','.json':'application/json','.csv':'text/csv',
    '.srt':'application/x-subrip','.vtt':'text/vtt'
  };
  return map[e] || 'application/octet-stream';
}
function scanFiles(): StorageFile[] {
  const result: StorageFile[] = [];
  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.isFile()) continue;
      // qBittorrent's .parts files are internal temporary storage artifacts,
      // not user-facing media/files. Keep them out of the Cloud Files view.
      if (entry.name.toLowerCase().endsWith('.parts')) continue;
      const rel = relativeFromPhysical(full);
      const stat = fs.statSync(full);
      const folder = path.posix.dirname('/' + rel);
      const name = path.posix.basename(rel);
      const type = fileType(name);
      result.push({
        id: fileId(rel), name, path: '/' + rel, folder: folder === '.' ? '/' : folder,
        size: stat.size, type, mimeType: mimeFor(name), createdAt: stat.birthtimeMs || stat.ctimeMs,
        isStreamable: type === 'video' || type === 'audio',
        ownerId: activeUser().id, ownerName: activeUser().name,
        downloadUrl: '/api/files/download/' + fileId(rel),
        streamUrl: '/api/files/stream/' + fileId(rel)
      });
    }
  }
  walk(DOWNLOADS_DIR);
  return result.sort((a,b) => b.createdAt - a.createdAt);
}
function scanFolders(): StorageFolder[] {
  const found: StorageFolder[] = [{
    id: 'folder_root', name: 'Root Storage', path: '/', ownerId: users[0].id,
    ownerName: users[0].name, isShared: false, permissions: {}, createdAt: 0
  }];
  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      const rel = relativeFromPhysical(full);
      const p = '/' + rel;
      const meta = folderMeta.find(f => f.path === p);
      found.push(meta ? { ...meta } : {
        id: folderId(rel), name: entry.name, path: p, ownerId: users[0].id,
        ownerName: users[0].name, isShared: false, permissions: {}, createdAt: fs.statSync(full).birthtimeMs || 0
      });
      walk(full);
    }
  }
  walk(DOWNLOADS_DIR);
  const files = scanFiles();
  return found.map(f => {
    const inside = files.filter(x => x.folder === f.path);
    return { ...f, filesCount: inside.length, totalSize: inside.reduce((s,x)=>s+x.size,0) };
  });
}

async function qbtFetch(pathname: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (qbtApiKey) headers.set('Authorization', 'Bearer ' + qbtApiKey);
  else if (qbtUser && qbtPassword) headers.set('Authorization', 'Basic ' + Buffer.from(qbtUser + ':' + qbtPassword).toString('base64'));
  headers.set('Referer', qbtBase + '/');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try { return await fetch(qbtBase + pathname, { ...init, headers, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}
async function qbtJson(pathname: string, init: RequestInit = {}) {
  const r = await qbtFetch(pathname, init);
  const text = await r.text();
  if (!r.ok) throw Object.assign(new Error(text || r.statusText), { status: r.status });
  try { return text ? JSON.parse(text) : null; } catch { return text; }
}

function storageStats(torrentCount: number): StorageStats {
  const s = fs.statfsSync(DOWNLOADS_DIR);
  const total = Number(s.blocks) * Number(s.bsize);
  const free = Number(s.bavail) * Number(s.bsize);
  const used = Math.max(0, total - free);
  const pct = total ? Math.round((used / total) * 1000) / 10 : 0;
  return {
    totalBytes: total, usedBytes: used, freeBytes: free, usedPercentage: pct,
    filesCount: scanFiles().length, torrentsCount: torrentCount,
    isUnlimited: false,
    serverCapacityLabel: `${(total / 1024 / 1024 / 1024).toFixed(1)} GB Server Disk`,
    alertLevel: pct >= 90 ? 'critical' : pct >= 80 ? 'warning' : 'normal'
  };
}
function cleanup(dryRun = false) {
  let bytesFreed = 0, tempRemoved = 0;
  const temp = path.join(STORAGE_DIR, 'temp');
  if (fs.existsSync(temp)) {
    for (const n of fs.readdirSync(temp)) {
      const p = path.join(temp,n); const st = fs.statSync(p);
      bytesFreed += st.size; tempRemoved++;
      if (!dryRun) fs.rmSync(p, { recursive: true, force: true });
    }
  }
  cleanupSettings.lastCleanedAt = Date.now();
  writeJson(CLEANUP_FILE, cleanupSettings);
  if (!dryRun) log('cleanup','Storage Cleanup Executed',`Removed ${tempRemoved} temporary item(s) and freed ${bytesFreed} bytes.`,'success');
  return { bytesFreed, filesRemoved: 0, tempRemoved, orphansRemoved: 0 };
}

function resolveQbtDownloadPath(torrent: any, qbtFile: any): string | null {
  const qbtName = String(qbtFile?.name || '').replace(/^[/\\]+/, '');
  const qbtSavePath = String(torrent?.save_path || '/downloads');
  const qbtContentPath = String(torrent?.content_path || '');
  const downloadsRoot = path.resolve(DOWNLOADS_DIR);

  const mapQbtPath = (qbtPath: string): string => {
    if (qbtPath === '/downloads' || qbtPath.startsWith('/downloads/')) {
      const suffix = qbtPath.slice('/downloads'.length).replace(/^[/\\]+/, '');
      return path.resolve(DOWNLOADS_DIR, suffix);
    }
    return path.resolve(qbtPath);
  };

  const candidates: string[] = [];

  if (qbtContentPath && qbtContentPath.startsWith('/downloads')) {
    const mappedContent = mapQbtPath(qbtContentPath);
    try {
      if (fs.existsSync(mappedContent) && fs.statSync(mappedContent).isFile()) {
        candidates.push(mappedContent);
      }
    } catch {}
  }

  if (qbtName) {
    candidates.push(mapQbtPath(qbtSavePath + '/' + qbtName));
  }

  if (qbtContentPath && qbtContentPath.startsWith('/downloads')) {
    const mappedContent = mapQbtPath(qbtContentPath);
    candidates.push(path.join(mappedContent, path.basename(qbtName)));
    candidates.push(path.join(mappedContent, qbtName));
  }

  for (const candidate of candidates) {
    const full = path.resolve(candidate);
    if (full !== downloadsRoot && !full.startsWith(downloadsRoot + path.sep)) continue;
    try {
      if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
    } catch {}
  }

  return null;
}

const streamPreparation = new Map<string, Promise<string>>();

function streamCachePath(sourcePath: string) {
  const stat = fs.statSync(sourcePath);
  const key = crypto
    .createHash('sha256')
    .update('browser-h264-v2')
    .update(sourcePath)
    .update(String(stat.size))
    .update(String(stat.mtimeMs))
    .digest('hex');
  return path.join(STREAM_CACHE_DIR, key + '.mp4');
}

async function runFfmpeg(args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], {
      stdio: ['ignore', 'ignore', 'pipe']
    });

    let stderr = '';
    ffmpeg.stderr.on('data', chunk => {
      stderr += chunk.toString();
      if (stderr.length > 6000) stderr = stderr.slice(-6000);
    });

    ffmpeg.on('error', reject);
    ffmpeg.on('close', code => {
      if (code === 0) return resolve();
      reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}`));
    });
  });
}

async function prepareBrowserVideo(sourcePath: string): Promise<string> {
  const cached = streamCachePath(sourcePath);
  if (fs.existsSync(cached) && fs.statSync(cached).size > 0) return cached;

  const existing = streamPreparation.get(cached);
  if (existing) return existing;

  const job = (async () => {
    const temp = cached + '.tmp';
    fs.rmSync(temp, { force: true });

    // Always produce a browser-safe H.264/AVC + AAC MP4. This avoids relying
    // on the source MKV codec/profile being supported by Chromium/Edge.
    await runFfmpeg([
      '-i', sourcePath,
      '-map', '0:v:0',
      '-map', '0:a:0?',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '23',
      '-pix_fmt', 'yuv420p',
      '-profile:v', 'high',
      '-level:v', '4.1',
      '-c:a', 'aac',
      '-b:a', '160k',
      '-ar', '48000',
      '-movflags', '+faststart',
      '-f', 'mp4',
      temp
    ]);

    if (!fs.existsSync(temp) || fs.statSync(temp).size === 0) {
      throw new Error('ffmpeg produced an empty streaming file');
    }

    fs.renameSync(temp, cached);
    return cached;
  })();

  streamPreparation.set(cached, job);
  try {
    return await job;
  } finally {
    streamPreparation.delete(cached);
  }
}

const hlsJobs = new Map<string, Promise<string>>();

async function runCommand(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });

    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) return resolve({ stdout, stderr });
      reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
    });
  });
}

function hlsCacheDirectory(sourcePath: string): string {
  const stat = fs.statSync(sourcePath);
  const key = crypto
    .createHash('sha256')
    .update('hls-v1')
    .update(sourcePath)
    .update(String(stat.size))
    .update(String(stat.mtimeMs))
    .digest('hex');
  return path.join(HLS_CACHE_DIR, key);
}

async function prepareHls(sourcePath: string): Promise<string> {
  const cacheDir = hlsCacheDirectory(sourcePath);
  const playlist = path.join(cacheDir, 'index.m3u8');
  const initSegment = path.join(cacheDir, 'init.mp4');

  if (fs.existsSync(playlist) && fs.existsSync(initSegment)) {
    return cacheDir;
  }

  const existing = hlsJobs.get(cacheDir);
  if (existing) return existing;

  const job = (async () => {
    fs.mkdirSync(cacheDir, { recursive: true });

    // A previous interrupted encode may have left partial output behind.
    // Keep only the final playlist/init when they are valid; otherwise rebuild.
    if (!fs.existsSync(playlist)) {
      for (const name of fs.readdirSync(cacheDir)) {
        fs.rmSync(path.join(cacheDir, name), { force: true });
      }
    }

    let probe: any;
    try {
      const result = await runCommand('ffprobe', [
        '-v', 'error',
        '-print_format', 'json',
        '-show_streams',
        '-show_format',
        sourcePath
      ]);
      probe = JSON.parse(result.stdout || '{}');
    } catch (error) {
      throw new Error('ffprobe could not analyze this media file. Make sure ffmpeg is installed on the VPS.');
    }

    const streams = Array.isArray(probe?.streams) ? probe.streams : [];
    const video = streams.find((s: any) => s.codec_type === 'video');
    const audio = streams.find((s: any) => s.codec_type === 'audio');

    if (!video) throw new Error('No video stream was found in this file.');

    const videoCopySafe =
      String(video.codec_name || '').toLowerCase() === 'h264' &&
      ['yuv420p', 'yuvj420p'].includes(String(video.pix_fmt || '').toLowerCase());

    const audioCopySafe = !audio || String(audio.codec_name || '').toLowerCase() === 'aac';

    const args = [
      '-i', sourcePath,
      '-map', '0:v:0',
      ...(audio ? ['-map', '0:a:0?'] : []),
      '-c:v', videoCopySafe ? 'copy' : 'libx264',
      ...(videoCopySafe ? [] : [
        '-preset', 'veryfast',
        '-crf', '23',
        '-pix_fmt', 'yuv420p',
        '-profile:v', 'high',
        '-level:v', '4.1'
      ]),
      ...(audio
        ? (audioCopySafe
          ? ['-c:a', 'copy']
          : ['-c:a', 'aac', '-b:a', '160k', '-ar', '48000'])
        : []),
      '-f', 'hls',
      '-hls_time', '6',
      '-hls_playlist_type', 'event',
      '-hls_flags', 'independent_segments+temp_file',
      '-hls_segment_type', 'fmp4',
      '-hls_fmp4_init_filename', 'init.mp4',
      '-hls_segment_filename', path.join(cacheDir, 'segment_%05d.m4s'),
      playlist
    ];

    console.log(`[STREAM] Preparing HLS ${videoCopySafe ? 'stream-copy' : 'H264 transcode'} for ${sourcePath}`);

    // Run FFmpeg in the background. The playlist/segments are usable while
    // the job is progressing; this avoids waiting for a whole movie to finish.
    const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], {
      stdio: ['ignore', 'ignore', 'pipe']
    });

    let stderr = '';
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
      if (stderr.length > 6000) stderr = stderr.slice(-6000);
    });

    await new Promise<void>((resolve, reject) => {
      let ready = false;

      const checkReady = () => {
        if (ready) return;
        if (
          fs.existsSync(playlist) &&
          fs.existsSync(initSegment) &&
          fs.existsSync(path.join(cacheDir, 'segment_00000.m4s'))
        ) {
          ready = true;
          resolve();
        }
      };

      const timer = setInterval(checkReady, 200);
      checkReady();

      child.on('error', error => {
        clearInterval(timer);
        if (!ready) reject(error);
      });

      child.on('close', code => {
        clearInterval(timer);
        if (code !== 0) {
          const message = stderr.trim() || `ffmpeg exited with code ${code}`;
          console.error('[STREAM] HLS ffmpeg failed:', message);
          if (!ready) reject(new Error(message));
        }
        if (!ready) {
          reject(new Error('ffmpeg finished without producing a playable HLS playlist.'));
        }
      });
    });

    console.log(`[STREAM] HLS ready: ${cacheDir}`);
    return cacheDir;
  })();

  hlsJobs.set(cacheDir, job);
  try {
    return await job;
  } finally {
    hlsJobs.delete(cacheDir);
  }
}

function sendFile(req: Request, res: Response, fullPath: string, download: boolean) {
  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) return res.status(404).send('File not found');
  const st = fs.statSync(fullPath); const size = st.size;
  const name = path.basename(fullPath); const mime = mimeFor(name);
  res.setHeader('Accept-Ranges','bytes'); res.setHeader('Content-Type',mime);
  if (download) res.setHeader('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  const range = req.headers.range;
  if (!range) { res.setHeader('Content-Length', size); return fs.createReadStream(fullPath).pipe(res); }
  const m = /^bytes=(\\d*)-(\\d*)$/.exec(range);
  if (!m) return res.status(416).end();
  let start = m[1] ? Number(m[1]) : 0;
  let end = m[2] ? Number(m[2]) : size - 1;
  if (m[1] === '' && m[2]) { const suffix = Number(m[2]); start = Math.max(0,size-suffix); end=size-1; }
  if (start < 0 || end >= size || start > end) { res.setHeader('Content-Range',`bytes */${size}`); return res.status(416).end(); }
  res.status(206).setHeader('Content-Range',`bytes ${start}-${end}/${size}`);
  res.setHeader('Content-Length', end-start+1);
  fs.createReadStream(fullPath,{start,end}).pipe(res);
}

async function main() {
  const app = express();
  app.use(express.json({ limit: '100mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use((_req,res,next)=>{ res.setHeader('X-Powered-By','Torrent-Studio'); next(); });

  installQbtProxy(app);

  app.get('/health', async (_req,res)=>{
    try {
      const version = await qbtJson('/api/v2/app/version');
      res.json({ ok:true, qbtConfigured:true, qbtConnected:true, qbtVersion:String(version), port:PORT });
    } catch (e:any) {
      res.status(503).json({ ok:false, qbtConfigured:Boolean(qbtUser && qbtPassword || qbtApiKey), qbtConnected:false, error:e.message });
    }
  });

  app.get('/api/files', (req,res)=>{
    const folder = String(req.query.folder || '/');
    const search = String(req.query.search || '').toLowerCase();
    const type = String(req.query.type || 'all');
    let result = scanFiles().filter(f => f.folder === folder || (folder !== '/' && f.path.startsWith(folder + '/')));
    if (search) result = result.filter(f => f.name.toLowerCase().includes(search));
    if (type !== 'all') result = result.filter(f => f.type === type);
    res.json(result);
  });

  app.get('/api/files/download/:id', (req,res)=>{
    const f = scanFiles().find(x=>x.id===req.params.id);
    if (!f) return res.status(404).send('File not found');
    log('download','File Downloaded',f.path,'info');
    sendFile(req,res,physicalFromRelative(f.path.slice(1)),true);
  });
  app.get('/api/files/stream/:id', async (req,res)=>{
    const f = scanFiles().find(x=>x.id===req.params.id);
    if (!f) return res.status(404).send('File not found');

    const fullPath = physicalFromRelative(f.path.slice(1));
    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
      return res.status(404).send('File not found');
    }

    log('stream','File Streamed',f.path,'info');

    // Video playback uses HLS so the browser gets real segment boundaries,
    // accurate seeking and normal VOD behavior. Audio can use the direct
    // range streamer.
    if (f.type !== 'video') {
      return sendFile(req,res,fullPath,false);
    }

    try {
      const cacheDir = await prepareHls(fullPath);
      const playlistPath = path.join(cacheDir, 'index.m3u8');
      let playlist = fs.readFileSync(playlistPath, 'utf8');

      // Rewrite relative HLS assets to our authenticated/same-origin route.
      const hlsAssetUrl = (asset: string) =>
        `/api/files/hls/${encodeURIComponent(f.id)}/${encodeURIComponent(path.basename(asset))}`;

      playlist = playlist
        .split(/\r?\n/)
        .map(line => {
          const trimmed = line.trim();
          if (!trimmed) return line;

          // fMP4 playlists carry the init segment inside EXT-X-MAP as an
          // URI attribute rather than as a standalone playlist line.
          if (trimmed.startsWith('#EXT-X-MAP:') && trimmed.includes('URI="')) {
            return line.replace(
              /URI="([^"]+)"/,
              (_match, asset) => `URI="${hlsAssetUrl(String(asset))}"`
            );
          }

          if (trimmed.startsWith('#')) return line;
          return hlsAssetUrl(trimmed);
        })
        .join('\n');

      res.setHeader('Content-Type','application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control','no-cache');
      res.setHeader('Access-Control-Allow-Origin','*');
      return res.send(playlist);
    } catch (error: any) {
      console.error('[STREAM] HLS preparation failed:', error);
      return res.status(500).send(error?.message || 'Unable to prepare this video for streaming.');
    }
  });

  app.get('/api/files/hls/:id/:asset', (req,res)=>{
    const f = scanFiles().find(x=>x.id===req.params.id);
    if (!f || f.type !== 'video') return res.status(404).send('Video not found');

    const asset = String(req.params.asset || '');
    if (!/^(index\.m3u8|init\.mp4|segment_\d{5}\.m4s)$/.test(asset)) {
      return res.status(400).send('Invalid HLS asset');
    }

    const fullPath = physicalFromRelative(f.path.slice(1));
    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
      return res.status(404).send('Video not found');
    }

    try {
      const cacheDir = hlsCacheDirectory(fullPath);
      const assetPath = path.join(cacheDir, asset);
      if (!fs.existsSync(assetPath) || !fs.statSync(assetPath).isFile()) {
        return res.status(404).send('HLS segment not ready');
      }

      if (asset.endsWith('.m3u8')) res.type('application/vnd.apple.mpegurl');
      else if (asset.endsWith('.mp4')) res.type('video/mp4');
      else res.type('video/mp4');

      res.setHeader('Cache-Control','no-cache');
      res.setHeader('Access-Control-Allow-Origin','*');
      return res.sendFile(assetPath);
    } catch (error: any) {
      console.error('[STREAM] HLS asset failed:', error);
      return res.status(500).send('Failed to serve HLS media.');
    }
  });

  app.post('/api/files/zip',(req,res)=>{
    const ids = Array.isArray(req.body?.fileIds) ? req.body.fileIds : [];
    const folderPath = req.body?.folderPath ? String(req.body.folderPath) : null;
    const all = scanFiles();
    const selected = ids.length ? all.filter(f=>ids.includes(f.id)) : folderPath ? all.filter(f=>f.folder===folderPath) : [];
    if (!selected.length) return res.status(400).send('No files to archive');
    res.setHeader('Content-Type','application/zip');
    res.setHeader('Content-Disposition',`attachment; filename="Torrent-Studio-Export.zip"`);
    const archive = archiver('zip',{zlib:{level:1}}); archive.pipe(res);
    for (const f of selected) archive.file(physicalFromRelative(f.path.slice(1)),{name:f.path.slice(1)});
    archive.finalize();
  });

  app.post('/api/files/folder',(req,res)=>{
    const name = String(req.body?.name || '').trim();
    const parent = String(req.body?.parentPath || '/');
    if (!name) return res.status(400).send('Folder name is required');
    if (name.includes('/') || name.includes('\\')) return res.status(400).send('Invalid folder name');
    const relParent = safeRelative(parent);
    const rel = relParent ? relParent + '/' + name : name;
    const full = physicalFromRelative(rel);
    if (fs.existsSync(full)) return res.status(409).send('Folder already exists');
    fs.mkdirSync(full,{recursive:true});
    const u=activeUser();
    const meta: FolderMeta={id:folderId(rel),name,path:'/'+rel,ownerId:u.id,ownerName:u.name,isShared:Boolean(req.body?.isShared),permissions:{},createdAt:Date.now()};
    folderMeta.push(meta); writeJson(FOLDERS_FILE,folderMeta);
    log('share','Folder Created',meta.path,'success'); res.json(meta);
  });

  app.post('/api/files/rename',(req,res)=>{
    const id=String(req.body?.id||''); const newName=String(req.body?.newName||'').trim(); const isFolder=Boolean(req.body?.isFolder);
    if(!id||!newName||newName.includes('/')||newName.includes('\\')) return res.status(400).send('Invalid rename');
    if(isFolder){
      const folder=scanFolders().find(f=>f.id===id); if(!folder||folder.path==='/') return res.status(404).send('Folder not found');
      const oldRel=safeRelative(folder.path); const parent=path.posix.dirname(oldRel); const newRel=(parent==='.'?'':parent+'/')+newName;
      fs.renameSync(physicalFromRelative(oldRel),physicalFromRelative(newRel));
      folderMeta=folderMeta.map(f=>f.path===folder.path?{...f,name:newName,path:'/'+newRel}:f);
      writeJson(FOLDERS_FILE,folderMeta); log('share','Folder Renamed',folder.path+' -> /'+newRel,'success'); return res.json({...folder,name:newName,path:'/'+newRel});
    }
    const f=scanFiles().find(x=>x.id===id); if(!f) return res.status(404).send('File not found');
    const oldRel=safeRelative(f.path); const parent=path.posix.dirname(oldRel); const newRel=(parent==='.'?'':parent+'/')+newName;
    fs.renameSync(physicalFromRelative(oldRel),physicalFromRelative(newRel)); log('system','File Renamed',f.path+' -> /'+newRel,'success');
    const nf=scanFiles().find(x=>x.path==='/'+newRel); res.json(nf);
  });

  app.post('/api/files/move',(req,res)=>{
    const id=String(req.body?.fileId||''); const target=String(req.body?.targetFolder||'/');
    const f=scanFiles().find(x=>x.id===id); if(!f) return res.status(404).send('File not found');
    const src=safeRelative(f.path); const dstDir=safeRelative(target); const dst=(dstDir?dstDir+'/':'')+f.name;
    fs.mkdirSync(physicalFromRelative(dstDir),{recursive:true}); fs.renameSync(physicalFromRelative(src),physicalFromRelative(dst));
    log('system','File Moved',f.path+' -> /'+dst,'success'); res.json(scanFiles().find(x=>x.id===fileId(dst)));
  });

  app.post('/api/files/delete',(req,res)=>{
    const id=String(req.body?.id||''); const f=scanFiles().find(x=>x.id===id); if(!f) return res.status(404).send('File not found');
    fs.rmSync(physicalFromRelative(f.path),{force:true}); log('delete','File Deleted',f.path,'warning');
    res.json({success:true,cleanup:cleanup(false)});
  });

  app.get('/api/folders',(_req,res)=>res.json(scanFolders()));
  app.post('/api/folders/share',(req,res)=>{
    const id=String(req.body?.folderId||''); const folder=scanFolders().find(f=>f.id===id); if(!folder) return res.status(404).send('Folder not found');
    const existing=folderMeta.find(f=>f.path===folder.path) || {id:folder.id,name:folder.name,path:folder.path,ownerId:folder.ownerId,ownerName:folder.ownerName,isShared:false,permissions:{},createdAt:folder.createdAt};
    Object.assign(existing,{isShared:req.body?.isShared ?? existing.isShared,permissions:req.body?.permissions ?? existing.permissions});
    folderMeta=folderMeta.filter(f=>f.path!==folder.path); folderMeta.push(existing); writeJson(FOLDERS_FILE,folderMeta);
    log('share','Folder Sharing Updated',folder.path,'info'); res.json({...folder,...existing});
  });

  app.get('/api/users',(_req,res)=>res.json({users,activeUserId,activeUser:activeUser()}));
  app.post('/api/users/switch',(req,res)=>{
    const u=users.find(x=>x.id===req.body?.userId); if(!u) return res.status(404).send('User not found');
    activeUserId=u.id; log('system','Active User Switched',u.name,'info'); res.json({activeUser:u});
  });
  app.post('/api/users/create',(req,res)=>{
    const name=String(req.body?.name||'').trim(), email=String(req.body?.email||'').trim(), role=req.body?.role || 'editor';
    if(!name||!email) return res.status(400).send('Name and email required');
    const u:UserProfile={id:'user_'+crypto.randomUUID(),name,email,role,avatar:'https://ui-avatars.com/api/?name='+encodeURIComponent(name)};
    users.push(u); writeJson(USERS_FILE,users); log('share','User Created',email,'success'); res.json(u);
  });

  app.get('/api/storage/stats',async(_req,res)=>{
    try { const torrents=await qbtJson('/api/v2/torrents/info'); res.json(storageStats(Array.isArray(torrents)?torrents.length:0)); }
    catch { res.json(storageStats(0)); }
  });

  app.get('/api/cleanup/settings',(_req,res)=>res.json(cleanupSettings));
  app.post('/api/cleanup/settings',(req,res)=>{ cleanupSettings={...cleanupSettings,...req.body}; writeJson(CLEANUP_FILE,cleanupSettings); res.json(cleanupSettings); });
  app.post('/api/cleanup/run',(_req,res)=>res.json(cleanup(false)));

  app.get('/api/logs',(_req,res)=>res.json(logs));
  app.post('/api/logs/clear',(_req,res)=>{logs=[];writeJson(LOGS_FILE,logs);res.json({success:true});});
  app.get('/api/notifications',(_req,res)=>res.json(notifications));
  app.post('/api/notifications/read',(_req,res)=>{notifications=notifications.map(n=>({...n,read:true}));writeJson(NOTIFICATIONS_FILE,notifications);res.json({success:true});});
  app.post('/api/notifications/test',(_req,res)=>{notify('Torrent Studio Test','Notifications are working on the VPS.','system');res.json({success:true});});

  app.get('/api/qbt/settings',async(_req,res)=>{
    let connected=false,version='';
    try { version=String(await qbtJson('/api/v2/app/version')); connected=true; } catch {}
    const settings:QbtSettings={isExternal:false,host:qbtBase,username:qbtUser,connected,version};
    res.json(settings);
  });
  app.post('/api/qbt/settings',async(req,res)=>{
    // qBittorrent is intentionally private inside Docker; credentials/URL come from .env.
    let connected=false,version='';
    try { version=String(await qbtJson('/api/v2/app/version')); connected=true; } catch {}
    res.json({isExternal:false,host:qbtBase,username:qbtUser,connected,version});
  });

  app.get('/api/torrents/download/:hash/:index',async(req,res)=>{
    try {
      const hash=String(req.params.hash);
      const index=Number(req.params.index);
      if (!Number.isInteger(index) || index < 0) return res.status(400).send('Invalid file index');

      const list:any[]=await qbtJson('/api/v2/torrents/info?hash='+encodeURIComponent(hash));
      const t=list?.[0]; if(!t) return res.status(404).send('Torrent not found');

      const files:any[]=await qbtJson('/api/v2/torrents/files?hash='+encodeURIComponent(hash));
      const file=files.find(f=>Number(f.index)===index);
      if(!file) return res.status(404).send('Torrent file not found');
      if(Number(file.priority)<=0) return res.status(409).send('File is not selected for download');
      if(Number(file.progress)<0.999) return res.status(409).send('File is not complete');

      const candidate = resolveQbtDownloadPath(t, file);
      if (!candidate) return res.status(404).send('Downloaded file is not present on the server storage');

      log('download','Torrent File Downloaded',String(file.name||''),'info');
      return sendFile(req,res,candidate,true);
    } catch(e:any) {
      res.status(502).send(e.message||'Download failed');
    }
  });

  app.get('/api/torrents/download/:hash',async(req,res)=>{
    try {
      const hash=req.params.hash;
      const list:any[]=await qbtJson('/api/v2/torrents/info?hash='+encodeURIComponent(hash));
      const t=list?.[0]; if(!t) return res.status(404).send('Torrent not found');
      const files:any[]=await qbtJson('/api/v2/torrents/files?hash='+encodeURIComponent(hash));
      const selected=files.filter(f=>Number(f.priority)>0 && Number(f.progress)>=0.999);
      if(!selected.length) return res.status(409).send('Torrent files are not complete');
      if(selected.length===1){
        const candidate = resolveQbtDownloadPath(t, selected[0]);
        if (!candidate) return res.status(404).send('Downloaded file is not present on the server storage');
        return sendFile(req,res,candidate,true);
      }

      const resolvedFiles = selected
        .map((f:any) => ({ file: f, path: resolveQbtDownloadPath(t, f) }))
        .filter((entry:any) => entry.path);

      if(!resolvedFiles.length) return res.status(404).send('Downloaded files are not present on the server storage');

      res.setHeader('Content-Type','application/zip'); res.setHeader('Content-Disposition',`attachment; filename="${encodeURIComponent(t.name)}.zip"`);
      const archive=archiver('zip',{zlib:{level:1}}); archive.pipe(res);
      for(const entry of resolvedFiles){
        const rel = String(entry.file.name || path.basename(entry.path));
        archive.file(entry.path,{name:rel});
      }
      archive.finalize();
    } catch(e:any) { res.status(502).send(e.message||'Download failed'); }
  });

  const isProduction=process.env.NODE_ENV !== 'development';
  if(!isProduction){
    const {createServer}=await import('vite');
    const vite=await createServer({server:{middlewareMode:true},appType:'spa'});
    app.use(vite.middlewares);
  } else {
    const dist=path.resolve(__dirname,'dist');
    app.use(express.static(dist));
    app.get('*',(_req,res)=>res.sendFile(path.join(dist,'index.html')));
  }

  app.listen(PORT,'0.0.0.0',()=>console.log(`Torrent Studio running on 0.0.0.0:${PORT}`));
}
main().catch(e=>{console.error(e);process.exit(1);});
