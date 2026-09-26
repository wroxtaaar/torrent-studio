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

function getStatus(error: unknown): number | undefined {
  const status = Number((error as any)?.status);
  return Number.isFinite(status) && status > 0 ? status : undefined;
}

function asArray(value: any, keys: string[] = []): any[] {
  if (Array.isArray(value)) return value;
  for (const key of keys) {
    if (Array.isArray(value?.[key])) return value[key];
  }
  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.data?.items)) return value.data.items;
  return [];
}

function unwrapData(value: any): any {
  return value?.data ?? value;
}

async function seedrRequest(
  path: string,
  method: 'GET' | 'POST' | 'DELETE' = 'GET',
  body?: Record<string, unknown>
): Promise<any> {
  const token = getToken();
  if (!token) throw new Error('Seedr API token is not configured');

  const init: RequestInit = {
    method,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    },
  };

  if (body !== undefined) {
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  const response = await fetch(SEEDR_API_BASE + (path.startsWith('/') ? path : '/' + path), init);
  const text = await response.text();

  let result: any = null;
  try {
    result = text ? JSON.parse(text) : null;
  } catch {
    result = text;
  }

  if (!response.ok) {
    const message =
      result?.error_description ||
      result?.error ||
      result?.message ||
      text ||
      response.statusText ||
      'Seedr API request failed';
    throw Object.assign(new Error(String(message)), { status: response.status });
  }

  return result;
}

function numericId(value: any): string {
  return String(value ?? '');
}

function extractTaskId(result: any): string {
  const data = unwrapData(result);
  return numericId(
    data?.id ??
    data?.task_id ??
    data?.torrent_id ??
    data?.user_torrent_id
  );
}

function taskProgress(task: any): number {
  const raw =
    task?.progress ??
    task?.percentage ??
    task?.percent ??
    task?.pct ??
    task?.progress_percent ??
    0;

  const value = Number(String(raw).replace('%', ''));
  return Number.isFinite(value)
    ? Math.max(0, Math.min(100, value))
    : 0;
}

function taskIsComplete(task: any): boolean {
  if (!task) return false;

  const status = String(
    task?.status ??
    task?.state ??
    task?.phase ??
    task?.download_status ??
    ''
  ).toLowerCase();

  return taskProgress(task) >= 100 ||
    ['completed', 'complete', 'finished', 'done', 'success', 'succeeded'].includes(status);
}

function normalizeFile(file: any, folderId = ''): any {
  const id = numericId(
    file?.id ??
    file?.file_id ??
    file?.folder_file_id
  );

  return {
    id,
    name: String(file?.name ?? file?.filename ?? ''),
    size: Number(file?.size ?? file?.length ?? 0),
    folderId: numericId(file?.folder_id ?? file?.folderId ?? folderId),
  };
}

function normalizeFolder(folder: any): { id: string; name: string } {
  return {
    id: numericId(folder?.id ?? folder?.folder_id),
    name: String(folder?.name ?? folder?.title ?? 'Folder'),
  };
}

function extractFiles(payload: any, folderId = ''): any[] {
  return asArray(payload, ['files', 'items']).map(file => normalizeFile(file, folderId));
}

function extractFolders(payload: any): any[] {
  return asArray(payload, ['folders', 'directories']).map(normalizeFolder);
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

export async function addSeedrTask(magnet: string): Promise<any> {
  return seedrRequest('/tasks', 'POST', {
    torrent_magnet: magnet,
    folder_id: 0,
  });
}

export async function listSeedrTasks(): Promise<any[]> {
  const data = await seedrRequest('/tasks');
  return asArray(data, ['tasks', 'torrents']);
}

async function getFolderContents(folderId: string | number): Promise<any> {
  if (String(folderId) === '0') {
    return seedrRequest('/fs/root/contents');
  }

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

  const payload = await getFolderContents(folderId);
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
      const response = await fetch(url, {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${getToken()}`,
        },
      });

      if (response.ok) {
        const text = await response.text();
        let data: any = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = text; }

        return {
          progress: taskProgress(data),
          task: { ...task, ...unwrapData(data) },
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
      return {
        taskId,
        status: 'waiting',
        progress: 0,
        task: null,
        files: [],
        downloadUrl: null,
      };
    }

    throw error;
  }

  const progressResult = await fetchTaskProgress(id, unwrapData(task));
  task = progressResult.task;
  const progress = progressResult.progress;
  const complete = taskIsComplete(task);

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

  let candidates = await taskFiles(id);

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

export async function listSeedrLibrary(): Promise<SeedrLibraryFile[]> {
  return collectSeedrFiles('0', '/');
}

export async function getSeedrFileDownload(fileId: string | number): Promise<{ url: string; name: string }> {
  return getDownloadUrl(fileId);
}

export function seedrMaxSizeBytes(): number {
  return SEEDR_MAX_SIZE_BYTES;
}
