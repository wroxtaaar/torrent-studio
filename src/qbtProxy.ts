import bencode from 'bencode';
import crypto from 'crypto';
import type { Express, Request, Response, NextFunction } from 'express';
import { addSeedrTask, canUseSeedr, getSeedrTaskStatus, findSeedrTaskByHash, getSeedrFileDownload, getSeedrFilePresentation, deleteSeedrFile, deleteSeedrFolder, getSeedrFolderDownload, getSeedrQuota, isSeedrConfigured, listSeedrLibrary, seedrMaxSizeBytes } from './seedr.ts';

type QbtConfig = {
  baseUrl: string;
  username?: string;
  password?: string;
  apiKey?: string;
};

const config: QbtConfig = {
  baseUrl: (process.env.QBT_URL || process.env.QBITTORRENT_URL || 'http://qbittorrent:8080').replace(/\/$/, ''),
  username: process.env.QBT_USERNAME || process.env.QBITTORRENT_USERNAME,
  password: process.env.QBT_PASSWORD || process.env.QBITTORRENT_PASSWORD,
  apiKey: process.env.QBT_API_KEY || process.env.QBITTORRENT_API_KEY,
};

// Same-container address used to resolve relative Search -> Add links.
const internalServerBase = (process.env.TORRENT_SEARCH_GRAB_INTERNAL_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');

let qbtSessionCookie = '';
let qbtLoginPromise: Promise<void> | null = null;

// The inspect step may create the torrent before the browser submits the
// selected files. Remember that exact source -> qBittorrent hash mapping so
// the final step can always reuse the paused preview torrent instead of
// attempting a second add (which qBittorrent correctly reports as Conflict).
const previewTorrentHashes = new Map<string, { hash: string; expiresAt: number }>();
const seedrJobs = new Map<string, { selectedNames: string[]; createdAt: number }>();

function rememberPreviewTorrent(source: string, hash: string) {
  previewTorrentHashes.set(source, { hash, expiresAt: Date.now() + 30 * 60 * 1000 });
}

function getPreviewTorrent(source: string): string {
  const entry = previewTorrentHashes.get(source);
  if (!entry) return '';
  if (entry.expiresAt <= Date.now()) {
    previewTorrentHashes.delete(source);
    return '';
  }
  return entry.hash;
}

function isPreviewTorrentHash(hash: string): boolean {
  const normalizedHash = String(hash || '').trim().toLowerCase();
  if (!normalizedHash) return false;

  for (const [source, entry] of previewTorrentHashes) {
    if (entry.expiresAt <= Date.now()) {
      previewTorrentHashes.delete(source);
      continue;
    }
    if (entry.hash.toLowerCase() === normalizedHash) return true;
  }

  return false;
}


function requireConfig() {
  if (!config.baseUrl) throw new Error('QBT_URL is not configured');
  if (!config.apiKey && (!config.username || !config.password)) {
    throw new Error('Set QBT_API_KEY or QBT_USERNAME and QBT_PASSWORD');
  }
}

async function qbtLogin(): Promise<void> {
  if (config.apiKey) return;
  if (qbtSessionCookie) return;
  if (qbtLoginPromise) return qbtLoginPromise;

  qbtLoginPromise = (async () => {
    const form = new URLSearchParams();
    form.set('username', config.username || '');
    form.set('password', config.password || '');

    const response = await fetch(config.baseUrl + '/api/v2/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': config.baseUrl + '/',
        'Origin': config.baseUrl,
      },
      body: form,
    });

    const text = await response.text();

    // qBittorrent 5.2.x can return HTTP 204 with an empty body on a
    // successful WebAPI login. Older versions may return HTTP 200 + "Ok.".
    // The session cookie is the authoritative proof that login succeeded.
    if (!response.ok) {
      throw Object.assign(
        new Error(text || response.statusText || 'qBittorrent login failed'),
        { status: response.status }
      );
    }

    const setCookie = response.headers.get('set-cookie') || '';
    const match = setCookie.match(/(QBT_SID_[^=]+=[^;]+)/);
    if (!match) {
      throw new Error('qBittorrent login succeeded but no session cookie was returned');
    }

    qbtSessionCookie = match[1];
    console.log('[QBT] WebAPI session login successful');
  })();

  try {
    await qbtLoginPromise;
  } finally {
    qbtLoginPromise = null;
  }
}

