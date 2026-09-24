# Torrent Studio

Torrent Studio is a web UI backed by a real qBittorrent instance.

## Architecture

Browser → Render/Node backend → qBittorrent on the Oracle VPS → qBittorrent download storage

The backend now proxies the torrent operations to qBittorrent instead of simulating torrent progress.

## Render environment variables

Set these in the Render dashboard; do not commit real credentials:

- `QBT_URL` — public HTTPS URL of the qBittorrent WebUI/API.
- `QBT_USERNAME` and `QBT_PASSWORD` — qBittorrent WebUI credentials.
- Or `QBT_API_KEY` — qBittorrent 5.2+ API key.

Render supplies `PORT`; the server binds to `0.0.0.0:$PORT`.

Do **not** use `http://localhost:8080` for `QBT_URL` on Render. That points back to the Render container, not the Oracle VPS.

## Selective downloads

The Add Magnet dialog sends selected file indexes to the backend. The backend uses qBittorrent's `filePriorities` support when adding a torrent, using priority 1 for selected files and 0 for skipped files. qBittorrent documents 0 as “Do not download”, 1 as normal, 6 as high, and 7 as maximal. citeturn7search0

## Magnet metadata

For qBittorrent 5.2+, the backend uses `torrents/fetchMetadata` to retrieve magnet metadata without adding the torrent first. Metadata can arrive asynchronously, so the backend retries briefly. citeturn6search0

## qBittorrent connectivity

The qBittorrent API must be reachable from Render. qBittorrent 5.2+ supports Basic authentication and API-key authentication, so either credentials or an API key can be used. citeturn3search5turn3search1

Because the WebUI/API is an administrative interface, expose it through HTTPS and authentication rather than an unprotected public port.

## Local development

```bash
npm install
cp .env.example .env
npm run dev
```

For local qBittorrent:

```
QBT_URL=http://127.0.0.1:8080
QBT_USERNAME=admin
QBT_PASSWORD=your_password
```
