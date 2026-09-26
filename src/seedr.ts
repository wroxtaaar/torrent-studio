import { randomUUID } from 'node:crypto';
const SEEDR_API_BASE = 'https://www.seedr.cc/api/v0.1/p';
const SEEDR_MAX_SIZE_BYTES = Number(process.env.SEEDR_MAX_SIZE_GB || 5) * 1024 * 1024 * 1024;

function getToken(): string {
  return String(process.env.SEEDR_API_TOKEN || '').trim();
}

export function isSeedrConfigured(): boolean {
  return Boolean(getToken());
}

export function canUseSeedr(totalSize: number): boolean {
  return isSeedrConfigured() &&
    Number.isFinite(totalSize) &&
    totalSize > 0 &&
    totalSize <= SEEDR_MAX_SIZE_BYTES;
}

async function seedrRequest(
  path: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET',
  body?: unknown
): Promise<any> {
  const token = getToken();
  if (!token) throw new Error('Seedr API token is not configured');

  // URL() treats a base path without a trailing slash as a file, and a
  // leading slash in the request path resets the URL to the domain root.
  // Seedr's API lives under /api/v0.1/p, so normalize both sides before
  // resolving the endpoint.
  const baseUrl = SEEDR_API_BASE.endsWith('/') ? SEEDR_API_BASE : SEEDR_API_BASE + '/';
  const requestPath = String(path).replace(/^\/+/, '');
  const response = await fetch(new URL(requestPath, baseUrl), {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  const text = await response.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }

  if (!response.ok) {
    const error = new Error(
      String(data?.error?.message ?? data?.error ?? data?.message ?? text ?? `Seedr API request failed (${response.status})`)
    );
    (error as any).status = response.status;
    throw error;
  }

  return data;
}

function unwrapData(value: any): any {
  if (value && typeof value === 'object' && value.data !== undefined) return value.data;
  return value;
}

function getAccessToken(): string {
  const token = getToken();
  if (!token) return '';

  try {
    const decoded = Buffer.from(token, 'base64').toString('utf8');
    const parsed = JSON.parse(decoded);
    if (parsed?.access_token) return String(parsed.access_token);
  } catch {
    // Raw access-token fallback.
  }

  return token;
}

async function legacySeedrRequest(
  func: string,
  data: Record<string, string> = {}
): Promise<any> {
  const accessToken = getAccessToken();
  if (!accessToken) throw new Error('Seedr API token is not configured');

  const url = new URL('https://www.seedr.cc/oauth_test/resource.php');
  url.searchParams.set('access_token', accessToken);
  url.searchParams.set('func', func);

  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(data)) form.set(key, value);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form,
  });

  const text = await response.text();
  let result: any = null;
  try { result = text ? JSON.parse(text) : null; } catch { result = text; }

  if (!response.ok) {
    const message = result?.error || result?.message || text || response.statusText || 'Seedr API request failed';
    throw Object.assign(new Error(String(message)), { status: response.status });
  }

  if (result?.error && result.error !== '0') {
    throw Object.assign(new Error(String(result.error)), { status: 502 });
  }

  return result;
}

async function legacyListSeedrFolder(folderId: string | number = '0'): Promise<any> {
  return legacySeedrRequest('list_contents', {
    content_type: 'folder',
    content_id: String(folderId),
  });
}

function asArray(value: any, keys: string[] = []): any[] {
  if (Array.isArray(value)) return value;
  const data = unwrapData(value);
  if (Array.isArray(data)) return data;
  for (const key of keys) {
    if (Array.isArray(data?.[key])) return data[key];
    if (Array.isArray(data?.data?.[key])) return data.data[key];
    if (Array.isArray(data?.contents?.[key])) return data.contents[key];
    if (Array.isArray(data?.data?.contents?.[key])) return data.data.contents[key];
  }
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.data?.items)) return data.data.items;
  if (Array.isArray(data?.contents)) return data.contents;
  if (Array.isArray(data?.data?.contents)) return data.data.contents;
  return [];
}

function numericId(value: any): string {
  return String(value ?? '');
}