async function qbtFetchOnce(pathname: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (config.apiKey) {
    headers.set('Authorization', `Bearer ${config.apiKey}`);
  } else {
    headers.set('Cookie', qbtSessionCookie);
  }
  headers.set('Accept', headers.get('Accept') || 'application/json');
  headers.set('Referer', config.baseUrl + '/');
  headers.set('Origin', config.baseUrl);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    return await fetch(config.baseUrl + pathname, {
      ...init,
      headers,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function qbtFetch(pathname: string, init: RequestInit = {}): Promise<Response> {
  requireConfig();

  if (!config.apiKey) await qbtLogin();

  let response = await qbtFetchOnce(pathname, init);

  // qBittorrent sessions can expire. Refresh exactly once rather than
  // repeatedly retrying a bad credential and triggering an IP ban.
  if (response.status === 403 && !config.apiKey) {
    qbtSessionCookie = '';
    await qbtLogin();
    response = await qbtFetchOnce(pathname, init);
  }

  return response;
}

async function qbtJson(pathname: string, init: RequestInit = {}) {
  const response = await qbtFetch(pathname, init);
  const text = await response.text();
  if (!response.ok) {
    const message = text || response.statusText || 'qBittorrent request failed';
    throw Object.assign(new Error(message), { status: response.status });
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function sendError(res: Response, error: unknown, fallback = 'qBittorrent request failed') {
  const status = Number((error as any)?.status) || 502;
  const message = error instanceof Error ? error.message : fallback;
  console.error('[QBT]', message);
  res.status(status >= 400 && status < 600 ? status : 502).json({ error: message });
}

function mapState(state: string): string {
  const map: Record<string, string> = {
    downloading: 'downloading',
    stalledDL: 'stalledDL',
    pausedDL: 'pausedDL',
    stoppedDL: 'pausedDL',
    uploading: 'uploading',
    stalledUP: 'uploading',
    pausedUP: 'completed',
    stoppedUP: 'completed',
    checkingDL: 'checkingDL',
    checkingUP: 'checkingDL',
    checkingResumeData: 'checkingDL',
    moving: 'checkingDL',
    error: 'error',
    missingFiles: 'error',
    forcedDL: 'downloading',
    forcedUP: 'uploading',
    metaDL: 'downloading',
    forcedMetaDL: 'downloading',
  };
  return map[state] || state || 'downloading';
}

function mapTorrent(t: any) {
  return {
    hash: t.hash,
    name: t.name,
    size: Number(t.size ?? t.total_size ?? 0),
    progress: Number(t.progress ?? 0),
    dlspeed: Number(t.dlspeed ?? 0),
    upspeed: Number(t.upspeed ?? 0),
    priority: Number(t.priority ?? 0),
    num_seeds: Number(t.num_seeds ?? 0),
    num_leechs: Number(t.num_leechs ?? t.num_leeches ?? 0),
    ratio: Number(t.ratio ?? 0),
    eta: Number(t.eta ?? -1),
    state: mapState(t.state),
    category: t.category || 'Downloads',
    added_on: Number(t.added_on ?? 0),
    completion_on: Number(t.completion_on ?? 0),
    total_size: Number(t.total_size ?? t.size ?? 0),
    selected_size: Number(t.total_size ?? t.size ?? 0),
    magnetUri: t.magnet_uri || t.magnetUri,
    save_path: t.save_path,
    content_path: t.content_path,
    files: Array.isArray(t.files) ? t.files.map(mapFile) : [],
  };
}

function mapFile(f: any) {
  return {
    index: Number(f.index ?? 0),
    name: f.name || f.path || 'Unknown file',
    size: Number(f.size ?? 0),
    progress: Number(f.progress ?? 0),
    priority: Number(f.priority ?? 1),
    is_seed: Boolean(f.is_seed),
    path: f.name || f.path || '',
  };
}

async function getFiles(hash: string) {
  const files = await qbtJson('/api/v2/torrents/files?hash=' + encodeURIComponent(hash));
  return Array.isArray(files) ? files.map(mapFile) : [];
}

function extractInfoHash(source: string): string {
  const magnetHash = source.match(/urn:btih:([a-zA-Z0-9]+)/i)?.[1] || '';
  if (magnetHash) return magnetHash.toLowerCase();
  if (/^[a-f0-9]{40}$/i.test(source)) return source.toLowerCase();
  return '';
}

async function torrentExists(hash: string): Promise<boolean> {
  if (!hash) return false;
  try {
    const list = await qbtJson('/api/v2/torrents/info?hash=' + encodeURIComponent(hash));
    return Array.isArray(list) && list.length > 0;
  } catch {
    return false;
  }
}

function isRemoteTorrentSource(value: string): boolean {
  return /^https?:\/\//i.test(value) && !value.startsWith(internalServerBase + '/api/v2/');
}

async function addTorrentForMetadata(urls: string, category: string): Promise<string[]> {
  const source = String(urls || '').trim();
  const resolvedSource = source.startsWith('/api/search/torrents/grab/')
    ? internalServerBase + source
    : source;
  const form = new URLSearchParams();
  form.set('savepath', '/downloads');
  form.set('autoTMM', 'false');
  form.set('stopCondition', 'MetadataReceived');
  if (category) form.set('category', category);

  // Magnet URIs can be handed directly to qBittorrent. Search results may
  // instead point at a protected Prowlarr download endpoint, so download the
  // .torrent bytes server-side and upload them to qBittorrent. This keeps API
  // keys out of the browser and avoids relying on qBittorrent's handling of a
  // remote .torrent URL.
  if (isRemoteTorrentSource(resolvedSource)) {
    const response = await fetch(resolvedSource, {
      headers: { 'Accept': 'application/x-bittorrent, application/octet-stream, */*' },
    });

    const data = Buffer.from(await response.arrayBuffer());
    if (!response.ok) {
      const text = data.toString('utf8').slice(0, 1000);
      throw Object.assign(
        new Error(text || `Unable to retrieve torrent file (HTTP ${response.status})`),
        { status: response.status }
      );
    }

    if (!data.length) {
      throw new Error('The search result returned an empty torrent response.');
    }

    // Prowlarr may resolve a search result to a magnet URI rather than a
    // .torrent descriptor. If that magnet is already present in qBittorrent,
    // reuse the existing torrent instead of attempting a duplicate add.
    const textResponse = data.toString('utf8').trim();
    if (/^magnet:\?/i.test(textResponse)) {
      const magnetHash = extractInfoHash(textResponse);

      if (magnetHash && await torrentExists(magnetHash)) {
        console.log('[QBT-PROXY] search magnet already exists, reusing:', magnetHash);
        return [magnetHash];
      }

      const magnetForm = new URLSearchParams(form);
      magnetForm.set('urls', textResponse);
      const magnetResult = await qbtJson('/api/v2/torrents/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: magnetForm,
      });

      console.log('[QBT-PROXY] search result resolved to magnet:', magnetResult);

      const addedIds = Array.isArray(magnetResult?.added_torrent_ids)
        ? magnetResult.added_torrent_ids.map((id: any) => String(id))
        : [];

      if (!addedIds.length && !magnetHash) {
        throw Object.assign(
          new Error('qBittorrent accepted the search magnet but did not return its hash.'),
          { status: 502 }
        );
      }

      return addedIds.length ? addedIds : [magnetHash];
    }

    if (data.length > 50 * 1024 * 1024) {
      throw new Error('The torrent descriptor is unexpectedly large and was rejected.');
    }

    let decoded: any;
    try {
      decoded = bencode.decode(data);
    } catch {
      throw new Error('The search result did not return a valid .torrent file or magnet URI.');
    }

    if (!decoded?.info) {
      throw new Error('The search result torrent is missing its info dictionary.');
    }

    const infoHash = crypto.createHash('sha1')
      .update(bencode.encode(decoded.info))
      .digest('hex')
      .toLowerCase();

    // Search results can point to a torrent that was already inspected or
    // downloaded previously. Reuse it instead of uploading the same .torrent
    // again, which qBittorrent reports as Conflict.
    if (await torrentExists(infoHash)) {
      console.log('[QBT-PROXY] search .torrent already exists, reusing:', infoHash);
      return [infoHash];
    }

    const upload = new FormData();
    upload.append(
      'torrents',
      new Blob([data], { type: 'application/x-bittorrent' }),
      'search-result.torrent'
    );
    upload.append('savepath', '/downloads');
    upload.append('autoTMM', 'false');
    upload.append('stopCondition', 'MetadataReceived');
    if (category) upload.append('category', category);

    const upstream = await qbtFetch('/api/v2/torrents/add', {
      method: 'POST',
      body: upload,
    });

    console.log('[QBT-PROXY] uploaded search torrent:', infoHash, upstream);

    const addedIds = Array.isArray(upstream?.added_torrent_ids)
      ? upstream.added_torrent_ids.map((id: any) => String(id))
      : [];

    return addedIds.length ? addedIds : [infoHash];
  }

  const sourceHash = extractInfoHash(source);
  const upstream = await qbtJson('/api/v2/torrents/add', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: (() => {
      const magnetForm = new URLSearchParams(form);
      magnetForm.set('urls', source);
      return magnetForm;
    })(),
  });

  console.log('[QBT-PROXY] metadata add response:', upstream);

  const addedIds = Array.isArray(upstream?.added_torrent_ids)
    ? upstream.added_torrent_ids.map((id: any) => String(id))
    : [];

  const hashes = addedIds.length ? addedIds : (sourceHash ? [sourceHash] : []);

  if (!hashes.length) {
    throw Object.assign(
      new Error('qBittorrent accepted the torrent but did not return its hash.'),
      { status: 502 }
    );
  }

  return hashes;
}

function classifyFileType(name: string): 'video' | 'audio' | 'archive' | 'document' | 'other' {
  const lower = String(name || '').toLowerCase();
  if (/\.(mp4|mkv|m4v|webm|mov|avi|wmv|flv|ts|m2ts)$/.test(lower)) return 'video';
  if (/\.(mp3|wav|flac|aac|ogg|m4a|opus|wma)$/.test(lower)) return 'audio';
  if (/\.(zip|rar|7z|tar|gz|bz2|xz|iso)$/.test(lower)) return 'archive';
  if (/\.(pdf|txt|md|json|csv|srt|vtt|ass|sub)$/.test(lower)) return 'document';
  return 'other';
}

function mapInspectFiles(files: any[]) {
  return files.map((f: any, index: number) => {
    const name = f.name || f.path || `File_${index + 1}`;
    return {
      index: Number(f.index ?? index),
      name,
      size: Number(f.size ?? f.length ?? 0),
      path: f.path || name,
      type: classifyFileType(name),
      priority: Number(f.priority ?? 0),
    };
  });
}

async function waitForTorrentFiles(hash: string, attempts = 60, delayMs = 2000): Promise<any[]> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const files = await getFiles(hash);
      if (files.length) {
        console.log(`[QBT-PROXY] torrent ${hash}: metadata ready on attempt ${attempt}`);
        return files;
      }
    } catch {
      // qBittorrent can return an error while magnet metadata is still pending.
    }
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  return [];
}

async function waitForTorrent(hash: string, attempts = 12): Promise<any | null> {
  for (let i = 0; i < attempts; i++) {
    try {
      const list = await qbtJson('/api/v2/torrents/info?hash=' + encodeURIComponent(hash));
      if (Array.isArray(list) && list[0]) return list[0];
    } catch {
      // retry
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return null;
}

async function setFilePriorities(hash: string, manifest: Array<{ priority: number }>) {
  if (!manifest.length) return;
  const priorities = manifest.map(item => Number(item.priority) > 0 ? 1 : 0);

  // qBittorrent 5.2.0+ supports priorities while adding. This is the most
  // reliable path for a newly-added magnet when the exact metadata is ready.
  const form = new URLSearchParams();
  form.set('hash', hash);
  form.set('id', priorities.map((_, i) => String(i)).join('|'));
  form.set('priority', '0');
  await qbtJson('/api/v2/torrents/filePrio', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      hash,
      id: priorities.map((p, i) => p ? '' : String(i)).filter(Boolean).join('|'),
      priority: '0',
    }),
  });

  const selectedIds = priorities.map((p, i) => p ? String(i) : '').filter(Boolean).join('|');
  if (selectedIds) {
    await qbtJson('/api/v2/torrents/filePrio', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ hash, id: selectedIds, priority: '1' }),
    });
  }
}

