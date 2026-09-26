const SEEDR_BASE_URL = 'https://www.seedr.cc/api/v0.1/p';
const SEEDR_MAX_SIZE_BYTES = Number(process.env.SEEDR_MAX_SIZE_GB || 5) * 1024 * 1024 * 1024;

function getToken(): string {
  return String(process.env.SEEDR_API_TOKEN || '').trim();
}

export function isSeedrConfigured(): boolean {
  return Boolean(getToken());
}

export function canUseSeedr(totalSize: number): boolean {
  return isSeedrConfigured() && Number.isFinite(totalSize) && totalSize > 0 && totalSize <= SEEDR_MAX_SIZE_BYTES;
}

async function seedrRequest(path: string, init: RequestInit = {}): Promise<any> {
  const token = getToken();
  if (!token) throw new Error('Seedr API token is not configured');

  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  headers.set('Accept', 'application/json');

  const response = await fetch(SEEDR_BASE_URL + path, { ...init, headers });
  const text = await response.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }

  if (!response.ok) {
    const message = data?.error || data?.message || data || response.statusText || 'Seedr API request failed';
    throw Object.assign(new Error(String(message)), { status: response.status });
  }
  return data;
}

export async function addSeedrTask(magnet: string): Promise<any> {
  return seedrRequest('/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ torrent_magnet: magnet, folder_id: 0 }),
  });
}

export async function listSeedrTasks(): Promise<any[]> {
  const data = await seedrRequest('/tasks');
  return Array.isArray(data?.tasks) ? data.tasks : [];
}

async function listSeedrFolderItems(folderId: string | number = 0): Promise<any> {
  return seedrRequest(`/fs/folder/${encodeURIComponent(String(folderId))}/items`);
}

async function getSeedrFileDetails(fileId: string | number): Promise<any> {
  return seedrRequest(`/fs/file/${encodeURIComponent(String(fileId))}`);
}

function numericId(value: any): string {
  return String(value ?? '');
}

function taskMatches(task: any, taskId: string): boolean {
  return [task?.id, task?.task_id, task?.user_torrent_id, task?.torrent_id]
    .map(numericId)
    .includes(taskId);
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

function flattenItems(payload: any, folderId = '0'): any[] {
  const files = Array.isArray(payload?.files) ? payload.files : [];
  const folders = Array.isArray(payload?.folders) ? payload.folders : [];
  return [
    ...files.map((file: any) => ({ ...file, _folderId: folderId })),
    ...folders.map((folder: any) => ({ ...folder, _isFolder: true, _folderId: folderId })),
  ];
}

async function collectSeedrFiles(folderId: string | number = 0, depth = 0): Promise<any[]> {
  if (depth > 4) return [];

  const payload = await listSeedrFolderItems(folderId);
  const items = flattenItems(payload, String(folderId));
  const files = items.filter(item => !item._isFolder);
  const folders = items.filter(item => item._isFolder);

  const nested = await Promise.all(
    folders.map(folder => {
      const childId = folder?.id ?? folder?.folder_id;
      return childId == null ? [] : collectSeedrFiles(childId, depth + 1);
    })
  );

  return [...files, ...nested.flat()];
}

function fileId(file: any): string {
  return numericId(file?.folder_file_id ?? file?.file_id ?? file?.id);
}

function fileName(file: any): string {
  return String(file?.name ?? file?.filename ?? file?.path ?? '');
}

function extractUrl(details: any): string {
  return String(
    details?.url ??
    details?.download_url ??
    details?.downloadUrl ??
    details?.direct_url ??
    details?.directUrl ??
    details?.stream_url ??
    details?.streamUrl ??
    ''
  );
}

export async function getSeedrTaskStatus(taskId: string | number, selectedNames: string[] = []): Promise<any> {
  const id = numericId(taskId);
  const tasks = await listSeedrTasks();
  const task = tasks.find(item => taskMatches(item, id)) ?? null;
  const progress = taskProgress(task);
  const complete = taskIsComplete(task);

  if (!complete) {
    return {
      taskId: taskId,
      status: task ? 'downloading' : 'waiting',
      progress,
      task,
      files: [],
      downloadUrl: null,
    };
  }

  const allFiles = await collectSeedrFiles(0);
  const normalizedSelected = selectedNames.map(name => String(name).split('/').pop()?.toLowerCase() || '');

  let candidates = allFiles;
  if (normalizedSelected.length) {
    const matched = allFiles.filter(file => {
      const name = fileName(file).split('/').pop()?.toLowerCase() || '';
      return normalizedSelected.includes(name);
    });
    if (matched.length) candidates = matched;
  }

  const files = [];
  for (const file of candidates.slice(0, 20)) {
    const idValue = fileId(file);
    if (!idValue) continue;
    try {
      const details = await getSeedrFileDetails(idValue);
      const url = extractUrl(details);
      files.push({
        id: idValue,
        name: fileName(file),
        size: Number(file?.size ?? details?.size ?? 0),
        url: url || null,
      });
    } catch {
      files.push({
        id: idValue,
        name: fileName(file),
        size: Number(file?.size ?? 0),
        url: null,
      });
    }
  }

  const firstLink = files.find(file => file.url)?.url ?? null;

  return {
    taskId: taskId,
    status: 'completed',
    progress: 100,
    task,
    files,
    downloadUrl: firstLink,
  };
}

export function seedrMaxSizeBytes(): number {
  return SEEDR_MAX_SIZE_BYTES;
}