function normalizeFile(file: any, folderId = ''): any {
  return {
    id: numericId(file?.id ?? file?.file_id ?? file?.folder_file_id),
    name: String(file?.name ?? file?.filename ?? ''),
    size: Number(file?.size ?? file?.length ?? 0),
    folderId: numericId(file?.folder_id ?? file?.folderId ?? folderId),
  };
}

function normalizeFolder(folder: any): any {
  return {
    id: numericId(folder?.id ?? folder?.folder_id),
    name: String(folder?.name ?? folder?.title ?? folder?.path ?? 'Folder'),
  };
}

function extractFiles(payload: any, folderId = ''): any[] {
  const data = unwrapData(payload);
  return asArray(data, ['files', 'items']).map(file => normalizeFile(file, folderId));
}

function extractFolders(payload: any): any[] {
  const data = unwrapData(payload);
  return asArray(data, ['folders', 'directories']).map(normalizeFolder);
}

function normalizeTaskPayload(task: any): any {
  const data = unwrapData(task);
  return data?.task ?? data;
}

function extractProgressValue(value: any, depth = 0): number | null {
  if (value == null || depth > 5) return null;

  if (typeof value === 'number' || (typeof value === 'string' && /^\s*-?\d+(?:\.\d+)?\s*$/.test(value))) {
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    return number >= 0 && number <= 1 ? number * 100 : number;
  }

  if (typeof value !== 'object') return null;

  const direct = [
    value.progress,
    value.percent,
    value.percentage,
    value.progress_percent,
    value.progressPercentage,
    value.downloaded_percent,
    value.downloadedPercent,
    value.completed_percent,
    value.completedPercent,
  ];

  for (const candidate of direct) {
    const number = extractProgressValue(candidate, depth + 1);
    if (number != null) return number;
  }

  const downloaded = Number(value.downloaded ?? value.downloaded_bytes ?? value.bytes_downloaded);
  const size = Number(value.size ?? value.total_size ?? value.total_bytes);
  if (Number.isFinite(downloaded) && downloaded >= 0 && Number.isFinite(size) && size > 0) {
    return (downloaded / size) * 100;
  }

  for (const [key, child] of Object.entries(value)) {
    if (/progress|percent|downloaded/i.test(key)) {
      const number = extractProgressValue(child, depth + 1);
      if (number != null) return number;
    }
  }

  return null;
}

function taskProgress(task: any): number {
  const value = extractProgressValue(task?.progress ?? task?.task?.progress ?? task?.torrent?.progress);
  return value == null ? 0 : Math.max(0, Math.min(100, value));
}

function taskIsComplete(task: any): boolean {
  const state = String(task?.state ?? task?.status ?? task?.task?.state ?? task?.task?.status ?? '').toLowerCase();
  return state === 'finished' || state === 'completed' || state === 'complete' || taskProgress(task) >= 100;
}

function getStatus(error: unknown): number {
  return Number((error as any)?.status || 0);
}

async function getTask(taskId: string | number): Promise<any> {
  return seedrRequest(`/tasks/${encodeURIComponent(String(taskId))}`);
}

async function getTaskContents(taskId: string | number): Promise<any> {
  return seedrRequest(`/tasks/${encodeURIComponent(String(taskId))}/contents`);
}

async function getTaskProgress(taskId: string | number): Promise<any> {
  return seedrRequest(`/tasks/${encodeURIComponent(String(taskId))}/progress`);
}

export type SeedrQuota = {
  maxSpace: number;
  usedSpace: number;
  remainingSpace: number;
};

function findQuotaValues(value: any, depth = 0): { maxSpace: number; usedSpace: number } | null {
  if (!value || depth > 6 || typeof value !== 'object') return null;

  const maxSpace = Number(value?.max_space ?? value?.maxSpace ?? value?.storage?.max ?? value?.quota?.max_space ?? 0);
  const usedSpace = Number(value?.used_space ?? value?.usedSpace ?? value?.storage?.used ?? value?.quota?.used_space ?? 0);

  if (maxSpace > 0 && usedSpace >= 0 && usedSpace <= maxSpace) {
    return { maxSpace, usedSpace };
  }

  for (const child of Object.values(value)) {
    const found = findQuotaValues(child, depth + 1);
    if (found) return found;
  }

  return null;
}