async function inspectMetadata(source: string) {
  // qBittorrent's fetchMetadata endpoint is asynchronous for magnets.
  // The first request normally returns HTTP 202 + an infohash, not the
  // file list. Once metadata is cached, a later request returns HTTP 200
  // with the complete torrent descriptor.
  for (let i = 0; i < 60; i++) {
    const params = new URLSearchParams({ source });
    const response = await qbtFetch('/api/v2/torrents/fetchMetadata', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    });

    const text = await response.text();
    console.log(`[QBT-PROXY] fetchMetadata attempt ${i + 1}/60 -> HTTP ${response.status}: ${text.slice(0, 500)}`);

    // 202 is expected while qBittorrent is fetching magnet metadata.
    if (response.status !== 200 && response.status !== 202) {
      throw Object.assign(new Error(text || response.statusText), { status: response.status });
    }

    if (text) {
      try {
        const data = JSON.parse(text);

        // A completed descriptor contains the torrent name and its files.
        if (data && (data.name || Array.isArray(data.files))) return data;

        // HTTP 202 normally contains only v1/v2/id infohash data.
        // Keep polling the same source until qBittorrent's metadata cache
        // contains the actual descriptor.
      } catch {
        // Metadata is still being resolved.
      }
    }

    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  return null;
}

export function installQbtProxy(app: Express) {
  app.get('/api/seedr/tasks/:taskId', async (req: Request, res: Response) => {
    try {
      const taskId = String(req.params.taskId || '').trim();
      if (!taskId) return res.status(400).json({ error: 'taskId is required' });

      const job = seedrJobs.get(taskId);
      const result = await getSeedrTaskStatus(taskId, job?.selectedNames || []);
      if (result.status === 'completed') seedrJobs.delete(taskId);
      return res.json(result);
    } catch (error: any) {
      console.error('[SEEDR] Status check failed:', error?.message || error);
      return res.status(Number(error?.status) || 502).json({
        error: error?.message || 'Seedr status request failed'
      });
    }
  });

  app.get('/api/seedr/quota', async (_req: Request, res: Response) => {
    try {
      if (!isSeedrConfigured()) {
        return res.json({
          configured: false,
          maxSpace: 0,
          usedSpace: 0,
          remainingSpace: 0,
        });
      }

      const quota = await getSeedrQuota();
      return res.json({
        configured: true,
        maxSpace: quota.maxSpace,
        usedSpace: quota.usedSpace,
        remainingSpace: quota.remainingSpace,
      });
    } catch (error: any) {
      console.error('[SEEDR] Quota request failed:', error?.message || error);
      return res.status(Number(error?.status) || 502).json({
        error: error?.message || 'Seedr quota request failed',
      });
    }
  });

  app.get('/api/seedr/files', async (_req: Request, res: Response) => {
    try {
      if (!isSeedrConfigured()) {
        return res.json({ configured: false, files: [] });
      }
      const files = await listSeedrLibrary();
      return res.json({ configured: true, files });
    } catch (error: any) {
      console.error('[SEEDR] Library listing failed:', error?.message || error);
      return res.status(Number(error?.status) || 502).json({
        error: error?.message || 'Seedr library request failed'
      });
    }
  });

  app.get('/api/seedr/files/stream', async (req: Request, res: Response) => {
    try {
      const type = String(req.query.type || '').toLowerCase();
      if (type !== 'video' && type !== 'audio') {
        return res.status(400).json({ error: 'type must be video or audio' });
      }
      if (!isSeedrConfigured()) return res.status(503).json({ error: 'Seedr is not configured' });

      const fileName = String(req.query.name || '').trim();
      if (!fileName) return res.status(400).json({ error: 'name is required' });

      const result = await getSeedrFilePresentation(fileName, type);
      const isHls = /\.m3u8(?:$|\?)/i.test(result.url);

      // Seedr's HLS host does not reliably expose the manifest/segments with
      // browser CORS headers. Return a same-origin proxy URL for HLS so hls.js
      // can load the manifest and every referenced playlist/segment through
      // Torrent Studio.
      const url = isHls
        ? `/api/seedr/hls/master.m3u8?url=${encodeURIComponent(result.url)}`
        : result.url;

      return res.json({ url, name: result.name });
    } catch (error: any) {
      console.error('[SEEDR] Stream URL failed:', error?.message || error);
      return res.status(Number(error?.status) || 502).json({
        error: error?.message || 'Seedr stream URL failed'
      });
    }
  });

  app.get('/api/seedr/hls/master.m3u8', async (req: Request, res: Response) => {
    try {
      const target = String(req.query.url || '').trim();
      if (!target) return res.status(400).send('url is required');

      const parsed = new URL(target);
      if (!parsed.hostname.endsWith('.seedr.cc') && parsed.hostname !== 'seedr.cc') {
        return res.status(400).send('Only Seedr stream URLs are allowed');
      }

      const upstream = await fetch(target, {
        headers: { Accept: '*/*' },
      });
      if (!upstream.ok) {
        return res.status(upstream.status).send(await upstream.text());
      }

      const contentType = upstream.headers.get('content-type') || '';
      const body = await upstream.text();

      if (!contentType.includes('mpegurl') && !/^#EXTM3U/m.test(body.trim())) {
        const binaryBody = await upstream.arrayBuffer();
        res.setHeader('Content-Type', contentType || 'application/octet-stream');
        const contentLength = upstream.headers.get('content-length');
        if (contentLength) res.setHeader('Content-Length', contentLength);
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Access-Control-Allow-Origin', '*');
        return res.send(Buffer.from(binaryBody));
      }

      const proxyBase = '/api/seedr/hls/master.m3u8?url=';
      const rewriteUrl = (value: string) => {
        try {
          const absolute = new URL(value, target).toString();
          const host = new URL(absolute).hostname;
          if (!host.endsWith('.seedr.cc') && host !== 'seedr.cc') return value;
          return proxyBase + encodeURIComponent(absolute);
        } catch {
          return value;
        }
      };

      const rewritten = body
        .split(/\r?\n/)
        .map(line => {
          const trimmed = line.trim();

          // URI="..." attributes (EXT-X-MEDIA, EXT-X-MAP, keys, etc.).
          if (trimmed.startsWith('#')) {
            return line.replace(/URI="([^"]+)"/g, (_match, uri) => `URI="${rewriteUrl(uri)}"`);
          }

          // Playlist/segment URL lines.
          return trimmed ? rewriteUrl(trimmed) : line;
        })
        .join('\n');

      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.send(rewritten);
    } catch (error: any) {
      console.error('[SEEDR] HLS manifest proxy failed:', error?.message || error);
      return res.status(502).send(error?.message || 'Seedr HLS manifest proxy failed');
    }
  });

  app.get('/api/seedr/folders/:folderId/download', async (req: Request, res: Response) => {
    try {
      const folderId = String(req.params.folderId || '').trim();
      if (!folderId) return res.status(400).json({ error: 'folderId is required' });
      if (!isSeedrConfigured()) return res.status(503).json({ error: 'Seedr is not configured' });

      const result = await getSeedrFolderDownload(folderId);
      return res.json(result);
    } catch (error: any) {
      console.error('[SEEDR] Folder download link failed:', error?.message || error);
      return res.status(Number(error?.status) || 502).json({
        error: error?.message || 'Seedr folder download failed'
      });
    }
  });

  app.delete('/api/seedr/folders/:folderId', async (req: Request, res: Response) => {
    try {
      const folderId = String(req.params.folderId || '').trim();
      if (!folderId) return res.status(400).json({ error: 'folderId is required' });
      if (!isSeedrConfigured()) return res.status(503).json({ error: 'Seedr is not configured' });

      await deleteSeedrFolder(folderId);
      return res.status(204).end();
    } catch (error: any) {
      console.error('[SEEDR] Folder delete failed:', error?.message || error);
      return res.status(Number(error?.status) || 502).json({
        error: error?.message || 'Seedr folder delete failed'
      });
    }
  });

  app.delete('/api/seedr/files/:fileId', async (req: Request, res: Response) => {
    try {
      const fileId = String(req.params.fileId || '').trim();
      if (!fileId) return res.status(400).json({ error: 'fileId is required' });
      if (!isSeedrConfigured()) return res.status(503).json({ error: 'Seedr is not configured' });

      await deleteSeedrFile(fileId);
      return res.status(204).end();
    } catch (error: any) {
      console.error('[SEEDR] File delete failed:', error?.message || error);
      return res.status(Number(error?.status) || 502).json({
        error: error?.message || 'Seedr file delete failed'
      });
    }
  });

  app.get('/api/seedr/files/:fileId/download', async (req: Request, res: Response) => {
    try {
      const fileId = String(req.params.fileId || '').trim();
      if (!fileId) return res.status(400).json({ error: 'fileId is required' });
      if (!isSeedrConfigured()) return res.status(503).json({ error: 'Seedr is not configured' });

      const result = await getSeedrFileDownload(fileId);
      return res.json(result);
    } catch (error: any) {
      console.error('[SEEDR] File download link failed:', error?.message || error);
      return res.status(Number(error?.status) || 502).json({
        error: error?.message || 'Seedr download link request failed'
      });
    }
  });

  app.use('/api/v2', async (req: Request, res: Response, next: NextFunction) => {
    const route = req.path;
    const method = req.method.toUpperCase();

    // These are the real qBittorrent-backed endpoints. Unknown /api/v2 routes
    // continue to the legacy handlers so the rest of the UI remains intact.
    const handled =
      route === '/app/version' ||
      route === '/app/webapiVersion' ||
      route === '/transfer/info' ||
      route === '/auth/login' ||
      route === '/auth/logout' ||
      route === '/torrents/info' ||
      route === '/torrents/files' ||
      route === '/torrents/export' ||
      route === '/torrents/add' ||
      route === '/torrents/upload-torrent' ||
      route === '/torrents/filePrio' ||
      route === '/torrents/pause' ||
      route === '/torrents/resume' ||
      route === '/torrents/delete' ||
      route === '/torrents/inspect-magnet' ||
      route === '/sync/maindata';

    if (!handled) return next();

    console.log(`[QBT-PROXY] ${method} ${route}`);

    try {
      if (route === '/app/version' && method === 'GET') {
        return res.send(String(await qbtJson('/api/v2/app/version')));
      }

      if (route === '/app/webapiVersion' && method === 'GET') {
        return res.send(String(await qbtJson('/api/v2/app/webapiVersion')));
      }

      if (route === '/auth/login' && method === 'POST') {
        // API-key and Basic-auth modes do not need a login request.
        requireConfig();
        return res.send('Ok.');
      }

      if (route === '/auth/logout' && method === 'POST') {
        return res.send('Ok.');
      }

      if (route === '/transfer/info' && method === 'GET') {
        return res.json(await qbtJson('/api/v2/transfer/info'));
      }

      if (route === '/torrents/info' && method === 'GET') {
        const upstream = new URL('/api/v2/torrents/info', config.baseUrl);
        for (const [key, value] of Object.entries(req.query)) {
          if (typeof value === 'string') upstream.searchParams.set(key, value);
        }
        const list = await qbtJson(upstream.pathname + upstream.search);
        const mapped = Array.isArray(list)
          ? list.map(mapTorrent).filter((torrent: any) => !isPreviewTorrentHash(torrent.hash))
          : [];
        for (const torrent of mapped) {
          if (!torrent.files.length) {
            try { torrent.files = await getFiles(torrent.hash); } catch { /* keep list usable */ }
          }
          torrent.selected_size = torrent.files
            .filter((f: any) => f.priority > 0)
            .reduce((sum: number, f: any) => sum + f.size, 0);
        }
        return res.json(mapped);
      }

      if (route === '/torrents/files' && method === 'GET') {
        const hash = String(req.query.hash || '');
        if (!hash) return res.status(400).json({ error: 'hash is required' });
        return res.json(await getFiles(hash));
      }

      if (route === '/torrents/export' && method === 'GET') {
        const hash = String(req.query.hash || '').trim().toLowerCase();
        if (!hash) return res.status(400).json({ error: 'hash is required' });

        const upstream = await qbtFetch('/api/v2/torrents/export?hash=' + encodeURIComponent(hash), {
          headers: { Accept: 'application/x-bittorrent, application/octet-stream, */*' }
        });

        if (!upstream.ok) {
          const body = await upstream.text();
          throw Object.assign(
            new Error(body || 'qBittorrent could not export this torrent'),
            { status: upstream.status }
          );
        }

        const data = Buffer.from(await upstream.arrayBuffer());
        if (!data.length) return res.status(502).send('qBittorrent returned an empty torrent file');

        res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/x-bittorrent');
        res.setHeader('Content-Disposition', `attachment; filename="${hash}.torrent"`);
        res.setHeader('Content-Length', String(data.length));
        return res.send(data);
      }

      if (route === '/torrents/inspect-magnet' && method === 'POST') {
        const source = String((req.body as any)?.magnet || '').trim();
        if (!source) return res.status(400).json({ error: 'No magnet provided' });

        const sourceHash = extractInfoHash(source);
        const isInternalSearchGrab = source.startsWith('/api/search/torrents/grab/');
        if (!sourceHash && !/^https?:\/\//i.test(source) && !isInternalSearchGrab) {
          return res.status(400).json({
            error: 'Please provide a valid magnet URI, 40-character torrent hash, or .torrent URL.'
          });
        }

        const category = String((req.body as any)?.category || 'Downloads');

        // The preview flow intentionally creates or reuses the torrent PAUSED.
        // That lets qBittorrent resolve metadata through its normal torrent
        // engine, while guaranteeing nothing starts before the user selects files.
        let hash = sourceHash;
        let createdPreview = false;
        if (hash && await torrentExists(hash)) {
          // This torrent already exists. Do not stop or reset an active
          // download just because background metadata is being refreshed.
        } else {
          const hashes = await addTorrentForMetadata(source, category);
          hash = hashes[0];
          createdPreview = true;
        }

        if (hash) rememberPreviewTorrent(source, hash);

        const files = await waitForTorrentFiles(hash, 10, 1000);
        let torrentName = 'Torrent';
        if (hash) {
          try {
            const info = await qbtJson('/api/v2/torrents/info?hash=' + encodeURIComponent(hash));
            torrentName = String(Array.isArray(info) ? info[0]?.name || 'Torrent' : 'Torrent');
          } catch {
            // File metadata is still useful even if the name lookup is unavailable.
          }
        }

        if (!files.length) {
          return res.status(202).json({
            name: torrentName,
            hash,
            files: [],
            totalSize: 0,
            source: 'qbt_torrent_pending',
            pending: true,
            createdPreview,
            message: 'qBittorrent is still obtaining torrent metadata in the background.'
          });
        }

        const mappedFiles = mapInspectFiles(files);
        return res.json({
          name: torrentName,
          hash,
          files: mappedFiles,
          totalSize: mappedFiles.reduce((sum: number, f: any) => sum + f.size, 0),
          source: 'qbt_torrent_files',
          createdPreview
        });
      }

      if (route === '/torrents/upload-torrent' && method === 'POST') {
        const base64 = String((req.body as any)?.base64 || '');
        const filename = String((req.body as any)?.filename || 'upload.torrent');
        if (!base64) return res.status(400).json({ error: 'No torrent file provided' });

        const buffer = Buffer.from(base64, 'base64');
        if (!buffer.length) return res.status(400).json({ error: 'Empty torrent file' });

        let decoded: any;
        try { decoded = bencode.decode(buffer); }
        catch { return res.status(400).json({ error: 'Invalid bencoded torrent file' }); }
        if (!decoded?.info) return res.status(400).json({ error: 'Invalid torrent file: missing info dictionary' });

        const infoEncoded = bencode.encode(decoded.info);
        const hash = crypto.createHash('sha1').update(infoEncoded).digest('hex');
        const name = decoded.info.name ? Buffer.from(decoded.info.name).toString('utf8') : filename.replace(/\.torrent$/i,'');
        const rawFiles = Array.isArray(decoded.info.files) ? decoded.info.files : [];
        const files = rawFiles.length
          ? rawFiles.map((f: any, index: number) => {
              const parts = Array.isArray(f.path) ? f.path.map((p:any)=>Buffer.from(p).toString('utf8')) : [Buffer.from(f.path || '').toString('utf8')];
              const fileName = parts.join('/');
              const lower = fileName.toLowerCase();
              const type = /\\.(mp4|mkv|m4v|webm|mov|avi)$/.test(lower) ? 'video' :
                /\\.(mp3|wav|flac|aac|ogg|m4a)$/.test(lower) ? 'audio' :
                /\\.(zip|rar|7z|tar|gz|iso)$/.test(lower) ? 'archive' :
                /\\.(pdf|txt|md|json|csv|srt|vtt)$/.test(lower) ? 'document' : 'other';
              return { index, name: fileName.split('/').pop() || fileName, size: Number(f.length || 0), path: fileName, type };
            })
          : [{ index: 0, name, size: Number(decoded.info.length || 0), path: name,
              type: /\\.(mp4|mkv|m4v|webm|mov|avi)$/i.test(name) ? 'video' :
                /\\.(mp3|wav|flac|aac|ogg|m4a)$/i.test(name) ? 'audio' :
                /\\.(zip|rar|7z|tar|gz|iso)$/i.test(name) ? 'archive' :
                /\\.(pdf|txt|md|json|csv|srt|vtt)$/i.test(name) ? 'document' : 'other' }];

        const trackerValues: string[] = [];
        const addTracker = (value: any) => {
          if (Buffer.isBuffer(value)) trackerValues.push(value.toString('utf8'));
          else if (typeof value === 'string') trackerValues.push(value);
        };
        addTracker(decoded.announce);
        if (Array.isArray(decoded['announce-list'])) {
          for (const tier of decoded['announce-list']) {
            if (Array.isArray(tier)) tier.forEach(addTracker);
            else addTracker(tier);
          }
        }
        const uniqueTrackers = [...new Set(trackerValues.filter(Boolean))];
        const magnetUri = `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(name)}${uniqueTrackers.map(t=>`&tr=${encodeURIComponent(t)}`).join('')}`;

        return res.json({
          name,
          hash,
          files,
          totalSize: files.reduce((sum: number, f: any) => sum + f.size, 0),
          magnetUri,
          accepted: false,
          source: 'torrent_file'
        });
      }

      if (route === '/seedr/quota' && method === 'GET') {
        if (!isSeedrConfigured()) {
          return res.json({ configured: false, maxSpace: 0, usedSpace: 0, remainingSpace: 0 });
        }
        const quota = await getSeedrQuota();
        return res.json({ configured: true, ...quota });
      }

      if (route === '/torrents/add' && method === 'POST') {
        const body = req.body as any;
        const forceBackend = String(body?.forceBackend || '').toLowerCase();
        const urls = String(body?.urls || '').trim();
        if (!urls) return res.status(400).send('No magnet link or URL provided');

        const selectedFiles = Array.isArray(body.selectedFiles) ? body.selectedFiles.map(Number) : [];
        const manifest = Array.isArray(body.manifest) ? body.manifest : [];

        // A magnet pasted directly into the Add Magnet dialog does not need
        // qBittorrent metadata inspection. Send it straight to Seedr and return
        // Seedr's original task response so the UI can show what Seedr accepted.
        if (forceBackend === 'seedr') {
          if (!isSeedrConfigured()) {
            return res.status(503).json({
              error: 'Seedr is not configured on the server.'
            });
          }

          const directMagnet = /^magnet:\?/i.test(urls)
            ? urls
            : (/^[a-f0-9]{40}$/i.test(urls)
              ? `magnet:?xt=urn:btih:${urls.toLowerCase()}`
              : '');

          if (!directMagnet) {
            return res.status(400).json({
              error: 'Direct Seedr mode requires a magnet link or 40-character torrent hash.'
            });
          }

          const infoHash = extractInfoHash(directMagnet);
          let seedrTask: any = infoHash ? await findSeedrTaskByHash(infoHash) : null;
          if (!seedrTask) {
            seedrTask = await addSeedrTask(directMagnet);
          }

          const seedrTaskId = seedrTask?.user_torrent_id ?? seedrTask?.id ?? null;
          console.log('[SEEDR-DIRECT] Seedr response:', JSON.stringify(seedrTask));

          return res.json({
            ok: true,
            backend: 'seedr',
            seedrTaskId,
            seedrResponse: seedrTask,
          });
        }

        // Selection is mandatory for metadata-driven qBittorrent flow and
        // hybrid Seedr flow that already has a manifest.
        if (!manifest.length || !selectedFiles.length) {
          return res.status(400).json({
            error: 'File selection is required. Select at least one file before starting the torrent.'
          });
        }

        const category = String(body.category || 'Downloads');
        const sourceHash = extractInfoHash(urls);
        const existingHash = String(body.existingHash || '').trim().toLowerCase();
        const rememberedHash = getPreviewTorrent(urls);

        // Basic hybrid routing: for a whole torrent at or below the configured
        // Seedr size limit, try Seedr first. If Seedr is unavailable, the token
        // is expired, or the account rejects the operation, transparently fall
        // back to the existing qBittorrent flow.
        const totalManifestSize = manifest.reduce((sum: number, item: any) => sum + Number(item?.size || 0), 0);
        const seedrEligible = forceBackend !== 'qbittorrent' && canUseSeedr(totalManifestSize);
        if (seedrEligible) {
          try {
            let quota: { maxSpace: number; usedSpace: number; remainingSpace: number } | null = null;
            try {
              quota = await getSeedrQuota();
            } catch (quotaError: any) {
              console.warn('[HYBRID] Could not read Seedr quota; will attempt Seedr directly:', quotaError?.message || quotaError);
            }

            if (quota && totalManifestSize > quota.remainingSpace) {
              return res.status(409).json({
                error: 'Seedr does not have enough free space for this torrent.',
                code: 'SEEDR_INSUFFICIENT_SPACE',
                requiredBytes: totalManifestSize,
                usedSpace: quota.usedSpace,
                maxSpace: quota.maxSpace,
                remainingSpace: quota.remainingSpace,
              });
            }
            const infoHash = (sourceHash || existingHash || '').toLowerCase();
            const seedrSource = /^magnet:\?/i.test(urls)
              ? urls
              : (infoHash ? `magnet:?xt=urn:btih:${infoHash}` : urls);

            // The qBittorrent preview is only a metadata helper. If the same
            // torrent already exists in qBittorrent, that must NOT force the
            // final download to qBittorrent. Seedr remains the preferred
            // backend when the torrent fits and Seedr has capacity.
            let seedrTask: any;
            if (infoHash) {
              seedrTask = await findSeedrTaskByHash(infoHash);
            }
            if (!seedrTask) {
              seedrTask = await addSeedrTask(seedrSource);
            }

            const previewHash = existingHash || rememberedHash || sourceHash;
            if (previewHash && await torrentExists(previewHash)) {
              await qbtJson('/api/v2/torrents/delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ hashes: previewHash, deleteFiles: 'false' }),
              });
            }
            for (const [source, entry] of previewTorrentHashes) {
              if (entry.hash === previewHash) previewTorrentHashes.delete(source);
            }
            const seedrTaskId = seedrTask?.user_torrent_id ?? seedrTask?.id ?? null;
            if (seedrTaskId != null) {
              seedrJobs.set(String(seedrTaskId), {
                selectedNames: manifest.filter((_item: any, index: number) => selectedFiles.includes(index)).map((item: any) => String(item?.name || '')),
                createdAt: Date.now(),
              });
            }
            console.log('[HYBRID] Seedr accepted torrent:', seedrTaskId ?? 'unknown');
            return res.json({
              ok: true,
              backend: 'seedr',
              seedrTaskId: seedrTaskId,
              maxSizeBytes: seedrMaxSizeBytes(),
            });
          } catch (seedrError: any) {
            console.warn('[HYBRID] Seedr unavailable; falling back to qBittorrent:', seedrError?.message || seedrError);
          }
        } else if (isSeedrConfigured() && forceBackend !== 'qbittorrent') {
          console.log('[HYBRID] Torrent exceeds Seedr limit; using qBittorrent.');
        }

        let hashes: string[] = [];

        const reuseHash = existingHash || rememberedHash || sourceHash;
        if (reuseHash && await torrentExists(reuseHash)) {
          // Reuse the existing torrent in place. Changing file priorities and
          // calling start below is enough; stopping it here causes an
          // unnecessary pause/stall when the user re-adds the same result.
          hashes = [reuseHash];
        } else {
          hashes = await addTorrentForMetadata(urls, category);
        }

        const selectedSet = new Set(selectedFiles.map(Number));
        const priorities = manifest.map((_item: any, index: number) =>
          selectedSet.has(index) ? 1 : 0
        );

        for (const hash of hashes) {
          let files: any[] = [];
          for (let attempt = 0; attempt < 60; attempt++) {
            try {
              files = await getFiles(hash);
              if (files.length >= manifest.length) break;
            } catch {
              // metadata is still resolving
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
          }

          if (files.length === 0) {
            return res.status(202).json({
              ok: true,
              hash,
              selectionPending: true,
              message: 'Torrent is still waiting for metadata. It remains paused and will not download files yet.'
            });
          }

          const idsToSkip = priorities
            .map((priority: number, index: number) => priority === 0 ? String(index) : '')
            .filter(Boolean)
            .join('|');

          const idsToDownload = priorities
            .map((priority: number, index: number) => priority > 0 ? String(index) : '')
            .filter(Boolean)
            .join('|');

          if (idsToSkip) {
            await qbtJson('/api/v2/torrents/filePrio', {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({ hash, id: idsToSkip, priority: '0' }),
            });
          }

          if (idsToDownload) {
            await qbtJson('/api/v2/torrents/filePrio', {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({ hash, id: idsToDownload, priority: '1' }),
            });
          }

          await qbtJson('/api/v2/torrents/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ hashes: hash }),
          });
        }

        for (const hash of hashes) {
          for (const [source, entry] of previewTorrentHashes) {
            if (entry.hash === hash) previewTorrentHashes.delete(source);
          }
        }

        return res.json({ ok: true, hashes });
      }

      if (route === '/torrents/filePrio' && method === 'POST') {
        const hash = String(req.body?.hash || req.query.hash || '');
        const id = String(req.body?.id || req.query.id || '');
        const priority = String(req.body?.priority ?? req.query.priority ?? '1');
        if (!hash || !id) return res.status(400).send('hash and id are required');
        await qbtJson('/api/v2/torrents/filePrio', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ hash, id, priority }),
        });
        return res.send('Ok.');
      }

      if (['/torrents/pause', '/torrents/resume', '/torrents/delete'].includes(route) && method === 'POST') {
        const hashes = String(req.body?.hashes || req.query.hashes || '');
        if (!hashes) return res.status(400).send('hashes is required');

        if (route === '/torrents/pause') {
          // qBittorrent 5.x renamed pause/resume to stop/start.
          await qbtJson('/api/v2/torrents/stop', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ hashes }),
          });
        } else if (route === '/torrents/resume') {
          await qbtJson('/api/v2/torrents/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ hashes }),
          });
        } else {
          const deleteFiles = String(req.body?.deleteFiles) === 'true';
          await qbtJson('/api/v2/torrents/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ hashes, deleteFiles: String(deleteFiles) }),
          });
        }
        return res.send('Ok.');
      }

      if (route === '/sync/maindata' && method === 'GET') {
        const upstream = new URL('/api/v2/sync/maindata', config.baseUrl);
        for (const [key, value] of Object.entries(req.query)) {
          if (typeof value === 'string') upstream.searchParams.set(key, value);
        }
        return res.json(await qbtJson(upstream.pathname + upstream.search));
      }

      return next();
    } catch (error) {
      sendError(res, error);
    }
  });
}
