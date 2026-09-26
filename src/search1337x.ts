const X1337_HOSTS = [
  'https://www.1337xx.to',
  'https://1337x.to',
  'https://1337x.st',
  'https://x1337x.ws',
];

let lastGoodHost = X1337_HOSTS[0];

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

function decodeHtml(value: string): string {
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&#x2F;|&#47;/gi, '/')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .trim();
}

function parseTorrentSize(value: string): number {
  const match = String(value).replace(/,/g, '').trim().match(
    /^([0-9]+(?:\.[0-9]+)?)\s*(B|KB|MB|GB|TB)$/i
  );
  if (!match) return 0;

  const amount = Number(match[1]);
  const unit = match[2].toUpperCase();
  const multipliers: Record<string, number> = {
    B: 1,
    KB: 1024,
    MB: 1024 ** 2,
    GB: 1024 ** 3,
    TB: 1024 ** 4,
  };

  return Math.round(amount * (multipliers[unit] || 1));
}

function extractInfoHash(magnet: string): string {
  const match = String(magnet).match(/(?:^|[?&])xt=urn:btih:([a-z0-9]{40})/i);
  return match ? match[1].toLowerCase() : '';
}

function parseSearchRows(html: string, category: string) {
  const results: Array<{
    title: string;
    size: number;
    seeders: number;
    leechers: number;
    category: string;
    pageUrl: string;
  }> = [];

  const rowRegex = /<tr[\\s\\S]*?<\\/tr>/gi;
  const rows = html.match(rowRegex) || [];

  for (const row of rows) {
    const pageMatch = row.match(
      /<td[^>]*class=["'][^"']*coll-1\\s+name[^"']*["'][^>]*>[\\s\\S]*?<a[^>]+href=["'](\\/torrent\\/[^"']+)["'][^>]*>([\\s\\S]*?)<\\/a>/i
    );
    if (!pageMatch) continue;

    const seedMatch = row.match(
      /<td[^>]*class=["'][^"']*coll-2\\s+seeds[^"']*["'][^>]*>([\\s\\S]*?)<\\/td>/i
    );
    const leechMatch = row.match(
      /<td[^>]*class=["'][^"']*coll-3\\s+leeches[^"']*["'][^>]*>([\\s\\S]*?)<\\/td>/i
    );
    const sizeMatch = row.match(
      /<td[^>]*class=["'][^"']*coll-4\\s+size[^"']*["'][^>]*>([\\s\\S]*?)(?:<span[^>]*class=["'][^"']*seeds[^"']*["'][^>]*>[\\s\\S]*?<\\/span>)?<\\/td>/i
    );

    const title = decodeHtml(pageMatch[2]);
    if (!title) continue;

    results.push({
      title,
      size: parseTorrentSize(decodeHtml(sizeMatch?.[1] || '')),
      seeders: Number(decodeHtml(seedMatch?.[1] || '0')) || 0,
      leechers: Number(decodeHtml(leechMatch?.[1] || '0')) || 0,
      category,
      pageUrl: pageMatch[1],
    });
  }

  return results;
}

async function fetch1337x(pathname: string): Promise<{ base: string; html: string }> {
  const hosts = [
    lastGoodHost,
    ...X1337_HOSTS.filter(host => host !== lastGoodHost),
  ];

  let lastError: Error | null = null;

  for (const base of hosts) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);

    try {
      const response = await fetch(base + pathname, {
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': base + '/',
        },
        signal: controller.signal,
      });

      const html = await response.text();

      if (!response.ok) {
        lastError = new Error('1337x returned HTTP ' + response.status);
        continue;
      }

      lastGoodHost = base;
      return { base, html };
    } catch (error: any) {
      lastError = error instanceof Error ? error : new Error(String(error));
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError || new Error('No 1337x mirror was reachable');
}

async function fetch1337xDetail(base: string, pagePath: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(new URL(pagePath, base), {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': base + '/',
      },
      signal: controller.signal,
    });

    if (!response.ok) return null;

    const html = await response.text();
    const magnetMatch = html.match(/href=["'](magnet:\\?\\?[^"']+)["']/i);
    if (!magnetMatch) return null;

    const magnet = decodeHtml(magnetMatch[1]);
    if (!/^magnet:\\?/i.test(magnet)) return null;

    const dateMatch = html.match(/Date uploaded\\s*[:<\\/\\s]*([A-Za-z0-9.,'\\- ]{4,40})/i);

    return {
      magnetUrl: magnet,
      infoHash: extractInfoHash(magnet),
      publishDate: dateMatch?.[1]?.trim() || undefined,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function queryTokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\\s+/)
    .map(token => token.trim())
    .filter(Boolean)
    .filter(token => !['the', 'a', 'an', 'of', 'and'].includes(token));
}

export async function search1337x(query: string, limit = 10) {
  const encoded = encodeURIComponent(query).replace(/%20/g, '+');
  const categories = [
    { name: 'Movies', path: '/category-search/' + encoded + '/Movies/1/' },
    { name: 'TV', path: '/category-search/' + encoded + '/TV/1/' },
  ];

  const pages = await Promise.all(
    categories.map(async category => {
      try {
        return { category, page: await fetch1337x(category.path) };
      } catch {
        return { category, page: null };
      }
    })
  );

  const tokens = queryTokens(query);
  const candidates: Array<{
    title: string;
    size: number;
    seeders: number;
    leechers: number;
    category: string;
    pageUrl: string;
    base: string;
  }> = [];

  for (const { category, page } of pages) {
    if (!page) continue;

    for (const row of parseSearchRows(page.html, category.name)) {
      const title = row.title.toLowerCase();
      if (tokens.length && !tokens.every(token => title.includes(token))) continue;
      candidates.push({ ...row, base: page.base });
    }
  }

  const unique = new Map<string, typeof candidates[number]>();
  for (const candidate of candidates) {
    const key = candidate.pageUrl.toLowerCase();
    if (!unique.has(key)) unique.set(key, candidate);
  }

  const topCandidates = [...unique.values()]
    .sort((a, b) => b.seeders - a.seeders)
    .slice(0, Math.min(Math.max(limit, 1), 10));

  const detailed = await Promise.all(
    topCandidates.map(async candidate => {
      const detail = await fetch1337xDetail(candidate.base, candidate.pageUrl);
      if (!detail) return null;

      return {
        guid: candidate.base + candidate.pageUrl,
        title: candidate.title,
        size: candidate.size,
        seeders: candidate.seeders,
        leechers: candidate.leechers,
        indexer: '1337x',
        protocol: 'torrent',
        publishDate: detail.publishDate,
        infoHash: detail.infoHash || undefined,
        magnetUrl: detail.magnetUrl,
        infoUrl: candidate.base + candidate.pageUrl,
        sourceUrl: candidate.base + candidate.pageUrl,
      };
    })
  );

  return detailed.filter(Boolean);
}