export async function getSeedrQuota(): Promise<SeedrQuota> {
  // /me/quota and the /fs/root* endpoints are not available on this
  // free-tier account. The documented /user endpoint is available and
  // returns the account storage values directly.
  const result = unwrapData(await seedrRequest('/user'));
  const storage = result?.account?.storage ?? result?.storage ?? {};

  const maxSpace = Number(
    storage?.limit ??
    storage?.max_space ??
    storage?.maxSpace ??
    result?.max_space ??
    result?.space_max ??
    0
  );
  const usedSpace = Number(
    storage?.used ??
    storage?.used_space ??
    storage?.usedSpace ??
    result?.used_space ??
    result?.space_used ??
    0
  );

  if (!(maxSpace > 0) || usedSpace < 0 || usedSpace > maxSpace) {
    throw new Error('Seedr quota information is temporarily unavailable');
  }

  return {
    maxSpace,
    usedSpace,
    remainingSpace: Math.max(0, maxSpace - usedSpace),
  };
}

const SEEDR_LIBRARY_FOLDER_ID = String(process.env.SEEDR_LIBRARY_FOLDER_ID || '').trim();

export async function addSeedrTask(magnet: string): Promise<any> {
  if (!SEEDR_LIBRARY_FOLDER_ID || !/^\d+$/.test(SEEDR_LIBRARY_FOLDER_ID)) {
    throw new Error('SEEDR_LIBRARY_FOLDER_ID must be configured for Torrent Studio Seedr downloads');
  }

  return seedrRequest('/tasks', 'POST', {
    torrent_magnet: magnet,
    folder_id: Number(SEEDR_LIBRARY_FOLDER_ID),
  });
}

export async function deleteSeedrTask(taskId: string | number): Promise<any> {
  return seedrRequest(`/tasks/${encodeURIComponent(String(taskId))}`, 'DELETE');
}

function unwantedBitmap(fileCount: number, unwantedIndexes: number[], msbFirst = false): string {
  const bytes = Buffer.alloc(Math.ceil(Math.max(0, fileCount) / 8));
  for (const rawIndex of unwantedIndexes) {
    const index = Number(rawIndex);
    if (!Number.isInteger(index) || index < 0 || index >= fileCount) continue;
    const byteIndex = Math.floor(index / 8);
    const bitIndex = index % 8;
    bytes[byteIndex] |= 1 << (msbFirst ? 7 - bitIndex : bitIndex);
  }
  return bytes.toString('base64');
}

function decodeUnwantedBitmap(value: any, fileCount: number, msbFirst = false): number[] {
  const encoded = typeof value === 'string' ? value : value?.unwanted;
  if (!encoded) return [];
  let bytes: Buffer;
  try {
    bytes = Buffer.from(String(encoded), 'base64');
  } catch {
    return [];
  }

  const unwanted: number[] = [];
  for (let index = 0; index < fileCount; index++) {
    const byteIndex = Math.floor(index / 8);
    const bitIndex = index % 8;
    const mask = 1 << (msbFirst ? 7 - bitIndex : bitIndex);
    if ((bytes[byteIndex] & mask) !== 0) unwanted.push(index);
  }
  return unwanted;
}

async function getSeedrUnwanted(taskId: string | number): Promise<any> {
  return seedrRequest(`/tasks/${encodeURIComponent(String(taskId))}/unwanted`);
}

export async function setSeedrUnwanted(
  taskId: string | number,
  fileCount: number,
  unwantedIndexes: number[]
): Promise<any> {
  const wanted = new Set(unwantedIndexes.map(Number));
  const requested = unwantedIndexes.filter(index => Number.isInteger(Number(index)));
  const sendAndVerify = async (msbFirst: boolean) => {
    const bitmap = unwantedBitmap(fileCount, requested, msbFirst);
    await seedrRequest(
      `/tasks/${encodeURIComponent(String(taskId))}/unwanted`,
      'POST',
      { unwanted: bitmap }
    );

    try {
      const current = await getSeedrUnwanted(taskId);
      const data = unwrapData(current);
      const encoded = typeof data === 'string' ? data : data?.unwanted;
      if (!encoded) return false;
      const actual = decodeUnwantedBitmap(encoded, fileCount, msbFirst);
      return actual.length === wanted.size && actual.every(index => wanted.has(index));
    } catch {
      // Do not resume when the server cannot confirm the unwanted bitmap.
      return false;
    }
  };

  if (await sendAndVerify(false)) return { ok: true, unwanted: requested };
  if (await sendAndVerify(true)) return { ok: true, unwanted: requested };

  throw new Error('Seedr did not preserve the requested file selection');
}

