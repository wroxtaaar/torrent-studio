from __future__ import annotations

import asyncio
import hashlib
import json
import mimetypes
import os
import shutil
import subprocess
import time
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import quote

import httpx
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, RedirectResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from backend.qbt import qbt


BASE_DIR = Path(__file__).resolve().parent.parent
DIST_DIR = BASE_DIR / "dist"
STORAGE_DIR = Path(os.getenv("STORAGE_DIR", str(BASE_DIR / "storage"))).resolve()
DOWNLOADS_DIR = Path(os.getenv("DOWNLOADS_DIR", str(STORAGE_DIR / "downloads"))).resolve()
META_DIR = STORAGE_DIR / "meta"
STREAM_CACHE_DIR = STORAGE_DIR / "stream-cache"
HLS_CACHE_DIR = STORAGE_DIR / "hls-cache"

for directory in (DOWNLOADS_DIR, META_DIR, STREAM_CACHE_DIR, HLS_CACHE_DIR):
    directory.mkdir(parents=True, exist_ok=True)

USERS_FILE = META_DIR / "users.json"
FOLDERS_FILE = META_DIR / "folders.json"
LOGS_FILE = META_DIR / "logs.json"
NOTIFICATIONS_FILE = META_DIR / "notifications.json"
CLEANUP_FILE = META_DIR / "cleanup.json"
RECENT_SEARCHES_FILE = META_DIR / "recent-searches.json"


def read_json(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return fallback


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2), encoding="utf-8")


default_user = {
    "id": "user_admin",
    "name": "Admin",
    "email": "admin@localhost",
    "role": "admin",
    "avatar": "https://ui-avatars.com/api/?name=Admin&background=random",
}
users = read_json(USERS_FILE, [default_user])
if not users:
    users = [default_user]
active_user_id = users[0]["id"]

folder_meta = read_json(FOLDERS_FILE, [{
    "id": "folder_root", "name": "Root Storage", "path": "/", "ownerId": users[0]["id"],
    "ownerName": users[0]["name"], "isShared": False, "permissions": {}, "createdAt": int(time.time() * 1000)
}])
logs = read_json(LOGS_FILE, [])
notifications = read_json(NOTIFICATIONS_FILE, [])
cleanup_settings = read_json(CLEANUP_FILE, {
    "autoCleanCompletedDays": 7,
    "autoPurgeOrphans": True,
    "autoCleanTempFiles": True,
    "storageThresholdPercent": 85,
})


def active_user() -> dict[str, Any]:
    return next((u for u in users if u["id"] == active_user_id), users[0])


def log_event(kind: str, action: str, details: str, status: str = "info") -> None:
    logs.insert(0, {
        "id": str(uuid.uuid4()), "timestamp": int(time.time() * 1000), "type": kind,
        "userName": active_user()["name"], "userId": active_user()["id"],
        "action": action, "details": details, "status": status,
    })
    del logs[300:]
    write_json(LOGS_FILE, logs)


def notify(title: str, message: str, kind: str, link: str | None = None) -> None:
    notifications.insert(0, {
        "id": str(uuid.uuid4()), "timestamp": int(time.time() * 1000),
        "title": title, "message": message, "type": kind, "read": False, "link": link,
    })
    del notifications[100:]
    write_json(NOTIFICATIONS_FILE, notifications)


def safe_relative(value: str) -> str:
    normalized = "/" + str(value or "").replace("\\", "/")
    parts = [p for p in Path(normalized).parts if p not in ("/", ".")]
    if ".." in parts:
        raise HTTPException(400, "Invalid path")
    return "/".join(parts)


def physical_from_relative(relative: str) -> Path:
    rel = safe_relative(relative)
    target = (DOWNLOADS_DIR / rel).resolve()
    if target != DOWNLOADS_DIR and DOWNLOADS_DIR not in target.parents:
        raise HTTPException(400, "Invalid path")
    return target


def relative_from_physical(path: Path) -> str:
    return path.resolve().relative_to(DOWNLOADS_DIR).as_posix()


def file_id(relative: str) -> str:
    return "file_" + hashlib.sha256(relative.encode()).hexdigest()[:24]


def folder_id(relative: str) -> str:
    return "folder_" + hashlib.sha256((relative or "/").encode()).hexdigest()[:24]


