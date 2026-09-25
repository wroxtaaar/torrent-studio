# Torrent Studio — Oracle VPS

Torrent Studio is a self-hosted web UI for a real qBittorrent instance. Everything runs on your Oracle VPS: the React frontend, Node/Express backend, qBittorrent, and downloaded files.

## Architecture

Browser → Torrent Studio (Node/Express) → qBittorrent → `./downloads`

For completed video files, Torrent Studio can stream a browser-compatible H.264/AAC fragmented MP4 through the Node server; FFmpeg is included in the app image.

No Render, Cloud Run, or external qBittorrent service is required.

## Docker deployment

The repository includes a complete Docker Compose stack for the Oracle VPS. It runs Torrent Studio, qBittorrent, Prowlarr, and the FlareSolverr proxy/core on one private Docker network. The backend connects to qBittorrent at `http://qbittorrent:8080` and Prowlarr at `http://prowlarr:9696`.

Downloaded data is shared through the host's `./downloads` directory.

### 1. Clone

```bash
git clone https://github.com/wroxtaaar/torrent-studio.git
cd torrent-studio
```

### 2. Configure credentials

```bash
cp .env.example .env
nano .env
```

Set a strong qBittorrent admin password. Do not commit `.env`.

### 3. Start everything

```bash
docker compose up -d --build
```

The web app is available on port `3000`. qBittorrent's WebUI, Prowlarr, and FlareSolverr are kept private to the Docker network (Prowlarr is bound to localhost on the VPS for administration).

### 4. Check status

```bash
docker compose ps
```

```bash
curl http://127.0.0.1:3000/health
```

```bash
curl http://127.0.0.1:3000/api/v2/app/version
```

### 5. View logs

```bash
docker compose logs -f app
```

qBittorrent logs:

```bash
docker compose logs -f qbittorrent
```

## Selective downloads

The Add Magnet dialog sends selected file indexes to the backend. The backend passes qBittorrent 5.2.x file priorities when adding the torrent, so files marked as skipped are not downloaded.

## Important

- Keep qBittorrent's WebUI port private; users interact with it through Torrent Studio.
- If you want to access Torrent Studio from the internet, put HTTPS/authentication in front of port 3000 rather than exposing qBittorrent's WebUI directly.
- Torrent data persists in `./downloads` and qBittorrent configuration persists in `./qbittorrent-config`.

### Production update

From an existing checkout:

```bash
git pull origin main
docker compose up -d --build --force-recreate
docker compose ps
curl http://127.0.0.1:3000/health
```

The app image includes FFmpeg/FFprobe, so media streaming does not require installing FFmpeg separately on the VPS.


## Public access with login + HTTPS

Torrent Studio is intended to be exposed through the Caddy reverse proxy rather than directly on port 3000. Set these values in the VPS `.env` file:

```dotenv
APP_USERNAME=admin
APP_PASSWORD=<long-random-password>
AUTH_SECRET=<long-random-secret>
DOMAIN=seedflow.example.com
```

Create an A record for `DOMAIN` pointing to the Oracle VPS public IP. Open TCP ports 80 and 443 in the Oracle network security rules. Caddy then terminates HTTPS and proxies requests to the private app container.

The app itself listens on `127.0.0.1:3000` on the VPS and qBittorrent/Prowlarr/FlareSolverr stay on the Docker network.