export async function pauseSeedrTask(taskId: string | number): Promise<any> {
  return seedrRequest(`/tasks/${encodeURIComponent(String(taskId))}/pause`, 'POST');
}

export async function resumeSeedrTask(taskId: string | number): Promise<any> {
  return seedrRequest(`/tasks/${encodeURIComponent(String(taskId))}/resume`, 'POST');
}

export async function getSeedrTaskSelection(taskId: string | number): Promise<{
  task: any;
  files: Array<{ id: string; name: string; size: number }>;
}> {
  const taskIdValue = numericId(taskId);
  const task = normalizeTaskPayload(await getTask(taskIdValue));
  let rawFiles: any[] = [];
  try {
    rawFiles = await taskFiles(taskIdValue);
  } catch {
    rawFiles = [];
  }

  const files = rawFiles
    .filter(file => file?.id != null)
    .map(file => ({
      id: String(file.id),
      name: String(file.name ?? file.path ?? 'Unknown file'),
      size: Number(file.size ?? file.length ?? 0),
    }));

  return { task, files };
}

export async function listSeedrTasks(): Promise<any[]> {
  const data = await seedrRequest('/tasks');
  return asArray(data, ['tasks', 'torrents']);
}

export async function findSeedrTaskByHash(infoHash: string): Promise<any | null> {
  const target = String(infoHash || '').trim().toLowerCase();
  if (!target) return null;

  const tasks = await listSeedrTasks();
  for (const raw of tasks) {
    const task = normalizeTaskPayload(raw);
    const hash = String(
      task?.torrent_payload?.hash ??
      task?.torrent_hash ??
      task?.hash ??
      task?.info_hash ??
      ''
    ).toLowerCase();

    if (hash && hash === target) return task;
  }

  return null;
}

async function getFolderContents(folderId: string | number): Promise<any> {
  return seedrRequest(`/fs/folder/${encodeURIComponent(String(folderId))}/contents`);
}

async function getFileDetails(fileId: string | number): Promise<any> {
  return seedrRequest(`/fs/file/${encodeURIComponent(String(fileId))}`);
}

async function getDownloadUrl(fileId: string | number): Promise<{ url: string; name: string }> {
  const result = await seedrRequest(
    `/download/file/${encodeURIComponent(String(fileId))}/url`
  );

  const data = unwrapData(result);

  const url = String(
    data?.url ??
    data?.download_url ??
    data?.downloadUrl ??
    data?.direct_url ??
    data?.directUrl ??
    (typeof result === 'string' ? result : '')
  );

  if (!url) throw new Error('Seedr did not return a download URL');

  return {
    url,
    name: String(data?.name ?? data?.filename ?? ''),
  };
}

async function collectSeedrFiles(
  folderId: string | number = '0',
  folderPath = '/',
  depth = 0
): Promise<SeedrLibraryFile[]> {
  if (depth > 8) return [];

  let payload: any;
  try {
    payload = await getFolderContents(folderId);
  } catch (error) {
    // Seedr keeps completed tasks in /tasks even after their created
    // folder has been deleted. Treat a missing folder as an empty library
    // branch instead of surfacing a noisy 404 to the user.
    if (getStatus(error) === 404) {
      console.warn('[SEEDR] Library folder no longer exists; skipping:', String(folderId));
      return [];
    }
    throw error;
  }

  const files = extractFiles(payload, String(folderId)).map(file => ({
    id: file.id,
    name: file.name,
    size: file.size,
    folderId: file.folderId,
    folderPath,
  }));

  const nested = await Promise.all(
    extractFolders(payload)
      .filter(folder => Boolean(folder.id))
      .map(folder => {
        const childPath =
          folderPath === '/'
            ? '/' + folder.name
            : folderPath + '/' + folder.name;

        return collectSeedrFiles(folder.id, childPath, depth + 1);
      })
  );

  return [...files, ...nested.flat()];
}

