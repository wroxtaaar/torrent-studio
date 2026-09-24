import bencode from 'bencode';
import crypto from 'crypto';
import type { Express, Request, Response, NextFunction } from 'express';

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

function authHeaders(): Record<string, string> {
  if (config.apiKey) return { Authorization: `Bearer ${config.apiKey}` };
  if (config.username && config.password) {
    return {
      Authorization: 'Basic ' + Buffer.from(`${config.username}:${config.password}`).toString('base64'),
    };
  }
  return {};
}

function requireConfig() {
  if (!config.baseUrl) throw new Error('QBT_URL is not configured');
  if (!config.apiKey && (!config.username || !config.password)) {
    throw new Error('Set QBT_API_KEY or QBT_USERNAME and QBT_PASSWORD');
  }
}

async function qbtFetch(pathname: string, init: RequestInit = {}): Promise<Response> {
  requireConfig();

  const headers = new Headers(init.headers);
  for (const [key, value] of Object.entries(authHeaders())) headers.set(key, value);
  headers.set('Accept', headers.get('Accept') || 'application/json');
  headers.set('Referer', config.baseUrl + '/');

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
    uploading: 'uploading',
    stalledUP: 'uploading',
    pausedUP: 'completed',
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
  // qBittorrent 5.2+ can fetch metadata without adding the torrent.
  for (let i = 0; i < 8; i++) {
    const params = new URLSearchParams({ source });
    const response = await qbtFetch('/api/v2/torrents/fetchMetadata', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    });
    const text = await response.text();
    if (!response.ok) throw Object.assign(new Error(text || response.statusText), { status: response.status });
    if (text) {
      try {
        const data = JSON.parse(text);
        if (data && (data.name || Array.isArray(data.files))) return data;
      } catch {
        // Metadata is not ready yet.
      }
    }
    await new Promise(resolve => setTimeout(resolve, 750));
  }
  return null;
}

export function installQbtProxy(app: Express) {
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
        const mapped = Array.isArray(list) ? list.map(mapTorrent) : [];
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

      if (route === '/torrents/inspect-magnet' && method === 'POST') {
        const magnet = String((req.body as any)?.magnet || '').trim();
        if (!magnet) return res.status(400).json({ error: 'No magnet provided' });
        const metadata = await inspectMetadata(magnet);
        if (!metadata) {
          return res.status(202).json({
            name: new URLSearchParams(magnet.split('?')[1] || '').get('dn') || 'Torrent',
            hash: (magnet.match(/urn:btih:([a-zA-Z0-9]+)/i)?.[1] || '').toLowerCase(),
            files: [],
            totalSize: 0,
            source: 'qbt_metadata_pending'
          });
        }
        const rawFiles = Array.isArray(metadata.files) ? metadata.files : [];
        const files = rawFiles.map((f: any, index: number) => ({
          index: Number(f.index ?? index),
          name: f.name || f.path || `File_${index + 1}`,
          size: Number(f.size ?? f.length ?? 0),
          path: f.path || f.name || '',
          type: String(f.name || f.path || '').toLowerCase().endsWith('.mp4') ? 'video' :
            String(f.name || f.path || '').toLowerCase().endsWith('.mkv') ? 'video' :
            String(f.name || f.path || '').toLowerCase().endsWith('.mp3') ? 'audio' :
            String(f.name || f.path || '').toLowerCase().endsWith('.flac') ? 'audio' : 'other',
        }));
        return res.json({
          name: metadata.name || 'Torrent',
          hash: String(metadata.infohash || metadata.hash || '').toLowerCase(),
          files,
          totalSize: files.reduce((sum: number, f: any) => sum + f.size, 0),
          source: 'qbt_metadata'
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
              return { index, name: fileName.split('/').pop() || fileName, size: Number(f.length || 0), path: fileName, type: 'other' };
            })
          : [{ index: 0, name, size: Number(decoded.info.length || 0), path: name, type: 'other' }];

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

      if (route === '/torrents/add' && method === 'POST') {
        const body = req.body as any;
        const urls = String(body?.urls || '').trim();
        if (!urls) return res.status(400).send('No magnet link or URL provided');

        const selectedFiles = Array.isArray(body.selectedFiles) ? body.selectedFiles.map(Number) : undefined;
        const manifest = Array.isArray(body.manifest) ? body.manifest : undefined;
        const category = String(body.category || 'Downloads');

        const form = new URLSearchParams();
        form.set('urls', urls);
        if (category) form.set('category', category);
        form.set('savepath', '/downloads');

        // qBittorrent 5.2.x supports filePriorities at add time. This avoids
        // starting the wrong files while metadata is being resolved.
        if (selectedFiles && manifest?.length) {
          const selectedSet = new Set(selectedFiles);
          const priorities = manifest.map((_item: any, index: number) =>
            selectedSet.has(index) ? '1' : '0'
          );
          form.set('filePriorities', priorities.join(','));
        }

        const upstream = await qbtJson('/api/v2/torrents/add', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: form,
        });

        console.log('[QBT-PROXY] add response:', upstream);
        return res.send(typeof upstream === 'string' ? upstream : 'Ok.');
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
          await qbtJson('/api/v2/torrents/pause', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ hashes }),
          });
        } else if (route === '/torrents/resume') {
          await qbtJson('/api/v2/torrents/resume', {
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
