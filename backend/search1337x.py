import asyncio
import html
import re
from urllib.parse import quote, urljoin
import httpx

HOSTS = ["https://www.1337xx.to", "https://1337x.to", "https://1337x.st", "https://x1337x.ws"]
_last_good = HOSTS[0]
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/142 Safari/537.36"

def clean(value):
    return html.unescape(re.sub(r"<[^>]*>", "", value)).strip()

def size_bytes(value):
    m = re.search(r"([0-9]+(?:\.[0-9]+)?)\s*(B|KB|MB|GB|TB)", value.replace(",", ""), re.I)
    if not m: return 0
    return round(float(m.group(1)) * {"B":1,"KB":1024,"MB":1024**2,"GB":1024**3,"TB":1024**4}[m.group(2).upper()])

async def fetch(path):
    global _last_good
    hosts = [_last_good] + [h for h in HOSTS if h != _last_good]
    async with httpx.AsyncClient(timeout=7, follow_redirects=True, headers={"User-Agent": UA, "Accept": "text/html,application/xhtml+xml"}) as client:
        last = None
        for base in hosts:
            try:
                r = await client.get(base + path, headers={"Referer": base + "/"})
                if r.status_code == 200:
                    _last_good = base
                    return base, r.text
                last = RuntimeError("HTTP " + str(r.status_code))
            except Exception as exc:
                last = exc
        raise last or RuntimeError("No 1337x mirror reachable")

def parse_rows(page, category):
    out = []
    for row in re.findall(r"<tr[\s\S]*?</tr>", page, re.I):
        m = re.search(r'class=["\'][^"\']*coll-1\s+name[^"\']*["\'][\s\S]*?<a[^>]+href=["\'](/torrent/[^"\']+)["\'][^>]*>([\s\S]*?)</a>', row, re.I)
        if not m: continue
        def field(cls):
            x = re.search(r'class=["\'][^"\']*' + cls + r'[^"\']*["\'][^>]*>([\s\S]*?)</td>', row, re.I)
            return clean(x.group(1)) if x else ""
        out.append({"title": clean(m.group(2)), "size": size_bytes(field(r"coll-4\s+size")), "seeders": int(field(r"coll-2\s+seeds") or 0), "leechers": int(field(r"coll-3\s+leeches") or 0), "category": category, "page": m.group(1)})
    return out

async def detail(client, base, item):
    try:
        r = await client.get(urljoin(base, item["page"]), headers={"Referer": base + "/"})
        if r.status_code != 200: return None
        m = re.search(r'href=["\'](magnet:\?[^"\']+)["\']', r.text, re.I)
        if not m: return None
        magnet = html.unescape(m.group(1))
        h = re.search(r"(?:^|[?&])xt=urn:btih:([a-z0-9]{40})", magnet, re.I)
        return {**item, "guid": urljoin(base, item["page"]), "indexer": "1337x", "protocol": "torrent", "magnetUrl": magnet, "infoHash": h.group(1).lower() if h else None, "infoUrl": urljoin(base, item["page"]), "sourceUrl": urljoin(base, item["page"])}
    except Exception:
        return None

async def search_1337x(query, limit=10):
    encoded = quote(query).replace("%20", "+")
    async def one(category):
        try: return category, await fetch("/category-search/" + encoded + "/" + category + "/1/")
        except Exception: return category, None
    pages = await asyncio.gather(one("Movies"), one("TV"))
    tokens = [x for x in re.split(r"\s+", query.lower()) if x and x not in {"the","a","an","of","and"}]
    candidates = []
    for category, result in pages:
        if not result: continue
        base, page = result
        for item in parse_rows(page, category):
            if all(t in item["title"].lower() for t in tokens):
                item["base"] = base
                candidates.append(item)
    unique = {x["page"].lower(): x for x in candidates}
    top = sorted(unique.values(), key=lambda x: x["seeders"], reverse=True)[:max(1, min(limit, 10))]
    async with httpx.AsyncClient(timeout=7, follow_redirects=True, headers={"User-Agent": UA}) as client:
        results = await asyncio.gather(*(detail(client, x["base"], x) for x in top))
    return [x for x in results if x]