function fileNameOnly(name: string): string {
  return String(name).split('/').pop()?.toLowerCase() || '';
}

async function taskFiles(taskId: string | number): Promise<any[]> {
  const payload = await getTaskContents(taskId);
  return extractFiles(payload);
}

async function fetchTaskProgress(taskId: string | number, task: any): Promise<{ progress: number; task: any }> {
  const direct = taskProgress(task);
  if (direct > 0 || taskIsComplete(task)) {
    return { progress: direct, task };
  }

  try {
    const progressResult = await getTaskProgress(taskId);
    const progressData = unwrapData(progressResult);
    const progressUrl = String(
      progressData?.url ??
      progressData?.progress_url ??
      progressData?.progressUrl ??
      ''
    );

    if (progressUrl) {
      const url = new URL(progressUrl, SEEDR_API_BASE);
      // Seedr's progress URL is a signed legacy subnode endpoint and commonly
      // returns JSONP because the URL contains callback=?. Do not require the
      // API Bearer token on the subnode host; parse both JSON and JSONP.
      if (url.searchParams.get('callback') === '?') {
        url.searchParams.set('callback', 'seedflowProgress');
      }

      const response = await fetch(url, {
        headers: {
          Accept: 'application/json, text/plain, */*',
        },
      });

      if (response.ok) {
        const text = await response.text();
        let data: any = null;

        try {
          data = text ? JSON.parse(text) : null;
        } catch {
          const start = text.indexOf('{');
          const end = text.lastIndexOf('}');
          if (start >= 0 && end > start) {
            try {
              data = JSON.parse(text.slice(start, end + 1));
            } catch {
              data = null;
            }
          }
        }

        const mergedTask = data ? { ...task, ...unwrapData(data) } : task;
        const progress = taskProgress(mergedTask);

        return {
          progress,
          task: mergedTask,
        };
      }
    }

    return {
      progress: taskProgress(progressData),
      task: { ...task, ...progressData },
    };
  } catch {
    return { progress: direct, task };
  }
}

export async function getSeedrTaskStatus(
  taskId: string | number,
  selectedNames: string[] = []
): Promise<any> {
  const id = numericId(taskId);

  let task: any;
  try {
    task = await getTask(id);
  } catch (error) {
    const status = getStatus(error);

    if (status === 404) {
      // The task no longer exists in Seedr. Do NOT report it as "waiting":
      // the frontend would keep polling forever and resurrect stale state.
      return {
        taskId,
        name: '',
        status: 'not_found',
        progress: 0,
        task: null,
        files: [],
        downloadUrl: null,
      };
    }

    throw error;
  }

  task = normalizeTaskPayload(task);
  const progressResult = await fetchTaskProgress(id, task);
  task = normalizeTaskPayload(progressResult.task);
  const progress = progressResult.progress;
  const complete = taskIsComplete(task);

  if (!complete) {
    return {
      taskId,
      name: String(task?.name ?? task?.title ?? task?.torrent_name ?? ''),
      status: 'downloading',
      progress,
      task,
      files: [],
      downloadUrl: null,
    };
  }

  let candidates: any[] = [];
  try {
    candidates = await taskFiles(id);
  } catch (error) {
    // A newly-finished Seedr task can briefly report its terminal state before
    // its files are exposed through /tasks/:id/contents. Keep it in progress
    // until the files actually exist, instead of falsely reporting "downloaded".
    if (getStatus(error) === 404) {
      return {
        taskId,
        name: String(task?.name ?? task?.title ?? task?.torrent_name ?? ''),
        status: 'downloading',
        progress: Math.min(progress, 99.9),
        task,
        files: [],
        downloadUrl: null,
      };
    }
    throw error;
  }

  if (!candidates.length) {
    return {
      taskId,
      name: String(task?.name ?? task?.title ?? task?.torrent_name ?? ''),
      status: 'downloading',
      progress: Math.min(progress, 99.9),
      task,
      files: [],
      downloadUrl: null,
    };
  }

  const normalizedSelected = selectedNames
    .map(fileNameOnly)
    .filter(Boolean);

  if (normalizedSelected.length) {
    const matchedFiles = candidates.filter(file =>
      normalizedSelected.includes(fileNameOnly(file.name))
    );

    if (matchedFiles.length) candidates = matchedFiles;
  }

  const files = [];

  for (const file of candidates.slice(0, 50)) {
    if (!file.id) continue;

    try {
      const details = await getFileDetails(file.id);
      const download = await getDownloadUrl(file.id);

      files.push({
        id: file.id,
        name: String(details?.name ?? details?.filename ?? file.name),
        size: Number(details?.size ?? details?.length ?? file.size ?? 0),
        url: download.url,
      });
    } catch {
      files.push({
        id: file.id,
        name: file.name,
        size: file.size,
        url: null,
      });
    }
  }

  return {
    taskId,
    name: String(task?.name ?? task?.title ?? task?.torrent_name ?? ''),
    status: 'completed',
    progress: 100,
    task,
    files,
    downloadUrl: files.find(file => file.url)?.url ?? null,
  };
}

