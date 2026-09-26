type TorrentMetadataFile = {
  index: number;
  name: string;
  size: number;
  path: string;
  type: 'video' | 'audio' | 'archive' | 'document' | 'other';
  priority: number;
};

export type TorrentMetadata = {
  name: string;
  infoHash: string;
  files: TorrentMetadataFile[];
  totalSize: number;
  elapsedMs: number;
};

const CACHE_TTL_MS = 10 * 60 * 1000;
const METADATA_TIMEOUT_MS = 20 * 1000;

const cache = new Map<string, { expiresAt: number; value: TorrentMetadata }>();
const inFlight = new Map<string, Promise<TorrentMetadata>>();
let clientPromise: Promise<any> | null = null;

function extractInfoHash(magnet: string): string {
  const match = String(magnet || '').match(/urn:btih:([a-zA-Z0-9]+)/i);
  return String(match?.[1] || '').toLowerCase();
}

function classifyFileType(name: string): TorrentMetadataFile['type'] {
  const lower = String(name || '').toLowerCase();
  if (/\.(mp4|mkv|m4v|webm|mov|avi|wmv|flv|ts|m2ts)$/i.test(lower)) return 'video';
  if (/\.(mp3|wav|flac|aac|ogg|m4a|opus|wma)$/i.test(lower)) return 'audio';
  if (/\.(zip|rar|7z|tar|gz|bz2|xz|iso)$/i.test(lower)) return 'archive';
  if (/\.(pdf|txt|md|json|csv|srt|vtt|ass|sub)$/i.test(lower)) return 'document';
  return 'other';
}

async function getClient(): Promise<any> {
  if (!clientPromise) {
    clientPromise = (async () => {
      const module: any = await import('webtorrent');
      const WebTorrent = module.default || module;
      return new WebTorrent();
    })().catch(error => {
      clientPromise = null;
      throw error;
    });
  }

  return clientPromise;
}

function destroyTorrent(torrent: any) {
  try {
    torrent?.destroy?.(() => undefined);
  } catch {
    // Best effort cleanup; the metadata client itself stays alive for reuse.
  }
}

export async function resolveTorrentMetadata(
  magnet: string,
  timeoutMs = METADATA_TIMEOUT_MS
): Promise<TorrentMetadata> {
  const source = String(magnet || '').trim();
  if (!/^magnet:\?/i.test(source)) {
    throw new Error('Metadata resolver requires a magnet link.');
  }

  const infoHash = extractInfoHash(source);
  if (!infoHash) throw new Error('Magnet link does not contain a valid BitTorrent info hash.');

  const cached = cache.get(infoHash);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }
  cache.delete(infoHash);

  const running = inFlight.get(infoHash);
  if (running) return running;

  const promise = (async () => {
    const startedAt = Date.now();
    const client = await getClient();

    const value = await new Promise<TorrentMetadata>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let torrent: any = null;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        fn();
        destroyTorrent(torrent);
      };

      timer = setTimeout(() => {
        finish(() => reject(new Error('Torrent metadata lookup timed out.')));
      }, timeoutMs);

      try {
        // paused + deselect means WebTorrent can discover peers and retrieve
        // BEP-9 metadata without selecting any content pieces for download.
        torrent = client.add(source, {
          paused: true,
          deselect: true,
        });

        torrent.once('metadata', () => {
          finish(() => {
            const files = (Array.isArray(torrent.files) ? torrent.files : []).map(
              (file: any, index: number) => ({
                index,
                name: String(file.path || file.name || 'Unknown file'),
                size: Number(file.length ?? file.size ?? 0),
                path: String(file.path || file.name || 'Unknown file'),
                type: classifyFileType(String(file.name || file.path || '')),
                priority: 1,
              })
            );

            const name = String(
              torrent.name ||
              files[0]?.name?.split('/')[0] ||
              'Torrent'
            );

            const result: TorrentMetadata = {
              name,
              infoHash,
              files,
              totalSize: files.reduce((sum, file) => sum + file.size, 0),
              elapsedMs: Date.now() - startedAt,
            };

            console.log(
              `[TORRENT-METADATA] ${infoHash} ready in ${result.elapsedMs}ms — ${files.length} file(s), payload downloaded=0`
            );

            cache.set(infoHash, {
              expiresAt: Date.now() + CACHE_TTL_MS,
              value: result,
            });

            resolve(result);
          });
        });

        torrent.once('error', (error: any) => {
          finish(() => reject(error instanceof Error ? error : new Error(String(error))));
        });
      } catch (error: any) {
        finish(() => reject(error instanceof Error ? error : new Error(String(error))));
      }
    });

    return value;
  })();

  inFlight.set(infoHash, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(infoHash);
  }
}