def file_type(name: str) -> str:
    ext = Path(name).suffix.lower()
    if ext in {".mp4", ".m4v", ".webm", ".mov", ".mkv", ".avi", ".wmv", ".flv", ".ts", ".m2ts"}:
        return "video"
    if ext in {".mp3", ".wav", ".flac", ".aac", ".ogg", ".m4a", ".opus", ".wma"}:
        return "audio"
    if ext in {".jpg", ".jpeg", ".png", ".webp", ".gif", ".svg"}:
        return "image"
    if ext in {".zip", ".tar", ".gz", ".7z", ".rar", ".iso", ".bz2", ".xz"}:
        return "archive"
    if ext in {".pdf", ".txt", ".md", ".json", ".csv", ".srt", ".vtt", ".ass", ".sub"}:
        return "document"
    return "other"


def mime_for(name: str) -> str:
    return mimetypes.guess_type(name)[0] or "application/octet-stream"


def scan_files() -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for path in DOWNLOADS_DIR.rglob("*"):
        if not path.is_file() or path.name.lower().endswith(".parts"):
            continue
        rel = relative_from_physical(path)
        stat = path.stat()
        typ = file_type(path.name)
        folder = "/" + str(Path(rel).parent).replace("\\", "/")
        if folder == "/.":
            folder = "/"
        result.append({
            "id": file_id(rel), "name": path.name, "path": "/" + rel,
            "folder": folder, "size": stat.st_size, "type": typ,
            "mimeType": mime_for(path.name),
            "createdAt": int((getattr(stat, "st_birthtime", stat.st_ctime)) * 1000),
            "isStreamable": typ in {"video", "audio"},
            "ownerId": active_user()["id"], "ownerName": active_user()["name"],
            "downloadUrl": f"/api/files/download/{file_id(rel)}",
            "streamUrl": f"/api/files/direct-stream/{file_id(rel)}" if typ == "video"
                else f"/api/files/stream/{file_id(rel)}",
        })
    return sorted(result, key=lambda x: x["createdAt"], reverse=True)


def scan_folders() -> list[dict[str, Any]]:
    files = scan_files()
    found = [{
        "id": "folder_root", "name": "Root Storage", "path": "/", "ownerId": users[0]["id"],
        "ownerName": users[0]["name"], "isShared": False, "permissions": {}, "createdAt": 0,
    }]
    for path in DOWNLOADS_DIR.rglob("*"):
        if not path.is_dir():
            continue
        rel = relative_from_physical(path)
        p = "/" + rel
        meta = next((f for f in folder_meta if f.get("path") == p), None)
        found.append(meta or {
            "id": folder_id(rel), "name": path.name, "path": p,
            "ownerId": users[0]["id"], "ownerName": users[0]["name"],
            "isShared": False, "permissions": {},
            "createdAt": int(path.stat().st_ctime * 1000),
        })
    for folder in found:
        inside = [f for f in files if f["folder"] == folder["path"]]
        folder["filesCount"] = len(inside)
        folder["totalSize"] = sum(f["size"] for f in inside)
    return found


def find_local_file_by_id(identifier: str) -> Path:
    for item in scan_files():
        if item["id"] == identifier:
            return physical_from_relative(item["path"].lstrip("/"))
    raise HTTPException(404, "File not found")


def torrent_file_path(torrent: dict[str, Any], index: int) -> Path:
    files = torrent.get("files") or []
    file = next((f for f in files if int(f.get("index", -1)) == index), None)
    if not file:
        raise HTTPException(404, "Torrent file not found")
    save_path = str(torrent.get("save_path") or "/downloads")
    relative = str(file.get("name") or file.get("path") or "")
    if save_path.startswith("/downloads"):
        relative = save_path[len("/downloads"):].strip("/") + "/" + relative
    return physical_from_relative(relative)