export type SeedrLibraryFile = {
  id: string;
  name: string;
  size: number;
  folderId: string;
  folderPath: string;
};

const SEEDR_FOLDER_PATH_CACHE_TTL_MS = 10 * 60 * 1000;
const seedrFolderPathCache = new Map<string, { path: string; expiresAt: number }>();

async function getSeedrFolderPath(folderId: string): Promise<string> {
  const cached = seedrFolderPathCache.get(folderId);
  if (cached && cached.expiresAt > Date.now()) return cached.path;

  try {
    const result = unwrapData(await seedrRequest(`/fs/folder/${encodeURIComponent(folderId)}`));
    const path = String(result?.path ?? '').trim();

    if (path) {
      seedrFolderPathCache.set(folderId, {
        path,
        expiresAt: Date.now() + SEEDR_FOLDER_PATH_CACHE_TTL_MS,
      });
      return path;
    }
  } catch {
    // Folder metadata is supplementary. The file index is still usable
    // when a free-tier request is rate-limited or otherwise unavailable.
  }

  return `/Seedr Folder ${folderId}`;
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex++;
      if (index >= values.length) return;
      results[index] = await mapper(values[index]);
    }
  }

  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), values.length || 1) },
    () => worker()
  );

  await Promise.all(workers);
  return results;
}

