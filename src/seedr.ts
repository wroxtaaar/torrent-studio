const SEEDR_RESOURCE_URL = 'https://www.seedr.cc/oauth_test/resource.php';
const SEEDR_MAX_SIZE_BYTES = Number(process.env.SEEDR_MAX_SIZE_GB || 5) * 1024 * 1024 * 1024;

function getToken(): string {
  return String(process.env.SEEDR_API_TOKEN || '').trim();
}

function getAccessToken(): string {
  const token = getToken();
  if (!token) return '';

  // Seedr PATs used by the OAuth API are encoded token payloads. Keep a
  // fallback to the raw value so older token formats remain usable.
  try {
    const decoded = Buffer.from(token, 'base64').toString('utf8');
    const parsed = JSON.parse(decoded);
    if (parsed?.access_token) return String(parsed.access_token);
  } catch {
    // Raw access token fallback.
  }

  return token;
}

export function isSeedrConfigured(): boolean {
  return Boolean(getAccessToken());
}

export function canUseSeedr(totalSize: number): boolean {
  return isSeedrConfigured() && Number.isFinite(totalSize) && totalSize > 0 && totalSize <= SEEDR_MAX_SIZE_BYTES;
}

async function seedrRequest(func: string, method: 'GET' | 'POST' = 'GET', data?: Record<string, string>): Promise<any> {
  const accessToken = getAccessToken();
  if (!accessToken) throw new Error('Seedr API token is not configured');

  const url = new URL(SEEDR_RESOURCE_URL);
  url.searchParams.set('access_token', accessToken);
  url.searchParams.set('func', func);

  const init: RequestInit = {
    method,
    headers: { Accept: 'application/json' },
  };

  if (method === 'POST') {
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(data || {})) form.set(key, value);
    init.headers = {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    };
    init.body = form;
  }

  const response = await fetch(url, init);
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

export async function addSeedrTask(magnet: string): Promise<any> {
  return seedrRequest('add_torrent', 'POST', {
    torrent_magnet: magnet,
    folder_id: '-1',
  });
}

export async function listSeedrTasks(): Promise<any[]> {
  const data = await seedrRequest('list_contents', 'POST', {
    content_type: 'folder',
    content_id: '0',
  });

  return Array.isArray(data?.torrents) ? data.torrents : [];
}

async function listSeedrFolder(folderId: string | number = '0'): Promise<any> {
  return seedrRequest('list_contents', 'POST', {
    content_type: 'folder',
    content_id: String(folderId),
  });
}

async function fetchSeedrFile(fileId: string | number): Promise<any> {
  return seedrRequest('fetch_file', 'POST', {
    folder_file_id: String(fileId),
  });
}

function numericId(value: any): string {
  return String(value ?? '');
}

function taskMatches(task: any, taskId: string): boolean {
  return [
    task?.id,
    task?.task_id,
    task?.user_torrent_id,
    task?.torrent_id,
  ].map(numericId).includes(taskId);
}

function taskProgress(task: any): number {
  const raw = task?.progress ?? task?.pct ?? task?.percentage ?? task?.percent ?? 0;
  const value = Number(String(raw).replace('%', ''));
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

function taskIsComplete(task: any): boolean {
  if (!task) return false;
  const status = String(task?.status ?? task?.state ?? task?.phase ?? '').toLowerCase();
  return taskProgress(task) >= 100 ||
    ['completed', 'complete', 'finished', 'done', 'success', 'succeeded'].includes(status);
}

function extractUrl(details: any): string {
  return String(
    details?.url ??
    details?.download_url ??
    details?.downloadUrl ??
    details?.direct_url ??
    details?.directUrl ??
    ''
  );
}

function normalizeFile(file: any): any {
  return {
    id: numericId(file?.folder_file_id ?? file?.file_id ?? file?.id),
    name: String(file?.name ?? file?.filename ?? ''),
    size: Number(file?.size ?? 0),
    folderId: numericId(file?.folder_id ?? file?.fid ?? file?.folderId),
  };
}

async function collectSeedrFiles(folderId: string | number = '0', depth = 0): Promise<any[]> {
  if (depth > 6) return [];

  const payload = await listSeedrFolder(folderId);
  const files = Array.isArray(payload?.files) ? payload.files.map(normalizeFile) : [];
  const folders = Array.isArray(payload?.folders) ? payload.folders : [];

  const nested = await Promise.all(
    folders.map((folder: any) => {
      const childId = folder?.id ?? folder?.folder_id ?? folder?.fid;
      return childId == null ? [] : collectSeedrFiles(childId, depth + 1);
    })
  );

  return [...files, ...nested.flat()];
}

async function getTaskProgress(task: any): Promise<{ progress: number; task: any }> {
  const direct = taskProgress(task);
  if (direct > 0 || taskIsComplete(task) || !task?.progress_url) {
    return { progress: direct, task };
  }

  try {
    const progressUrl = String(task.progress_url);
    const url = new URL(progressUrl);
    const response = await fetch(url);
    if (response.ok) {
      const progressData = await response.json();
      const progress = taskProgress(progressData);
      return { progress, task: { ...task, ...progressData } };
    }
  } catch {
    // Fall back to the list_contents torrent object.
  }

  return { progress: direct, task };
}

export async function getSeedrTaskStatus(taskId: string | number, selectedNames: string[] = []): Promise<any> {
  const id = numericId(taskId);
  const tasks = await listSeedrTasks();
  const matched = tasks.find(item => taskMatches(item, id)) ?? null;
  const progressResult = await getTaskProgress(matched);
  const task = progressResult.task;
  const progress = progressResult.progress;
  const complete = taskIsComplete(task);

  if (!matched) {
    return {
      taskId,
      status: 'waiting',
      progress: 0,
      task: null,
      files: [],
      downloadUrl: null,
    };
  }

  if (!complete) {
    return {
      taskId,
      status: 'downloading',
      progress,
      task,
      files: [],
      downloadUrl: null,
    };
  }

  const allFiles = await collectSeedrFiles('0');
  const normalizedSelected = selectedNames
    .map(name => String(name).split('/').pop()?.toLowerCase() || '')
    .filter(Boolean);

  let candidates = allFiles;
  if (normalizedSelected.length) {
    const matchedFiles = allFiles.filter(file => {
      const name = String(file.name).split('/').pop()?.toLowerCase() || '';
      return normalizedSelected.includes(name);
    });
    if (matchedFiles.length) candidates = matchedFiles;
  }

  const files = [];
  for (const file of candidates.slice(0, 50)) {
    if (!file.id) continue;

    try {
      const details = await fetchSeedrFile(file.id);
      const url = extractUrl(details);
      files.push({
        id: file.id,
        name: file.name,
        size: file.size,
        url: url || null,
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
    status: 'completed',
    progress: 100,
    task,
    files,
    downloadUrl: files.find(file => file.url)?.url ?? null,
  };
}

export function seedrMaxSizeBytes(): number {
  return SEEDR_MAX_SIZE_BYTES;
}