async def media_info(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise HTTPException(404, "Media file not found")
    try:
        proc = await asyncio.create_subprocess_exec(
            "ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", str(path),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=30)
        return json.loads(stdout.decode() or "{}")
    except Exception:
        return {"streams": [], "format": {"filename": str(path), "size": path.stat().st_size}}


def file_response(path: Path, download: bool = False) -> FileResponse:
    if not path.is_file():
        raise HTTPException(404, "File not found")
    headers = {"Accept-Ranges": "bytes"}
    if download:
        headers["Content-Disposition"] = f'attachment; filename="{path.name}"'
    return FileResponse(path, media_type=mime_for(path.name), headers=headers)


_hls_jobs: dict[str, asyncio.Task[None]] = {}


def hls_cache_dir(source: Path) -> Path:
    stat = source.stat()
    key = hashlib.sha256(
        ("hls-v4-mpegts" + str(source) + str(stat.st_size) + str(stat.st_mtime_ns)).encode()
    ).hexdigest()
    return HLS_CACHE_DIR / key


async def prepare_hls(source: Path) -> Path:
    cache = hls_cache_dir(source)
    playlist = cache / "index.m3u8"
    first_segment = cache / "segment_00000.ts"
    if playlist.exists() and first_segment.exists() and "#EXT-X-ENDLIST" in playlist.read_text(errors="ignore"):
        return cache

    cache.mkdir(parents=True, exist_ok=True)
    job_key = str(cache)
    job = _hls_jobs.get(job_key)
    if job is None or job.done():
        for item in cache.iterdir():
            if item.is_file():
                item.unlink(missing_ok=True)

        async def run() -> None:
            probe = await media_info(source)
            streams = probe.get("streams", [])
            video = next((s for s in streams if s.get("codec_type") == "video"), None)
            audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
            if not video:
                raise RuntimeError("No video stream was found in this file.")

            video_copy = str(video.get("codec_name", "")).lower() == "h264" and str(video.get("pix_fmt", "")).lower() in {"yuv420p", "yuvj420p"}
            audio_copy = not audio or str(audio.get("codec_name", "")).lower() == "aac"
            args = [
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(source),
                "-map", "0:v:0",
            ]
            if audio:
                args += ["-map", "0:a:0?"]
            args += ["-c:v", "copy" if video_copy else "libx264"]
            if not video_copy:
                args += ["-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-profile:v", "high", "-level:v", "4.1"]
            if audio:
                args += ["-c:a", "copy" if audio_copy else "aac"]
                if not audio_copy:
                    args += ["-b:a", "160k", "-ar", "48000"]
            args += [
                "-f", "hls", "-hls_time", "6", "-hls_playlist_type", "event",
                "-hls_list_size", "0", "-hls_flags", "independent_segments+temp_file",
                "-hls_segment_type", "mpegts", "-hls_segment_filename",
                str(cache / "segment_%05d.ts"), str(playlist),
            ]
            proc = await asyncio.create_subprocess_exec(*args, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
            _, stderr = await proc.communicate()
            if proc.returncode != 0:
                raise RuntimeError(stderr.decode(errors="replace")[-6000:] or "ffmpeg HLS generation failed")
            if not playlist.exists() or not first_segment.exists():
                raise RuntimeError("ffmpeg did not produce a complete HLS playlist.")

        job = asyncio.create_task(run())
        _hls_jobs[job_key] = job

    try:
        await asyncio.wait_for(asyncio.shield(job), timeout=25)
    except asyncio.TimeoutError:
        for _ in range(100):
            if first_segment.exists():
                return cache
            await asyncio.sleep(0.25)
        raise HTTPException(504, "Timed out waiting for the first HLS segment")
    except Exception as exc:
        _hls_jobs.pop(job_key, None)
        raise HTTPException(500, str(exc)) from exc
    finally:
        if job.done():
            _hls_jobs.pop(job_key, None)
    return cache



app = FastAPI(title="Torrent Studio Python Backend", version="1.0.0")


@app.get("/health")
async def health() -> dict[str, Any]:
    try:
        qbt_health = await qbt.health()
        return {"status": "ok", "qBittorrent": qbt_health}
    except Exception as exc:
        return JSONResponse(status_code=503, content={"status": "degraded", "error": str(exc)})


@app.get("/api/v2/app/version")
async def qbt_version():
    return PlainTextResponse(str(await qbt.json("GET", "/api/v2/app/version")))


@app.get("/api/v2/app/webapiVersion")
async def qbt_webapi_version():
    return PlainTextResponse(str(await qbt.json("GET", "/api/v2/app/webapiVersion")))


@app.post("/api/v2/auth/login")
async def qbt_login():
    await qbt.login()
    return PlainTextResponse("Ok.")


@app.post("/api/v2/auth/logout")
async def qbt_logout():
    qbt.cookie = ""
    return PlainTextResponse("Ok.")


@app.get("/api/v2/transfer/info")
async def transfer_info():
    return await qbt.json("GET", "/api/v2/transfer/info")


@app.get("/api/v2/torrents/info")
async def torrents_info(filter: str | None = None):
    return await qbt.torrents_info({"filter": filter} if filter else None)


@app.get("/api/v2/torrents/files")
async def torrents_files(hash: str):
    return await qbt.torrent_files(hash)


@app.get("/api/v2/torrents/export")
async def torrents_export(hash: str):
    return Response(await qbt.export(hash), media_type="application/x-bittorrent")


@app.post("/api/v2/torrents/filePrio")
async def torrents_file_prio(body: dict[str, Any]):
    return await qbt.file_priority(str(body.get("hash", "")), str(body.get("id", "")), int(body.get("priority", 1)))


@app.post("/api/v2/torrents/pause")
async def torrents_pause(body: dict[str, Any]):
    return await qbt.pause(str(body.get("hashes") or body.get("hash") or ""))


@app.post("/api/v2/torrents/resume")
async def torrents_resume(body: dict[str, Any]):
    return await qbt.resume(str(body.get("hashes") or body.get("hash") or ""))


@app.post("/api/v2/torrents/delete")
async def torrents_delete(body: dict[str, Any]):
    return await qbt.delete(str(body.get("hashes") or body.get("hash") or ""), bool(body.get("deleteFiles", False)))


@app.post("/api/v2/torrents/add")
async def torrents_add(body: dict[str, Any]):
    urls = str(body.get("urls") or "").strip()
    if not urls:
        raise HTTPException(400, "urls is required")
    selected = body.get("selectedNames") or []
    result = await qbt.add(
        urls,
        savepath="/downloads",
        autoTMM="false",
        category=body.get("category") or "Downloads",
    )
    if body.get("selectedFiles") is not None and body.get("existingHash"):
        ids = "|".join(str(x) for x in body["selectedFiles"])
        await qbt.file_priority(str(body["existingHash"]), ids, 1)
    return {"backend": "qbittorrent", "qbtResponse": result, "selectedNames": selected}


@app.post("/api/v2/torrents/inspect-magnet")
async def inspect_magnet(body: dict[str, Any]):
    magnet = str(body.get("magnet") or body.get("urls") or "").strip()
    if not magnet:
        raise HTTPException(400, "magnet is required")
    return await qbt.inspect_magnet(magnet, str(body.get("category") or "Downloads"))


@app.post("/api/v2/torrents/upload-torrent")
async def upload_torrent(body: dict[str, Any]):
    encoded = str(body.get("base64") or "")
    filename = str(body.get("filename") or "upload.torrent")
    if not encoded:
        raise HTTPException(400, "base64 is required")
    try:
        data = __import__("base64").b64decode(encoded)
    except Exception as exc:
        raise HTTPException(400, "Invalid torrent file") from exc
    response = await qbt.request(
        "POST", "/api/v2/torrents/add",
        files={"torrents": (filename, data, "application/x-bittorrent")},
        data={"savepath": "/downloads", "autoTMM": "false", "paused": "true"},
    )
    if response.status_code >= 400:
        raise HTTPException(response.status_code, response.text)
    return {"name": Path(filename).stem, "hash": "", "files": [], "totalSize": len(data), "magnetUri": ""}


@app.post("/api/torrents/metadata")
async def torrent_metadata(body: dict[str, Any]):
    magnet = str(body.get("magnet") or "").strip()
    if not magnet:
        raise HTTPException(400, "magnet is required")
    return await qbt.inspect_magnet(magnet)


@app.get("/api/search/recent")
async def recent_get():
    return {"searches": read_json(RECENT_SEARCHES_FILE, [])}


@app.post("/api/search/recent")
async def recent_add(body: dict[str, Any]):
    query = str(body.get("query") or "").strip()
    if query:
        searches = read_json(RECENT_SEARCHES_FILE, [])
        searches = [query] + [x for x in searches if x != query]
        write_json(RECENT_SEARCHES_FILE, searches[:10])
    return {"searches": read_json(RECENT_SEARCHES_FILE, [])}


@app.delete("/api/search/recent")
async def recent_clear():
    write_json(RECENT_SEARCHES_FILE, [])
    return {"success": True}


async def prowlarr_search(query: str, limit: int) -> list[dict[str, Any]]:
    base = (os.getenv("PROWLARR_URL") or "http://prowlarr:9696").rstrip("/")
    key = os.getenv("PROWLARR_API_KEY", "")
    if not key:
        raise HTTPException(503, "Torrent search is not configured. Set PROWLARR_API_KEY.")
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.get(
            f"{base}/api/v1/search",
            params={"query": query, "type": "search", "limit": min(max(limit, 1), 10), "offset": 0},
            headers={"Accept": "application/json", "X-Api-Key": key},
        )
    if response.status_code >= 400:
        raise HTTPException(response.status_code, response.text or "Prowlarr search failed")
    releases = response.json()
    if not isinstance(releases, list):
        releases = releases.get("results", []) if isinstance(releases, dict) else []
    result = []
    for release in releases:
        if str(release.get("protocol", "")).lower() == "usenet":
            continue
        result.append({
            "guid": release.get("guid"),
            "title": str(release.get("title") or release.get("sortTitle") or "Untitled"),
            "size": int(release.get("size") or 0),
            "seeders": int(release.get("seeders") or 0),
            "leechers": int(release.get("leechers") or release.get("leecherCount") or 0),
            "indexer": str(release.get("indexer") or ""),
            "protocol": str(release.get("protocol") or ""),
            "publishDate": release.get("publishDate"),
            "infoHash": str(release.get("infoHash") or ""),
            "magnetUrl": str(release.get("magnetUrl") or release.get("magneturl") or "") or None,
            "infoUrl": str(release.get("infoUrl") or "").strip() or None,
            "sourceUrl": str(release.get("magnetUrl") or release.get("downloadUrl") or "").strip() or None,
        })
    return result


@app.get("/api/search/torrents")
async def search_torrents(q: str = "", limit: int = 10):
    query = q.strip()
    if not query:
        return {"results": []}
    result = await prowlarr_search(query, limit)
    searches = read_json(RECENT_SEARCHES_FILE, [])
    write_json(RECENT_SEARCHES_FILE, [query] + [x for x in searches if x != query][:9])
    return {"results": result}


@app.get("/api/files")
async def files_list():
    return {"files": scan_files()}


@app.get("/api/files/download/{identifier}")
async def file_download(identifier: str):
    return file_response(find_local_file_by_id(identifier), True)


@app.get("/api/files/stream/{identifier}")
async def file_stream(identifier: str):
    return file_response(find_local_file_by_id(identifier))


@app.get("/api/files/direct-stream/{identifier}")
async def direct_stream(identifier: str):
    return file_response(find_local_file_by_id(identifier))


@app.get("/api/files/media-info/{identifier}")
async def file_media_info(identifier: str):
    return await media_info(find_local_file_by_id(identifier))


@app.get("/api/files/subtitle/{identifier}/{stream_index}.vtt")
async def file_subtitle(identifier: str, stream_index: int):
    path = find_local_file_by_id(identifier)
    cache = HLS_CACHE_DIR / f"{identifier}-{stream_index}.vtt"
    if cache.exists() and cache.stat().st_mtime > time.time() - 3600:
        return FileResponse(cache, media_type="text/vtt")
    proc = await asyncio.create_subprocess_exec(
        "ffmpeg", "-v", "error", "-i", str(path), "-map", f"0:{stream_index}",
        "-f", "webvtt", "pipe:1", stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    stdout, _ = await proc.communicate()
    if proc.returncode != 0:
        raise HTTPException(404, "Subtitle stream not available")
    cache.write_bytes(stdout)
    return Response(stdout, media_type="text/vtt")


@app.get("/api/files/hls/{identifier}/{asset}")
async def file_hls(identifier: str, asset: str):
    if asset not in {"index.m3u8"} and not asset.startswith("segment_") or (asset.startswith("segment_") and not asset.endswith(".ts")):
        raise HTTPException(400, "Invalid HLS asset")
    source = find_local_file_by_id(identifier)
    cache = await prepare_hls(source)
    if asset == "index.m3u8":
        playlist = (cache / asset).read_text(encoding="utf-8")
        rewritten = []
        for line in playlist.splitlines():
            stripped = line.strip()
            if stripped and not stripped.startswith("#"):
                stripped = f"/api/files/hls/{quote(identifier)}/{quote(Path(stripped).name)}"
                rewritten.append(stripped)
            elif 'URI="' in line:
                import re
                line = re.sub(r'URI="([^"]+)"', lambda m: f'URI="/api/files/hls/{quote(identifier)}/{quote(Path(m.group(1)).name)}"', line)
                rewritten.append(line)
            else:
                rewritten.append(line)
        return Response("\n".join(rewritten) + "\n", media_type="application/vnd.apple.mpegurl", headers={"Cache-Control": "no-store"})
    segment = cache / Path(asset).name
    if not segment.is_file():
        raise HTTPException(404, "HLS segment not ready")
    return FileResponse(segment, media_type="video/mp2t", headers={"Cache-Control": "public, max-age=31536000, immutable"})


@app.post("/api/files/zip")
async def files_zip(body: dict[str, Any]):
    import zipfile
    ids = body.get("ids") or body.get("fileIds") or []
    if not ids:
        raise HTTPException(400, "No files selected")
    archive = STREAM_CACHE_DIR / f"{uuid.uuid4().hex}.zip"
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as zf:
        for identifier in ids:
            path = find_local_file_by_id(str(identifier))
            zf.write(path, path.name)
    return FileResponse(archive, filename="torrent-studio.zip", media_type="application/zip")


@app.post("/api/files/folder")
async def create_folder(body: dict[str, Any]):
    target = physical_from_relative(str(body.get("path") or body.get("name") or "New Folder"))
    target.mkdir(parents=True, exist_ok=True)
    return {"success": True}


@app.post("/api/files/rename")
async def rename_file(body: dict[str, Any]):
    source = find_local_file_by_id(str(body.get("id") or body.get("fileId")))
    name = Path(str(body.get("name") or body.get("newName") or "")).name
    if not name:
        raise HTTPException(400, "name is required")
    target = source.with_name(name)
    source.rename(target)
    return {"success": True}


@app.post("/api/files/move")
async def move_file(body: dict[str, Any]):
    source = find_local_file_by_id(str(body.get("id") or body.get("fileId")))
    destination = physical_from_relative(str(body.get("path") or body.get("destination") or ""))
    if destination.is_dir():
        destination = destination / source.name
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(source), str(destination))
    return {"success": True}


@app.post("/api/files/delete")
async def delete_file(body: dict[str, Any]):
    ids = body.get("ids") or body.get("fileIds") or [body.get("id") or body.get("fileId")]
    for identifier in ids:
        if identifier:
            path = find_local_file_by_id(str(identifier))
            path.unlink(missing_ok=True)
    return {"success": True}


@app.get("/api/folders")
async def folders():
    return scan_folders()


@app.post("/api/folders/share")
async def folder_share(body: dict[str, Any]):
    path = str(body.get("path") or "/")
    existing = next((f for f in folder_meta if f.get("path") == path), None)
    if existing:
        existing["isShared"] = bool(body.get("isShared", True))
    else:
        folder_meta.append({
            "id": folder_id(path), "name": Path(path).name or "Root Storage", "path": path,
            "ownerId": active_user()["id"], "ownerName": active_user()["name"],
            "isShared": True, "permissions": body.get("permissions", {}),
            "createdAt": int(time.time() * 1000),
        })
    write_json(FOLDERS_FILE, folder_meta)
    return {"success": True}


@app.get("/api/users")
async def get_users():
    return {"users": users, "activeUserId": active_user_id, "activeUser": active_user()}


@app.post("/api/users/switch")
async def switch_user(body: dict[str, Any]):
    global active_user_id
    requested = str(body.get("userId") or body.get("id") or "")
    if not any(u["id"] == requested for u in users):
        raise HTTPException(404, "User not found")
    active_user_id = requested
    return {"users": users, "activeUserId": active_user_id, "activeUser": active_user()}


@app.post("/api/users/create")
async def create_user(body: dict[str, Any]):
    user = {
        "id": str(body.get("id") or uuid.uuid4()), "name": str(body.get("name") or "User"),
        "email": str(body.get("email") or ""), "role": str(body.get("role") or "user"),
        "avatar": str(body.get("avatar") or ""),
    }
    users.append(user)
    write_json(USERS_FILE, users)
    return user


@app.get("/api/storage/stats")
async def storage_stats():
    usage = shutil.disk_usage(DOWNLOADS_DIR)
    used = usage.total - usage.free
    return {
        "total": usage.total, "used": used, "free": usage.free,
        "usedPercent": round((used / usage.total) * 100, 2) if usage.total else 0,
    }


@app.get("/api/cleanup/settings")
async def cleanup_get():
    return cleanup_settings


@app.post("/api/cleanup/settings")
async def cleanup_set(body: dict[str, Any]):
    cleanup_settings.update(body)
    write_json(CLEANUP_FILE, cleanup_settings)
    return cleanup_settings


@app.post("/api/cleanup/run")
async def cleanup_run():
    removed = 0
    for directory in (STREAM_CACHE_DIR, HLS_CACHE_DIR):
        for item in directory.iterdir():
            try:
                if item.is_file() and time.time() - item.stat().st_mtime > 86400:
                    item.unlink()
                    removed += 1
            except OSError:
                pass
    return {"success": True, "removed": removed}


@app.get("/api/logs")
async def get_logs():
    return logs


@app.post("/api/logs/clear")
async def clear_logs():
    logs.clear()
    write_json(LOGS_FILE, logs)
    return {"success": True}


@app.get("/api/notifications")
async def get_notifications():
    return notifications


@app.post("/api/notifications/read")
async def notifications_read():
    for item in notifications:
        item["read"] = True
    write_json(NOTIFICATIONS_FILE, notifications)
    return {"success": True}


@app.post("/api/notifications/test")
async def notifications_test():
    notify("Torrent Studio Test", "Notifications are working on the VPS.", "system")
    return {"success": True}


@app.get("/api/qbt/settings")
async def qbt_settings():
    return {
        "url": qbt.base_url,
        "configured": qbt.configured(),
        "username": qbt.username,
        "apiKeyConfigured": bool(qbt.api_key),
    }


@app.post("/api/qbt/settings")
async def qbt_settings_update(body: dict[str, Any]):
    return {"success": True, "message": "Runtime settings are managed through environment variables."}


@app.get("/api/torrents/media-info/{hash}/{index}")
async def torrent_media_info(hash: str, index: int):
    torrents = await qbt.torrents_info({"hash": hash})
    if not torrents:
        raise HTTPException(404, "Torrent not found")
    return await media_info(torrent_file_path(torrents[0], index))


@app.get("/api/torrents/download/{hash}/{index}")
async def torrent_download(hash: str, index: int):
    torrents = await qbt.torrents_info({"hash": hash})
    if not torrents:
        raise HTTPException(404, "Torrent not found")
    return file_response(torrent_file_path(torrents[0], index), True)


@app.get("/api/torrents/stream/{hash}/{index}")
async def torrent_stream(hash: str, index: int):
    torrents = await qbt.torrents_info({"hash": hash})
    if not torrents:
        raise HTTPException(404, "Torrent not found")
    return file_response(torrent_file_path(torrents[0], index))


@app.get("/api/torrents/direct-stream/{hash}/{index}")
async def torrent_direct_stream(hash: str, index: int):
    return await torrent_stream(hash, index)


@app.get("/api/torrents/subtitle/{hash}/{index}/{stream_index}.vtt")
async def torrent_subtitle(hash: str, index: int, stream_index: int):
    path = await torrent_file_path_for_hash(hash, index)
    proc = await asyncio.create_subprocess_exec(
        "ffmpeg", "-v", "error", "-i", str(path), "-map", f"0:{stream_index}",
        "-f", "webvtt", "pipe:1", stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    stdout, _ = await proc.communicate()
    if proc.returncode != 0:
        raise HTTPException(404, "Subtitle stream not available")
    return Response(stdout, media_type="text/vtt")


async def torrent_file_path_for_hash(hash: str, index: int) -> Path:
    torrents = await qbt.torrents_info({"hash": hash})
    if not torrents:
        raise HTTPException(404, "Torrent not found")
    return torrent_file_path(torrents[0], index)


# Optional Seedr compatibility layer. It deliberately stays disabled unless a token
# is supplied, matching the existing hybrid design without exposing account-wide files.
SEEDR_TOKEN = os.getenv("SEEDR_API_TOKEN", "")
SEEDR_BASE = "https://www.seedr.cc/rest"


async def seedr_request(path: str, method: str = "GET", **kwargs: Any) -> Any:
    if not SEEDR_TOKEN:
        raise HTTPException(503, "Seedr is not configured")
    headers = kwargs.pop("headers", {})
    headers["Authorization"] = f"Bearer {SEEDR_TOKEN}"
    async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
        response = await client.request(method, SEEDR_BASE + path, headers=headers, **kwargs)
    if response.status_code >= 400:
        raise HTTPException(response.status_code, response.text)
    try:
        return response.json()
    except Exception:
        return response.text


@app.get("/api/seedr/quota")
async def seedr_quota():
    if not SEEDR_TOKEN:
        return {"configured": False, "maxSpace": 0, "usedSpace": 0, "remainingSpace": 0}
    data = await seedr_request("/account")
    return {
        "configured": True,
        "maxSpace": int(data.get("max_space", data.get("maxSpace", 0)) or 0),
        "usedSpace": int(data.get("space_used", data.get("usedSpace", 0)) or 0),
        "remainingSpace": int(data.get("space_available", data.get("remainingSpace", 0)) or 0),
    }


@app.post("/api/seedr/tasks/prepare")
async def seedr_prepare(body: dict[str, Any]):
    magnet = str(body.get("magnet") or "")
    if not SEEDR_TOKEN:
        raise HTTPException(503, "Seedr is not configured")
    data = await seedr_request("/torrent/magnet", "POST", data={"magnet": magnet})
    return data


@app.get("/api/seedr/tasks/{task_id}")
async def seedr_task(task_id: str):
    return await seedr_request(f"/task/{quote(task_id)}")


@app.delete("/api/seedr/tasks/{task_id}")
async def seedr_task_delete(task_id: str):
    return await seedr_request(f"/task/{quote(task_id)}", "DELETE")


@app.get("/api/seedr/files")
async def seedr_files():
    if not SEEDR_TOKEN:
        return {"configured": False, "files": []}
    data = await seedr_request("/fs/search", params={"query": ""})
    return {"configured": True, "files": data.get("files", []) if isinstance(data, dict) else []}


@app.get("/api/seedr/files/{file_id}/download")
async def seedr_file_download(file_id: str):
    data = await seedr_request(f"/fs/file/{quote(file_id)}/download")
    return data


@app.get("/api/seedr/files/stream")
async def seedr_file_stream(file_id: str):
    if not SEEDR_TOKEN:
        raise HTTPException(503, "Seedr is not configured")
    data = await seedr_request(f"/fs/file/{quote(file_id)}/download")
    url = data.get("url") if isinstance(data, dict) else None
    if not url:
        raise HTTPException(502, "Seedr did not return a stream URL")
    return RedirectResponse(url)


@app.delete("/api/seedr/files/{file_id}")
async def seedr_file_delete(file_id: str):
    return await seedr_request(f"/fs/file/{quote(file_id)}", "DELETE")


@app.get("/api/seedr/folders/{folder_id}/download")
async def seedr_folder_download(folder_id: str):
    return await seedr_request(f"/download/archive/init/{quote(folder_id)}", "PUT")


@app.delete("/api/seedr/folders/{folder_id}")
async def seedr_folder_delete(folder_id: str):
    return await seedr_request(f"/fs/folder/{quote(folder_id)}", "DELETE")


# Serve the existing React UI from the Python process. This keeps the migration
# focused on the backend: the browser application remains unchanged.
if DIST_DIR.exists():
    app.mount("/assets", StaticFiles(directory=DIST_DIR / "assets"), name="assets")


@app.get("/{path:path}")
async def spa_fallback(path: str):
    if path.startswith("api/") or path == "health":
        raise HTTPException(404)
    index = DIST_DIR / "index.html"
    if index.exists():
        return FileResponse(index)
    return JSONResponse({"error": "Frontend build not found"}, status_code=404)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("backend.main:app", host="0.0.0.0", port=int(os.getenv("PORT", "3000")))