export async function listSeedrLibrary(): Promise<SeedrLibraryFile[]> {
  // /search/fs is account-wide, so it must not be used as the library source.
  // Seedr tasks tell us exactly which downloads belong to Torrent Studio:
  // each task is stored under folder_id and may have a folder_created_id
  // containing the completed files. Follow those task-created folders instead
  // of exposing unrelated files from the rest of the Seedr account.
  if (!SEEDR_LIBRARY_FOLDER_ID || !/^\d+$/.test(SEEDR_LIBRARY_FOLDER_ID)) {
    console.warn('[SEEDR] SEEDR_LIBRARY_FOLDER_ID is not configured; library listing is disabled to avoid exposing unrelated account files.');
    return [];
  }

  const tasks = await listSeedrTasks();
  const torrentTasks = tasks
    .map(normalizeTaskPayload)
    .filter(task => String(task?.type ?? 'torrent').toLowerCase() === 'torrent')
    .filter(task => String(task?.folder_id ?? '') === SEEDR_LIBRARY_FOLDER_ID)
    .filter(task => taskIsComplete(task));

  const folderIds = [...new Set(
    torrentTasks
      .map(task => numericId(task?.folder_created_id))
      .filter(Boolean)
  )];

  // Read the configured Torrent Studio parent folder as well as task-created
  // folders. Seedr can expose completed files in either location.
  const folderSources = [SEEDR_LIBRARY_FOLDER_ID, ...folderIds];

  const results = await mapWithConcurrency(
    [...new Set(folderSources)],
    4,
    folderId => collectSeedrFiles(folderId, '/Torrent Studio')
  );

  const seen = new Set<string>();
  return results.flat().filter(file => {
    const key = file.id || `${file.folderId}:${file.folderPath}:${file.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function getSeedrFileDownload(fileId: string | number): Promise<{ url: string; name: string }> {
  return getDownloadUrl(fileId);
}

type SeedrSearchFile = {
  id: string;
  name: string;
  size: number;
  folderId: string;
  presentationUrls: any;
};

async function searchSeedrFiles(query: string): Promise<SeedrSearchFile[]> {
  const result = await seedrRequest(`/search/fs?query=${encodeURIComponent(query)}`);
  const data = unwrapData(result);
  const files = Array.isArray(data?.files) ? data.files : [];

  return files.map((file: any) => ({
    id: numericId(file?.id ?? file?.file_id ?? file?.folder_file_id),
    name: String(file?.name ?? file?.filename ?? ''),
    size: Number(file?.size ?? file?.length ?? 0),
    folderId: numericId(file?.folder_id ?? file?.folderId),
    presentationUrls: file?.presentation_urls ?? file?.presentationUrls ?? {},
  }));
}

function seedrSearchTerms(fileName: string): string[] {
  const clean = String(fileName).trim();
  const withoutExtension = clean.replace(/\.[^.]+$/, '');
  const terms = [
    clean,
    withoutExtension,
    withoutExtension.split(/[-_.\s]+/).slice(0, 8).join(' '),
    withoutExtension.split(/[-_.\s]+/).slice(0, 4).join(' '),
  ].map(value => value.trim()).filter(Boolean);

  return [...new Set(terms)];
}

async function findSeedrFile(fileName: string): Promise<SeedrSearchFile> {
  const target = fileNameOnly(fileName);
  let lastError: unknown = null;

  for (const term of seedrSearchTerms(fileName)) {
    try {
      const files = await searchSeedrFiles(term);
      const exact = files.find(file => fileNameOnly(file.name) === target);
      if (exact?.id) return exact;

      const sameStem = files.find(file => fileNameOnly(file.name).replace(/\.[^.]+$/, '') === target.replace(/\.[^.]+$/, ''));
      if (sameStem?.id) return sameStem;

      const partial = files.find(file => file.name.toLowerCase().includes(String(fileName).toLowerCase().slice(0, 20)));
      if (partial?.id) return partial;
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError instanceof Error) throw lastError;
  throw new Error(`Seedr file not found: ${fileName}`);
}

export async function getSeedrFilePresentation(
  fileName: string,
  presentationType: 'video' | 'audio'
): Promise<{ url: string; name: string }> {
  const file = await findSeedrFile(fileName);
  const urls = file.presentationUrls || {};

  const url = String(
    presentationType === 'video'
      ? (urls?.video?.hls ?? urls?.video?.url ?? urls?.video?.stream)
      : (urls?.audio?.hls ?? urls?.audio?.url ?? urls?.audio?.stream)
  );

  if (!url) {
    throw new Error(`Seedr did not return a ${presentationType} playback URL for "${file.name}"`);
  }

  return { url, name: file.name };
}

export async function deleteSeedrFile(fileId: string | number): Promise<void> {
  await seedrRequest(`/fs/file/${encodeURIComponent(String(fileId))}`, 'DELETE');
}

export async function deleteSeedrFolder(folderId: string | number): Promise<void> {
  await seedrRequest(`/fs/folder/${encodeURIComponent(String(folderId))}`, 'DELETE');
}

export async function getSeedrFolderDownload(folderId: string | number): Promise<{ url: string }> {
  const archiveId = randomUUID();
  const result = await seedrRequest(
    `/download/archive/init/${archiveId}`,
    'PUT',
    { archive_arr: [{ type: 'folder', id: Number(folderId) }] }
  );
  const data = unwrapData(result);
  const url = String(
    data?.url ??
    data?.download_url ??
    data?.downloadUrl ??
    data?.signed_url ??
    data?.signedUrl ??
    (typeof result === 'string' ? result : '')
  );

  if (!url) throw new Error('Seedr did not return a folder download URL');
  return { url };
}

export function seedrMaxSizeBytes(): number {
  return SEEDR_MAX_SIZE_BYTES;
}
