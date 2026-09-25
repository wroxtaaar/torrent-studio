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
    const message = data?.error || data?.message || text || response.statusText || 'Seedr API request failed';
    throw Object.assign(new Error(message), { status: response.status });
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

export function seedrMaxSizeBytes(): number {
  return SEEDR_MAX_SIZE_BYTES;
}
