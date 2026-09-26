from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import mimetypes
import os
import re
import shutil
import subprocess
import time
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, quote, unquote, urljoin, urlsplit

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
SEARCH_CACHE_FILE = META_DIR / "search-cache.json"
SEARCH_CACHE_TTL_SECONDS = int(os.getenv("SEARCH_CACHE_TTL_SECONDS", "900"))
SEARCH_CACHE_MAX_ENTRIES = 50


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


@app.post("/api/search/torrents/add")
async def search_torrent_add(body: dict[str, Any]):
    source = str(body.get("source") or "").strip()
    info_hash = str(body.get("infoHash") or "").strip().lower()
    # Only an explicitly supplied selectedSize is allowed here. The aggregate
    # search-result size must never be treated as the Seedr selection size.
    selected_size = int(body.get("selectedSize") or 0)

    if selected_size <= 0:
        return {"added": False, "reason": "selection_required"}

    if info_hash and re.fullmatch(r"[a-f0-9]{40}", info_hash):
        seedr_magnet = f"magnet:?xt=urn:btih:{info_hash}"
    elif re.match(r"^magnet:\?", source, re.IGNORECASE):
        seedr_magnet = source
    else:
        return {"added": False, "reason": "no_magnet_or_info_hash"}

    if not SEEDR_TOKEN or not SEEDR_LIBRARY_FOLDER_ID.isdigit():
        return {"added": False, "reason": "seedr_unavailable"}

    quota = _seedr_data(await seedr_request("/me/quota"))
    if not isinstance(quota, dict):
        return {"added": False, "reason": "invalid_quota"}

    def number(value: Any) -> int:
        try:
            return max(0, int(float(value))) if value not in (None, "") else 0
        except (TypeError, ValueError):
            return 0

    remaining = number(quota.get("space_remaining") or quota.get("remainingSpace"))
    if remaining == 0:
        remaining = max(0, number(quota.get("space_max")) - number(quota.get("space_used")))

    if selected_size >= remaining:
        return {"added": False, "reason": "insufficient_space", "remainingSpace": remaining}

    normalized = _seedr_normalize_magnet(seedr_magnet)
    info_hash = _seedr_info_hash(normalized)
    if not info_hash:
        return {"added": False, "reason": "invalid_magnet"}

    result = await _seedr_find_task_by_hash(info_hash)
    if not result:
        result = await _seedr_add_task(normalized, int(SEEDR_LIBRARY_FOLDER_ID))

    task_id = str(result.get("user_torrent_id") or result.get("id") or result.get("task_id") or "")
    if not task_id:
        raise HTTPException(502, "Seedr did not return a task id")

    return {
        "added": True,
        "backend": "seedr",
        "seedrTaskId": int(task_id) if task_id.isdigit() else task_id,
        "seedrResponse": result,
        "remainingSpace": remaining,
    }


@app.post("/api/v2/torrents/add")
async def torrents_add(body: dict[str, Any]):
    urls = str(body.get("urls") or "").strip()
    if not urls:
        raise HTTPException(400, "urls is required")

    existing_hash = str(body.get("existingHash") or "").strip()
    manifest = body.get("manifest") or []
    selected_ids = [int(x) for x in (body.get("selectedFiles") or [])]
    force_backend = str(body.get("forceBackend") or "").strip().lower()
    seedr_task_id = str(body.get("seedrTaskId") or "").strip()
    torrent_name = str(body.get("torrentName") or "").strip()

    # Seedr is an explicit backend choice from the frontend. Do not fall
    # through to qBittorrent when forceBackend=seedr.
    if force_backend == "seedr":
        if not SEEDR_TOKEN:
            raise HTTPException(503, "Seedr is not configured")
        if not SEEDR_LIBRARY_FOLDER_ID.isdigit():
            raise HTTPException(503, "SEEDR_LIBRARY_FOLDER_ID must be configured for Seedr downloads")

        # Seedr checks the full torrent size when a magnet is added.
        # If the user selected only part of a multi-file torrent, keep the
        # inspected qBittorrent torrent and download only those selected files.
        selected_size = sum(
            max(0, int(item.get("size") or 0))
            for item in manifest
            if isinstance(item, dict) and int(item.get("priority") or 0) > 0
        )
        total_manifest_size = sum(
            max(0, int(item.get("size") or 0))
            for item in manifest
            if isinstance(item, dict)
        )
        if existing_hash and selected_size > 0 and total_manifest_size > selected_size:
            await qbt.set_file_priorities(existing_hash, manifest, selected_ids)
            await qbt.resume(existing_hash)
            return {
                "backend": "qbittorrent",
                "seedrTaskId": None,
                "existingHash": existing_hash,
                "selectedNames": body.get("selectedNames") or [],
                "seedrFallback": True,
                "seedrFallbackReason": "Seedr cannot accept a partial torrent selection when the full torrent is larger than available storage.",
            }

        # The frontend decides the backend from the user's selected files.
        # Re-check the same selected-size rule server-side so a stale quota
        # value cannot cause Seedr to receive a selection that no longer fits.
        selected_size = sum(
            max(0, int(item.get("size") or 0))
            for item in manifest
            if isinstance(item, dict) and int(item.get("priority") or 0) > 0
        )

        if selected_size > 0:
            try:
                quota = _seedr_data(await seedr_request("/me/quota"))
                if isinstance(quota, dict):
                    def quota_number(value: Any) -> int:
                        try:
                            return max(0, int(float(value))) if value not in (None, "") else 0
                        except (TypeError, ValueError):
                            return 0

                    remaining = quota_number(quota.get("space_remaining") or quota.get("remainingSpace"))
                    if remaining == 0:
                        remaining = max(
                            0,
                            quota_number(quota.get("space_max")) - quota_number(quota.get("space_used"))
                        )

                    if selected_size >= remaining:
                        raise HTTPException(
                            413,
                            f"Selected files require {selected_size} bytes but only {remaining} bytes remain in Seedr."
                        )
            except HTTPException:
                raise
            except Exception as exc:
                # A temporary quota lookup failure should not block a request
                # that the frontend already classified for Seedr.
                print(f"[SEEDR] quota recheck failed: {exc}")

        # The qBittorrent metadata-only torrent is only a temporary
        # inspection helper. Once Seedr is selected, remove that preview
        # immediately so it never appears as a real paused download.
        if existing_hash:
            try:
                await qbt.delete(existing_hash, delete_files=False)
            except Exception:
                # The preview may already have disappeared; Seedr should not
                # fail just because cleanup was unsuccessful.
                pass

        if seedr_task_id:
            selection_applied = False
            selection_error = None
            if manifest:
                try:
                    # Apply the same file ordering used by the selector UI to
                    # the already-created Seedr task.
                    await _seedr_set_unwanted(seedr_task_id, len(manifest), selected_ids)
                    selection_applied = True
                except Exception as exc:
                    selection_error = str(exc)

            seedr_folder_name = await _seedr_folder_name(seedr_task_id)
            if re.fullmatch(r"[a-f0-9]{40}", seedr_folder_name, re.IGNORECASE) and torrent_name:
                seedr_folder_name = torrent_name
            if not seedr_folder_name:
                seedr_folder_name = torrent_name
            return {
                "backend": "seedr",
                "seedrTaskId": int(seedr_task_id) if seedr_task_id.isdigit() else seedr_task_id,
                "seedrResponse": {"user_torrent_id": seedr_task_id, "success": True, "reused": True},
                "seedrFolderName": seedr_folder_name,
                "seedrFolderId": str((await _seedr_task(seedr_task_id)).get("folder_created_id") or ""),
                "existingHash": existing_hash or None,
                "selectionApplied": selection_applied,
                "selectionError": selection_error,
            }

        seedr_magnet = _seedr_normalize_magnet(urls)
        info_hash = _seedr_info_hash(seedr_magnet)

        # qBittorrent metadata inspection already gives us the authoritative
        # info hash. If the browser sends a transformed/truncated magnet when
        # starting the actual Seedr download, rebuild a canonical magnet from
        # that known hash instead of rejecting an otherwise valid torrent.
        if not info_hash:
            fallback_hash = str(existing_hash or "").strip().lower()
            if re.fullmatch(r"[a-f0-9]{40}", fallback_hash):
                info_hash = fallback_hash
                seedr_magnet = f"magnet:?xt=urn:btih:{info_hash}"
                print(f"[SEEDR] using inspected qBittorrent hash for Seedr: {info_hash}")
            else:
                source_text = str(urls or "").strip()
                print(
                    "[SEEDR] magnet validation failed: "
                    f"starts_magnet={bool(re.match(r'^magnet:', source_text, re.IGNORECASE))} "
                    f"length={len(source_text)}"
                )
                raise HTTPException(400, "Seedr requires a valid magnet link with a BTIH info hash")
        print(f"[SEEDR] normalized magnet hash={info_hash}")
        seedr_result = await _seedr_find_task_by_hash(info_hash)
        if not seedr_result:
            seedr_result = await _seedr_add_task(
            seedr_magnet,
            int(SEEDR_LIBRARY_FOLDER_ID),
        )
        if not isinstance(seedr_result, dict):
            raise HTTPException(502, "Seedr did not return a valid task response")

        task_id = str(
            seedr_result.get("user_torrent_id")
            or seedr_result.get("id")
            or seedr_result.get("task_id")
            or ""
        )
        if not task_id:
            raise HTTPException(502, "Seedr did not return a task id")

        selection_applied = False
        selection_error = None
        if manifest:
            try:
                await _seedr_set_unwanted(task_id, len(manifest), selected_ids)
                selection_applied = True
            except Exception as exc:
                selection_error = str(exc)

        seedr_folder_name = await _seedr_folder_name(task_id)
        if re.fullmatch(r"[a-f0-9]{40}", seedr_folder_name, re.IGNORECASE) and torrent_name:
            seedr_folder_name = torrent_name
        if not seedr_folder_name:
            seedr_folder_name = torrent_name
        return {
            "backend": "seedr",
            "seedrTaskId": int(task_id) if task_id.isdigit() else task_id,
            "seedrResponse": seedr_result,
            "seedrFolderName": seedr_folder_name,
            "seedrFolderId": str(seedr_result.get("folder_created_id") or ""),
            "existingHash": existing_hash or None,
            "selectionApplied": selection_applied,
            "selectionError": selection_error,
        }

    # Magnet inspection creates a stopped metadata-only torrent. Reuse that
    # exact hash instead of adding the magnet again (which qBittorrent rejects
    # with Conflict), apply the user's file selection, then resume it.
    if existing_hash:
        await qbt.set_file_priorities(existing_hash, manifest, selected_ids)
        await qbt.resume(existing_hash)
        return {
            "backend": "qbittorrent",
            "seedrTaskId": None,
            "existingHash": existing_hash,
            "selectedNames": body.get("selectedNames") or [],
        }

    result = await qbt.add(
        urls,
        savepath="/downloads",
        autoTMM="false",
        category=body.get("category") or "Downloads",
    )
    return {"backend": "qbittorrent", "qbtResponse": result, "selectedNames": body.get("selectedNames") or []}


@app.post("/api/v2/torrents/inspect-magnet")
async def inspect_magnet(body: dict[str, Any]):
    magnet = str(body.get("magnet") or body.get("urls") or "").strip()
    if not magnet:
        raise HTTPException(400, "magnet is required")
    return await qbt.inspect_magnet(magnet, str(body.get("category") or "Downloads"))


@app.post("/api/v2/torrents/upload-torrent")
async def upload_torrent(body: dict[str, Any]):
    import bencodepy

    encoded = str(body.get("base64") or "")
    filename = str(body.get("filename") or "upload.torrent")
    if not encoded:
        raise HTTPException(400, "base64 is required")
    try:
        data = base64.b64decode(encoded)
        decoded = bencodepy.decode(data)
        info = decoded[b"info"]
        info_hash = hashlib.sha1(bencodepy.encode(info)).hexdigest()
        name_value = info.get(b"name") or b"Torrent"
        name = name_value.decode("utf-8", errors="replace") if isinstance(name_value, bytes) else str(name_value)
        raw_files = info.get(b"files")
        entries = []
        if raw_files:
            for index, item in enumerate(raw_files):
                parts = item.get(b"path") or []
                parts = [p.decode("utf-8", errors="replace") if isinstance(p, bytes) else str(p) for p in parts]
                relative = "/".join(parts)
                entries.append({"index": index, "name": relative, "size": int(item.get(b"length", 0)), "path": relative, "type": file_type(relative), "priority": 1})
        else:
            entries.append({"index": 0, "name": name, "size": int(info.get(b"length", 0)), "path": name, "type": file_type(name), "priority": 1})
    except Exception as exc:
        raise HTTPException(400, "Invalid torrent descriptor") from exc

    response = await qbt.request(
        "POST", "/api/v2/torrents/add",
        files={"torrents": (filename, data, "application/x-bittorrent")},
        data={"savepath": "/downloads", "autoTMM": "false", "paused": "true"},
    )
    if response.status_code >= 400 and response.status_code != 409:
        raise HTTPException(response.status_code, response.text)

    return {
        "name": name,
        "hash": info_hash,
        "files": entries,
        "totalSize": sum(x["size"] for x in entries),
        "magnetUri": f"magnet:?xt=urn:btih:{info_hash}&dn={quote(name)}",
    }


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
    query = " ".join(q.strip().split())
    if not query:
        return {"results": []}

    # Cache successful Prowlarr searches so repeated queries do not hit every
    # indexer again. The cache is persisted in /storage/meta and survives app
    # restarts/deployments when the existing app-meta volume is retained.
    cache_key = f"{query.lower()}::{min(max(limit, 1), 50)}"
    now = time.time()
    cache = read_json(SEARCH_CACHE_FILE, {})
    if not isinstance(cache, dict):
        cache = {}

    cached = cache.get(cache_key)
    if isinstance(cached, dict):
        cached_at = float(cached.get("cachedAt") or 0)
        cached_results = cached.get("results")
        if now - cached_at < SEARCH_CACHE_TTL_SECONDS and isinstance(cached_results, list):
            searches = read_json(RECENT_SEARCHES_FILE, [])
            write_json(RECENT_SEARCHES_FILE, [query] + [x for x in searches if x != query][:9])
            return {"results": cached_results, "cached": True}

    result = await prowlarr_search(query, limit)

    # Do not cache empty results. Indexers can temporarily return no
    # results, and caching that response would make a later successful search
    # look empty until the TTL expires.
    if result:
        cache[cache_key] = {
            "cachedAt": now,
            "results": result,
        }

    # Keep the newest entries only so search caching cannot grow without
    # bounds. Expired entries are discarded while we trim the cache.
    fresh_cache = {}
    for key, entry in sorted(
        cache.items(),
        key=lambda item: float(item[1].get("cachedAt") or 0)
        if isinstance(item[1], dict) else 0,
        reverse=True,
    ):
        if not isinstance(entry, dict):
            continue
        cached_at = float(entry.get("cachedAt") or 0)
        if now - cached_at < SEARCH_CACHE_TTL_SECONDS:
            fresh_cache[key] = entry
        if len(fresh_cache) >= SEARCH_CACHE_MAX_ENTRIES:
            break
    write_json(SEARCH_CACHE_FILE, fresh_cache)

    searches = read_json(RECENT_SEARCHES_FILE, [])
    write_json(RECENT_SEARCHES_FILE, [query] + [x for x in searches if x != query][:9])
    return {"results": result, "cached": False}


@app.get("/api/files")
async def files_list(folder: str = "/", search: str = "", type: str = "all"):
    files = scan_files()
    folder_value = folder or "/"
    search_value = search.strip().lower()
    type_value = type.strip().lower()
    if folder_value != "/":
        files = [item for item in files if item.get("folder") == folder_value]
    if search_value:
        files = [item for item in files if search_value in item.get("name", "").lower()]
    if type_value and type_value != "all":
        files = [item for item in files if item.get("type") == type_value]
    return files


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
    percentage = round((used / usage.total) * 100, 2) if usage.total else 0
    try:
        torrents = await qbt.torrents_info()
        torrent_count = len(torrents)
    except Exception:
        torrent_count = 0
    file_count = len(scan_files())
    alert = "critical" if percentage > 90 else "warning" if percentage > 80 else "normal"
    return {
        "totalBytes": usage.total,
        "usedBytes": used,
        "freeBytes": usage.free,
        "usedPercentage": percentage,
        "filesCount": file_count,
        "torrentsCount": torrent_count,
        "isUnlimited": False,
        "serverCapacityLabel": f"{usage.total / (1024 ** 3):.1f} GB server storage",
        "alertLevel": alert,
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


# Seedr integration compatible with the verified Seedr API.
SEEDR_TOKEN = os.getenv("SEEDR_API_TOKEN", "").strip()
SEEDR_BASE = "https://www.seedr.cc/api/v0.1/p"
SEEDR_LIBRARY_FOLDER_ID = os.getenv("SEEDR_LIBRARY_FOLDER_ID", "").strip()
SEEDR_MAX_SIZE_BYTES = int(float(os.getenv("SEEDR_MAX_SIZE_GB", "5")) * 1024 * 1024 * 1024)


def _seedr_data(value: Any) -> Any:
    if isinstance(value, dict) and "data" in value:
        return value["data"]
    return value


async def seedr_request(path: str, method: str = "GET", body: Any = None, form: bool = False) -> Any:
    if not SEEDR_TOKEN:
        raise HTTPException(503, "Seedr is not configured")
    endpoint = SEEDR_BASE.rstrip("/") + "/" + str(path).lstrip("/")
    headers = {
        "Authorization": f"Bearer {SEEDR_TOKEN}",
        "Accept": "application/json",
    }
    request_kwargs: dict[str, Any] = {}
    if body is not None:
        if form:
            headers["Content-Type"] = "application/x-www-form-urlencoded"
            request_kwargs["data"] = body
        else:
            headers["Content-Type"] = "application/json"
            request_kwargs["json"] = body
    async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
        response = await client.request(method, endpoint, headers=headers, **request_kwargs)
    text = response.text
    try:
        data = response.json() if text else None
    except Exception:
        data = text
    if response.status_code >= 400:
        if isinstance(data, dict):
            message = (
                data.get("error_description")
                or data.get("reason_phrase")
                or data.get("reason")
                or data.get("message")
                or data.get("error")
                or text
            )
            if isinstance(message, dict):
                message = (
                    message.get("message")
                    or message.get("description")
                    or message.get("error_description")
                    or str(message)
                )
        else:
            message = text

        if response.status_code == 401:
            message = str(message or "Seedr token is expired or invalid")
        elif response.status_code in (402, 403):
            message = str(message or "Seedr requires a premium plan for this operation")
        elif response.status_code == 429:
            retry_after = response.headers.get("Retry-After")
            if retry_after:
                message = f"{message or 'Seedr rate limit exceeded'} (retry after {retry_after}s)"

        print(
            f"[SEEDR] {method} {path} -> HTTP {response.status_code}: "
            f"{str(message or 'Seedr API request failed')}"
        )
        raise HTTPException(response.status_code, str(message or "Seedr API request failed"))

    # Some V2 endpoints return HTTP 200 with a soft failure encoded in the
    # reason_phrase/error fields instead of using a 4xx status.
    if isinstance(data, dict):
        soft_error = str(data.get("reason_phrase") or data.get("error") or "").strip()
        if soft_error and not (
            data.get("success") is True
            or data.get("result") is True
            or data.get("user_torrent_id") is not None
            or data.get("id") is not None
            or data.get("task_id") is not None
        ):
            if soft_error in {"not_enough_space", "not_enough_space_added_to_wishlist"}:
                raise HTTPException(413, "Not enough storage space in your Seedr account.")
            if soft_error in {"queue_full", "queue_full_added_to_wishlist"}:
                raise HTTPException(409, "Seedr download queue is full. Please wait for the current download to finish.")
            raise HTTPException(502, f"Seedr rejected the request: {soft_error}")

    return data


def _seedr_array(value: Any, keys: tuple[str, ...] = ()) -> list[dict[str, Any]]:
    data = _seedr_data(value)
    if isinstance(data, list):
        return data
    if not isinstance(data, dict):
        return []
    for key in keys:
        candidate = data.get(key)
        if isinstance(candidate, list):
            return candidate
        if isinstance(candidate, dict):
            nested = _seedr_array(candidate, keys)
            if nested:
                return nested
    for key in ("contents", "items", "data"):
        candidate = data.get(key)
        if isinstance(candidate, list):
            return candidate
    return []


def _seedr_file(file: dict[str, Any], folder_id: str = "") -> dict[str, Any]:
    return {
        "id": str(file.get("id") or file.get("file_id") or file.get("folder_file_id") or ""),
        "name": str(file.get("name") or file.get("filename") or file.get("path") or ""),
        "size": int(file.get("size") or file.get("length") or 0),
        "folderId": str(file.get("folder_id") or file.get("folderId") or folder_id),
    }


def _seedr_folder(folder: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(folder.get("id") or folder.get("folder_id") or ""),
        "name": str(folder.get("name") or folder.get("title") or folder.get("path") or "Folder"),
    }


def _seedr_progress_value(value: Any, depth: int = 0) -> float | None:
    if value is None or depth > 6:
        return None
    if isinstance(value, (int, float)):
        number = float(value)
        return number * 100 if 0 <= number <= 1 else number
    if isinstance(value, str):
        try:
            number = float(value.strip().rstrip("%"))
            return number * 100 if 0 <= number <= 1 else number
        except ValueError:
            return None
    if not isinstance(value, dict):
        return None

    # Seedr progress payloads can contain both a top-level progress value and
    # a nested stats.progress value. The top-level value may legitimately be
    # 0 while the nested live value has advanced, so don't let a zero/empty
    # field mask a more useful nested progress reading.
    zero_result: float | None = None
    for key in (
        "progress", "percent", "percentage", "progress_percent",
        "progressPercentage", "downloaded_percent", "downloadedPercent",
        "completed_percent", "completedPercent",
    ):
        if key in value:
            result = _seedr_progress_value(value[key], depth + 1)
            if result is not None:
                if result > 0:
                    return result
                if zero_result is None:
                    zero_result = result

    try:
        downloaded = float(
            value.get("downloaded")
            or value.get("downloaded_bytes")
            or value.get("bytes_downloaded")
            or 0
        )
        size = float(
            value.get("size")
            or value.get("total_size")
            or value.get("total_bytes")
            or 0
        )
        if downloaded >= 0 and size > 0:
            result = downloaded / size * 100
            if result > 0:
                return result
            if zero_result is None:
                zero_result = result
    except (TypeError, ValueError):
        pass

    for key, child in value.items():
        key_lower = str(key).lower()
        if (
            "progress" in key_lower
            or "percent" in key_lower
            or key_lower in {"stats", "torrent_progress"}
        ):
            result = _seedr_progress_value(child, depth + 1)
            if result is not None:
                if result > 0:
                    return result
                if zero_result is None:
                    zero_result = result

    return zero_result


def _seedr_normalize_magnet(magnet: str) -> str:
    value = re.sub(r"[\r\n\t]+", "", str(magnet or "").strip())
    if not value:
        return value

    # Some clipboard/indexer paths URL-encode the complete magnet URI.
    decoded_value = unquote(value)
    if re.match(r"^magnet:\?", decoded_value, re.IGNORECASE):
        value = decoded_value
    elif not re.match(r"^magnet:\?", value, re.IGNORECASE):
        return value

    # Normalize percent-encoded xt values and 32-character Base32 BTIH values
    # into the 40-character hexadecimal form Seedr accepts.
    try:
        parsed = urlsplit(value)
        params = parse_qs(parsed.query, keep_blank_values=True)
        xt_values = params.get("xt") or []
        btih_value = ""

        for raw_xt in xt_values:
            decoded_xt = unquote(str(raw_xt)).strip()
            match = re.fullmatch(r"urn:btih:([A-Za-z0-9]{32,40})", decoded_xt, re.IGNORECASE)
            if match:
                btih_value = match.group(1)
                break

        # Fallback for unusual magnets whose query encoding defeats parse_qs.
        if not btih_value:
            match = re.search(r"urn:btih:([A-Za-z0-9]{32,40})", unquote(value), re.IGNORECASE)
            if match:
                btih_value = match.group(1)

        if not btih_value:
            return value

        if len(btih_value) == 32 and re.fullmatch(r"[A-Z2-7a-z2-7]{32}", btih_value):
            try:
                padded = btih_value.upper() + "=" * ((8 - len(btih_value) % 8) % 8)
                btih_value = base64.b32decode(padded).hex()
            except Exception:
                return value
        elif len(btih_value) != 40 or not re.fullmatch(r"[A-Fa-f0-9]{40}", btih_value):
            return value

        # Preserve all original query parameters while replacing the first
        # BTIH xt value with the canonical raw urn:btih:<40-hex> form.
        raw_parts = parsed.query.split("&") if parsed.query else []
        rewritten_parts: list[str] = []
        replaced = False
        for part in raw_parts:
            raw_key, separator, raw_value = part.partition("=")
            key = unquote(raw_key).strip().lower()
            decoded_value = unquote(raw_value).strip()
            if key == "xt" and not replaced and re.fullmatch(
                r"urn:btih:[A-Za-z0-9]{32,40}", decoded_value, re.IGNORECASE
            ):
                rewritten_parts.append(f"{raw_key or 'xt'}=urn:btih:{btih_value.lower()}")
                replaced = True
            else:
                rewritten_parts.append(part if separator else raw_key)

        if replaced:
            return "magnet:?" + "&".join(rewritten_parts)

        # Hash was found, but the xt parameter is unusual. Use a minimal
        # canonical URI rather than passing a parser-hostile magnet to Seedr.
        return f"magnet:?xt=urn:btih:{btih_value.lower()}"
    except Exception:
        return value


def _seedr_info_hash(magnet: str) -> str:
    # Be deliberately permissive when extracting the hash. The input may be
    # a normal magnet, a percent-encoded magnet, or a wrapper URL that has
    # already encoded the magnet query string.
    candidates: list[str] = []
    current = str(magnet or "").strip()
    for _ in range(3):
        if not current:
            break
        candidates.append(current)
        decoded = unquote(current)
        if decoded == current:
            break
        current = decoded

    for candidate in candidates:
        match = re.search(
            r"(?:urn:btih:|btih:)([A-Za-z0-9]{32,40})",
            candidate,
            re.IGNORECASE,
        )
        if match:
            value = match.group(1)
            if len(value) == 40 and re.fullmatch(r"[A-Fa-f0-9]{40}", value):
                return value.lower()
            if len(value) == 32 and re.fullmatch(r"[A-Z2-7a-z2-7]{32}", value):
                try:
                    padded = value.upper() + "=" * ((8 - len(value) % 8) % 8)
                    return base64.b32decode(padded).hex()
                except Exception:
                    pass

    normalized = _seedr_normalize_magnet(magnet)
    match = re.search(r"urn:btih:([A-Fa-z0-9]{40})", normalized, re.IGNORECASE)
    return match.group(1).lower() if match else ""


async def _seedr_add_task(magnet: str, folder_id: int) -> dict[str, Any]:
    normalized = _seedr_normalize_magnet(magnet)
    try:
        result = _seedr_data(await seedr_request(
            "/tasks",
            "POST",
            {"torrent_magnet": normalized, "folder_id": folder_id},
            form=True,
        ))
        if isinstance(result, dict):
            return result
        raise HTTPException(502, "Seedr did not return a valid task response")
    except HTTPException as exc:
        # Some Seedr deployments reject otherwise valid magnets when tracker,
        # display-name, or query encoding is unusual. Retry only that exact
        # parser rejection with a minimal canonical BTIH URI.
        info_hash = _seedr_info_hash(normalized)
        if (
            exc.status_code == 400
            and "badly formatted magnet link" in str(exc.detail).lower()
            and info_hash
        ):
            fallback = f"magnet:?xt=urn:btih:{info_hash.lower()}"
            if fallback != normalized:
                print(f"[SEEDR] retrying task creation with canonical BTIH magnet hash={info_hash}")
                result = _seedr_data(await seedr_request(
                    "/tasks",
                    "POST",
                    {"torrent_magnet": fallback, "folder_id": folder_id},
                    form=True,
                ))
                if isinstance(result, dict):
                    return result
                raise HTTPException(502, "Seedr did not return a valid task response")
        raise


def _seedr_task_info_hash(task: dict[str, Any]) -> str:
    if not isinstance(task, dict):
        return ""

    nested = task.get("task") if isinstance(task.get("task"), dict) else {}
    torrent_payload = task.get("torrent_payload") if isinstance(task.get("torrent_payload"), dict) else {}
    nested_payload = nested.get("torrent_payload") if isinstance(nested.get("torrent_payload"), dict) else {}

    for value in (
        torrent_payload.get("hash"),
        task.get("torrent_hash"),
        task.get("hash"),
        task.get("info_hash"),
        nested_payload.get("hash"),
        nested.get("torrent_hash"),
        nested.get("hash"),
        nested.get("info_hash"),
        task.get("url"),
        task.get("torrent_url"),
        nested.get("url"),
        nested.get("torrent_url"),
    ):
        candidate = str(value or "").strip()
        if not candidate:
            continue
        extracted = _seedr_info_hash(candidate)
        if extracted:
            return extracted
        if re.fullmatch(r"[a-fA-F0-9]{32,40}", candidate):
            return candidate.lower()

    return ""


async def _seedr_find_task_by_hash(info_hash: str) -> dict[str, Any] | None:
    target = str(info_hash or "").strip().lower()
    if not target:
        return None

    payload = await seedr_request("/tasks")
    tasks = _seedr_array(payload, ("tasks", "torrents"))

    for raw in tasks:
        task = _seedr_data(raw)
        if not isinstance(task, dict):
            continue
        if _seedr_task_info_hash(task) != target:
            continue

        # Seedr keeps completed task records even after the downloaded files
        # have been deleted from the filesystem. Reusing such a stale task
        # makes the subsequent /unwanted call fail with "torrent_already_downloaded"
        # and prevents the same magnet from being added again.
        if _seedr_task_complete(task):
            folder_created_id = str(task.get("folder_created_id") or "").strip()
            if not folder_created_id:
                print(
                    f"[SEEDR] ignoring stale completed task "
                    f"{task.get('user_torrent_id') or task.get('id') or 'unknown'}: "
                    "no created folder"
                )
                continue

            try:
                folder_payload = _seedr_data(
                    await seedr_request(
                        f"/fs/folder/{quote(folder_created_id)}/contents"
                    )
                )
                if not isinstance(folder_payload, dict):
                    continue

                folder_files = _seedr_array(folder_payload, ("files", "items"))
                folder_children = _seedr_array(
                    folder_payload, ("folders", "directories")
                )
                if not folder_files and not folder_children:
                    print(
                        f"[SEEDR] ignoring stale completed task "
                        f"{task.get('user_torrent_id') or task.get('id') or 'unknown'}: "
                        f"created folder {folder_created_id} is empty"
                    )
                    continue
            except HTTPException as exc:
                if exc.status_code == 404:
                    print(
                        f"[SEEDR] ignoring stale completed task "
                        f"{task.get('user_torrent_id') or task.get('id') or 'unknown'}: "
                        f"created folder {folder_created_id} no longer exists"
                    )
                    continue
                raise

        return task

    return None

def _seedr_task_complete(task: dict[str, Any]) -> bool:
    if not isinstance(task, dict):
        return False
    nested = task.get("task") if isinstance(task.get("task"), dict) else {}
    state = str(
        task.get("state") or task.get("status") or
        nested.get("state") or nested.get("status") or ""
    ).lower()
    progress = _seedr_progress_value(
        task.get("progress") if task.get("progress") is not None else nested.get("progress")
    )
    return state in {
        "finished", "completed", "complete", "seeding", "stopped", "idle"
    } or (progress is not None and progress >= 100)


async def _seedr_task(task_id: str) -> Any:
    return await seedr_request(f"/tasks/{quote(str(task_id))}")


async def _seedr_folder_name(folder_id: str) -> str:
    """Resolve the actual Seedr-created folder name from filesystem metadata."""
    folder_id = str(folder_id or "").strip()
    if not folder_id:
        return ""

    payloads: list[Any] = []
    # Try the folder resource first; some Seedr V2 deployments put the folder
    # metadata there, while others include it with the contents response.
    for endpoint in (
        f"/fs/folder/{quote(folder_id)}",
        f"/fs/folder/{quote(folder_id)}/contents",
    ):
        try:
            payloads.append(_seedr_data(await seedr_request(endpoint)))
        except HTTPException:
            continue

    def direct_name(value: Any) -> str:
        if not isinstance(value, dict):
            return ""
        object_id = str(
            value.get("id")
            or value.get("folder_id")
            or value.get("folderId")
            or ""
        ).strip()
        for key in ("name", "title", "folder_name", "folderName", "path"):
            name = str(value.get(key) or "").strip()
            if name and (object_id == folder_id or not object_id):
                return Path(name.rstrip("/")).name
        return ""

    for payload in payloads:
        if not isinstance(payload, dict):
            continue

        found = direct_name(payload)
        if found:
            return found

        for key in ("folder", "directory", "folder_info", "folderInfo"):
            child = payload.get(key)
            found = direct_name(child)
            if found:
                return found

        data = payload.get("data")
        if isinstance(data, dict):
            found = direct_name(data)
            if found:
                return found
            for key in ("folder", "directory", "folder_info", "folderInfo"):
                found = direct_name(data.get(key))
                if found:
                    return found

    return ""


async def _seedr_task_from_list(task_id: str) -> dict[str, Any]:
    """Find a task anywhere in Seedr's transfer-list response.

    Seedr's V2 response shape has changed between deployments, so do not
    assume the collection is always under a particular top-level key.
    """
    target = str(task_id or "").strip()
    if not target:
        return {}

    try:
        payload = await seedr_request("/tasks")
    except HTTPException:
        return {}

    id_keys = ("user_torrent_id", "torrent_id", "task_id", "id")
    seen: set[int] = set()

    def walk(value: Any) -> dict[str, Any]:
        if isinstance(value, dict):
            object_id = id(value)
            if object_id in seen:
                return {}
            seen.add(object_id)

            for key in id_keys:
                candidate = str(value.get(key) or "").strip()
                if candidate == target:
                    return value

            for child in value.values():
                found = walk(child)
                if found:
                    return found

        elif isinstance(value, list):
            for child in value:
                found = walk(child)
                if found:
                    return found

        return {}

    return walk(_seedr_data(payload))


async def _seedr_task_contents(task_id: str) -> list[dict[str, Any]]:
    payload = _seedr_data(await seedr_request(f"/tasks/{quote(str(task_id))}/contents"))
    if not isinstance(payload, dict):
        return []

    raw_files = _seedr_array(payload, ("files", "items"))
    normalized = [_seedr_file(item) for item in raw_files]

    # Seedr's task-contents response may expose file metadata without the
    # permanent filesystem file id. Once the task has completed, the
    # task-created folder contains the same files with their real ids.
    # Follow that folder so downloads and playback can resolve the file.
    missing_id = any(not item.get("id") for item in normalized)
    folder_created_id = str(payload.get("folder_created_id") or "").strip()
    if folder_created_id and (missing_id or not normalized):
        try:
            folder_payload = _seedr_data(
                await seedr_request(
                    f"/fs/folder/{quote(folder_created_id)}/contents"
                )
            )
            folder_files = _seedr_array(folder_payload, ("files", "items"))
            if folder_files:
                return [
                    _seedr_file(item, folder_created_id)
                    for item in folder_files
                ]
        except HTTPException:
            # Keep the task-contents metadata if the folder is temporarily
            # unavailable. The caller can retry on the next poll.
            pass

    return normalized


async def _seedr_download_url(file_id: str) -> dict[str, str]:
    payload = _seedr_data(await seedr_request(f"/download/file/{quote(str(file_id))}/url"))
    if isinstance(payload, dict):
        url = str(
            payload.get("url")
            or payload.get("download_url")
            or payload.get("downloadUrl")
            or payload.get("direct_url")
            or payload.get("directUrl")
            or ""
        )
        name = str(payload.get("name") or payload.get("filename") or "")
    else:
        url, name = str(payload or ""), ""
    if not url:
        raise HTTPException(502, "Seedr did not return a download URL")
    return {"url": url, "name": name}


async def _seedr_file_details(file_id: str) -> dict[str, Any]:
    payload = _seedr_data(await seedr_request(f"/fs/file/{quote(str(file_id))}"))
    return payload if isinstance(payload, dict) else {}


async def _seedr_progress(task_id: str, task: dict[str, Any]) -> tuple[float, dict[str, Any]]:
    # The task object can lag behind Seedr's dedicated live-progress endpoint.
    # Always consult /progress first for the freshest percentage, but never
    # let a stale progress payload overwrite a terminal state from /tasks/:id.
    direct = _seedr_progress_value(task.get("progress"))

    # /tasks/:id is authoritative for terminal state. If it already says the
    # task is complete, report 100% immediately even when /progress still says
    # 99% for a short time.
    if _seedr_task_complete(task):
        return 100.0, task

    try:
        result = _seedr_data(await seedr_request(f"/tasks/{quote(str(task_id))}/progress"))
        progress_url = ""
        direct_progress = _seedr_progress_value(result)
        if direct_progress is not None and direct_progress > 0:
            # Some Seedr responses include the actual progress value directly,
            # without requiring a second request to the polling URL.
            return min(100, max(0, direct_progress)), {**task, **(result if isinstance(result, dict) else {})}

        if isinstance(result, str):
            # Seedr may return the polling URL directly as a JSON string.
            progress_url = result.strip().strip('"')
        elif isinstance(result, dict):
            progress_url = str(
                result.get("url")
                or result.get("progress_url")
                or result.get("progressUrl")
                or ""
            )

        # The polling URL can be absolute, protocol-relative, or a relative
        # path. Normalize it against the Seedr API base before requesting it.
        if progress_url:
            if progress_url.startswith("//"):
                progress_url = "https:" + progress_url
            elif progress_url.startswith("/"):
                progress_url = urljoin(SEEDR_BASE.rstrip("/") + "/", progress_url.lstrip("/"))
            elif not re.match(r"^https?://", progress_url, re.IGNORECASE):
                progress_url = urljoin(SEEDR_BASE.rstrip("/") + "/", progress_url)
            async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
                response = await client.get(
                    progress_url,
                    headers={"Accept": "application/json, text/plain, */*"}
                )
            if response.status_code < 400:
                text = response.text
                try:
                    progress_data = response.json() if text else {}
                except Exception:
                    progress_data = {}
                    left, right = text.find("{"), text.rfind("}")
                    if left >= 0 and right > left:
                        try:
                            progress_data = json.loads(text[left:right + 1])
                        except Exception:
                            pass
                live_data = _seedr_data(progress_data)
                merged = {**task, **(live_data if isinstance(live_data, dict) else {})}

                # Preserve a terminal state from either source rather than
                # allowing a stale "downloading" field to mask completion.
                if _seedr_task_complete(merged):
                    return 100.0, merged

                value = _seedr_progress_value(merged)
                if value is not None:
                    return min(100, max(0, value)), merged

        merged = {**task, **(result if isinstance(result, dict) else {})}
        if _seedr_task_complete(merged):
            return 100.0, merged
        value = _seedr_progress_value(merged)
        if value is not None:
            return min(100, max(0, value)), merged
    except Exception:
        pass

    return min(100, max(0, direct or 0)), task


async def _seedr_set_unwanted(task_id: str, file_count: int, indexes: list[int]) -> None:
    # The Seedr v0.1 endpoint expects a bitmap of *unwanted* file indices.
    # The UI supplies *selected/wanted* indices, so invert the selection
    # before encoding the bitmap.
    selected = {int(index) for index in indexes if 0 <= int(index) < file_count}
    unwanted = set(range(file_count)) - selected

    for msb_first in (False, True):
        raw = bytearray((file_count + 7) // 8)
        for index in unwanted:
            byte_index, bit_index = divmod(index, 8)
            raw[byte_index] |= 1 << (7 - bit_index if msb_first else bit_index)

        encoded = base64.b64encode(bytes(raw)).decode()
        await seedr_request(
            f"/tasks/{quote(str(task_id))}/unwanted",
            "POST",
            {"unwanted": encoded},
        )

        try:
            current = _seedr_data(
                await seedr_request(f"/tasks/{quote(str(task_id))}/unwanted"))
            encoded_current = (
                current
                if isinstance(current, str)
                else (current or {}).get("unwanted")
            )
            if encoded_current:
                decoded = base64.b64decode(encoded_current)
                actual = {
                    index
                    for index in range(file_count)
                    if decoded[index // 8]
                    & (1 << (7 - (index % 8) if msb_first else index % 8))
                }
                if actual == unwanted:
                    return
        except Exception:
            pass

    raise HTTPException(502, "Seedr did not preserve the requested file selection")


async def _seedr_collect(folder_id: str, folder_path: str = "/", depth: int = 0) -> list[dict[str, Any]]:
    if depth > 8:
        return []
    try:
        payload = _seedr_data(await seedr_request(f"/fs/folder/{quote(str(folder_id))}/contents"))
    except HTTPException as exc:
        if exc.status_code == 404:
            return []
        raise
    if not isinstance(payload, dict):
        return []
    files = [
        {**_seedr_file(item, folder_id), "folderPath": folder_path}
        for item in _seedr_array(payload, ("files", "items"))
    ]
    nested = []
    for raw in _seedr_array(payload, ("folders", "directories")):
        folder = _seedr_folder(raw)
        if folder["id"]:
            child = folder_path.rstrip("/") + "/" + folder["name"]
            nested.extend(await _seedr_collect(folder["id"], child, depth + 1))
    return files + nested


async def _seedr_find_file(file_name: str) -> dict[str, Any]:
    clean = str(file_name).strip()
    terms = [clean, Path(clean).stem, " ".join(Path(clean).stem.replace("-", " ").replace("_", " ").split()[:8])]
    last_error: Exception | None = None
    for term in dict.fromkeys(x for x in terms if x):
        try:
            result = _seedr_data(await seedr_request(f"/search/fs?query={quote(term)}"))
            files = [_seedr_file(item) for item in (result.get("files", []) if isinstance(result, dict) else [])]
            target = Path(clean).name.lower()
            exact = next((item for item in files if Path(item["name"]).name.lower() == target), None)
            if exact:
                return exact
            stem = Path(target).stem
            same_stem = next((item for item in files if Path(item["name"]).stem.lower() == stem), None)
            if same_stem:
                return same_stem
        except Exception as exc:
            last_error = exc
    if last_error:
        raise last_error
    raise HTTPException(404, f"Seedr file not found: {file_name}")


@app.get("/api/seedr/quota")
async def seedr_quota():
    if not SEEDR_TOKEN:
        return {"configured": False, "maxSpace": 0, "usedSpace": 0, "remainingSpace": 0}
    result = _seedr_data(await seedr_request("/me/quota"))
    # Seedr's v0.1 documentation defines this endpoint and purpose but does
    # not guarantee a single response-field layout. Accept the common nested
    # and flat quota layouts instead of converting an otherwise successful
    # Seedr response into a 502.
    if not isinstance(result, dict):
        raise HTTPException(502, "Seedr returned an invalid quota response")

    storage = result.get("account", {}).get("storage", {}) if isinstance(result.get("account"), dict) else {}
    if not isinstance(storage, dict) or not storage:
        storage = result.get("storage", {}) if isinstance(result.get("storage"), dict) else {}

    def first_number(*values: Any) -> int:
        for value in values:
            try:
                if value is None or value == "":
                    continue
                return max(0, int(float(value)))
            except (TypeError, ValueError):
                continue
        return 0

    max_space = first_number(
        result.get("space_max"),
        storage.get("limit"),
        storage.get("max_space"),
        storage.get("maxSpace"),
        result.get("max_space"),
        result.get("maxSpace"),
        result.get("storage_limit"),
        result.get("storageLimit"),
        result.get("quota"),
        result.get("space"),
    )
    used_space = first_number(
        result.get("space_used"),
        storage.get("used"),
        storage.get("used_space"),
        storage.get("usedSpace"),
        result.get("used_space"),
        result.get("usedSpace"),
        result.get("storage_used"),
        result.get("storageUsed"),
    )

    remaining_candidates = [
        result.get("space_remaining"),
        storage.get("remaining"),
        storage.get("remaining_space"),
        storage.get("remainingSpace"),
        result.get("remaining_space"),
        result.get("remainingSpace"),
    ]
    remaining_space = first_number(*remaining_candidates)

    # Prefer an explicit remaining value when supplied. Otherwise derive it
    # from limit-used when both are available.
    if remaining_space == 0 and max_space > used_space:
        remaining_space = max_space - used_space

    return {
        "configured": True,
        "maxSpace": max_space,
        "usedSpace": min(used_space, max_space) if max_space else used_space,
        "remainingSpace": remaining_space,
    }


@app.post("/api/seedr/tasks/prepare")
async def seedr_prepare(body: dict[str, Any]):
    magnet = str(body.get("magnet") or "").strip()
    if not magnet:
        raise HTTPException(400, "magnet is required")
    if not SEEDR_TOKEN:
        raise HTTPException(503, "Seedr is not configured")
    if not SEEDR_LIBRARY_FOLDER_ID.isdigit():
        raise HTTPException(503, "SEEDR_LIBRARY_FOLDER_ID must be configured for Torrent Studio Seedr downloads")
    seedr_magnet = _seedr_normalize_magnet(magnet)
    info_hash = _seedr_info_hash(seedr_magnet)
    if not info_hash:
        print("[SEEDR] magnet validation failed: no BTIH info hash could be extracted")
        raise HTTPException(400, "Seedr requires a valid magnet link with a BTIH info hash")
    print(f"[SEEDR] normalized magnet hash={info_hash}")
    task = await _seedr_find_task_by_hash(info_hash)
    created = False

    if not task:
        task = await _seedr_add_task(
            seedr_magnet,
            int(SEEDR_LIBRARY_FOLDER_ID),
        )
        created = True

    task_id = str(
        task.get("user_torrent_id")
        or task.get("id")
        or task.get("task_id")
        or ""
    )
    if not task_id:
        raise HTTPException(502, "Seedr did not return a task id")

    if created:
        try:
            await seedr_request(f"/tasks/{quote(task_id)}/pause", "POST")
        except HTTPException as exc:
            # Free accounts may not expose pause; the task itself is still valid.
            print(f"[SEEDR] Could not pause prepared task {task_id}: {exc.detail}")

    files: list[dict[str, Any]] = []
    for _attempt in range(10):
        try:
            files = await _seedr_task_contents(task_id)
        except HTTPException:
            files = []
        if files:
            break
        await asyncio.sleep(0.5)

    return {
        "taskId": int(task_id) if task_id.isdigit() else task_id,
        "name": str(task.get("title") or task.get("name") or task.get("torrent_name") or ""),
        "files": [{"id": f["id"], "name": f["name"], "size": f["size"]} for f in files],
        "created": created,
        "paused": created,
    }


@app.get("/api/seedr/tasks/{task_id}")
async def seedr_task(task_id: str):
    try:
        raw_task = _seedr_data(await _seedr_task(task_id))
    except HTTPException as exc:
        if exc.status_code == 404:
            # The Seedr task is gone. Returning "waiting" makes the frontend
            # poll the same stale task forever and persist it in localStorage.
            # Surface a terminal missing-task state so the UI can clear it.
            return {
                "taskId": task_id,
                "name": "",
                "status": "not_found",
                "progress": 0,
                "task": None,
                "files": [],
                "downloadUrl": None,
            }
        raise

    task = (
        raw_task.get("task")
        if isinstance(raw_task, dict) and isinstance(raw_task.get("task"), dict)
        else (raw_task if isinstance(raw_task, dict) else {})
    )

    # Seedr's /tasks/{id} response can contain live state/progress without the
    # torrent title. The list endpoint usually has the display name, so merge
    # it in to keep Torrent Studio's active download card useful even after a
    # page refresh or when the task was created before the latest frontend fix.
    task_name = str(
        task.get("name")
        or task.get("title")
        or task.get("torrent_name")
        or ""
    ).strip()
    if not task_name:
        listed_task = await _seedr_task_from_list(task_id)
        if listed_task:
            # Keep live fields from /tasks/{id}, but fill missing display
            # metadata from the transfer-list record. Do not merge the whole
            # object in the opposite direction because the list can contain
            # stale progress/state while the detail endpoint is live.
            task = dict(task)
            for key in ("name", "title", "torrent_name", "folder_created_id"):
                if not str(task.get(key) or "").strip() and str(listed_task.get(key) or "").strip():
                    task[key] = listed_task[key]

            if isinstance(raw_task, dict) and isinstance(raw_task.get("task"), dict):
                nested_task = dict(raw_task.get("task"))
                for key in ("name", "title", "torrent_name"):
                    if not str(nested_task.get(key) or "").strip() and str(listed_task.get(key) or "").strip():
                        nested_task[key] = listed_task[key]
                task["task"] = nested_task

    progress, task = await _seedr_progress(task_id, task)
    complete = _seedr_task_complete(task) or progress >= 100
    name = str(
        task.get("name")
        or task.get("title")
        or task.get("torrent_name")
        or ""
    ).strip()

    folder_id = str(task.get("folder_created_id") or "").strip()
    folder_name = await _seedr_folder_name(folder_id) if folder_id else ""
    if re.fullmatch(r"[a-f0-9]{40}", folder_name, re.IGNORECASE):
        folder_name = name
    if not folder_name:
        folder_name = name

    # Seedr can expose filesystem entries before the overall torrent is done.
    # Return those entries while the task is still downloading so the UI can
    # show a file/folder immediately and reveal file actions as files become
    # available.
    try:
        candidates = await _seedr_task_contents(task_id)
    except HTTPException as exc:
        if exc.status_code == 404:
            candidates = []
        else:
            raise

    files: list[dict[str, Any]] = []
    for file in candidates[:50]:
        file_id = str(file.get("id") or "").strip()
        if not file_id:
            continue

        download_url: str | None = None
        try:
            download = await _seedr_download_url(file_id)
            download_url = str(download.get("url") or "").strip() or None
        except Exception:
            # A file can already exist in Seedr's folder while its final
            # download URL is not available yet. Keep showing the file and
            # expose its actions on a later poll when the URL becomes ready.
            pass

        files.append({
            "id": file_id,
            "name": str(file.get("name") or ""),
            "size": int(file.get("size") or 0),
            "folderId": str(file.get("folderId") or ""),
            "folderPath": str(file.get("folderPath") or "/Torrent Studio"),
            "url": download_url,
            "available": download_url is not None,
        })

    if not complete:
        return {
            "taskId": task_id,
            "name": name,
            "folderName": folder_name,
            "folderId": folder_id,
            "status": "downloading",
            "progress": min(progress, 99.9),
            "task": task,
            "files": files,
            "downloadUrl": next((item["url"] for item in files if item.get("url")), None),
        }

    if not files:
        return {
            "taskId": task_id,
            "name": name,
            "status": "downloading",
            "progress": min(progress, 99.9),
            "task": task,
            "files": [],
            "downloadUrl": None,
        }

    return {
        "taskId": task_id,
        "name": name,
        "folderName": folder_name,
        "folderId": folder_id,
        "status": "completed",
        "progress": 100,
        "task": task,
        "files": files,
        "downloadUrl": next((item["url"] for item in files if item.get("url")), None),
    }


@app.get("/api/seedr/files")
async def seedr_files():
    if not SEEDR_TOKEN:
        return {"configured": False, "files": []}
    if not SEEDR_LIBRARY_FOLDER_ID.isdigit():
        return {"configured": True, "files": []}
    folder_targets: list[tuple[str, str]] = [(SEEDR_LIBRARY_FOLDER_ID, "/Torrent Studio")]
    try:
        tasks = _seedr_array(await seedr_request("/tasks"), ("tasks", "torrents"))
        for raw in tasks:
            task = _seedr_data(raw)
            if not isinstance(task, dict) or str(task.get("folder_id") or "") != SEEDR_LIBRARY_FOLDER_ID:
                continue
            if not _seedr_task_complete(task):
                continue
            created = str(task.get("folder_created_id") or "").strip()
            if created:
                folder_name = await _seedr_folder_name(created)
                task_name = str(
                    task.get("name")
                    or task.get("title")
                    or task.get("torrent_name")
                    or ""
                ).strip()
                if re.fullmatch(r"[a-f0-9]{40}", folder_name, re.IGNORECASE):
                    folder_name = ""
                display_name = folder_name or task_name or created
                folder_targets.append(
                    (created, "/Torrent Studio/" + display_name)
                )
    except Exception:
        pass
    files: list[dict[str, Any]] = []
    seen: set[str] = set()
    for folder_id, folder_path in dict.fromkeys(folder_targets):
        for item in await _seedr_collect(folder_id, folder_path):
            key = item["id"] or f'{item["folderId"]}:{item["folderPath"]}:{item["name"]}'
            if key not in seen:
                seen.add(key)
                files.append(item)
    return {"configured": True, "files": files}


@app.get("/api/seedr/files/{file_id}/download")
async def seedr_file_download(file_id: str):
    return await _seedr_download_url(file_id)


@app.get("/api/seedr/files/stream")
async def seedr_file_stream(name: str = Query(...), type: str = Query("video")):
    if not SEEDR_TOKEN:
        raise HTTPException(503, "Seedr is not configured")
    file = await _seedr_find_file(name)
    result = _seedr_data(await seedr_request(f"/search/fs?query={quote(name)}"))
    candidates = result.get("files", []) if isinstance(result, dict) else []
    selected = next((item for item in candidates if str(item.get("id") or "") == file["id"]), None)
    urls = (selected or {}).get("presentation_urls") or (selected or {}).get("presentationUrls") or {}
    media = urls.get(type) if isinstance(urls, dict) else {}
    if not isinstance(media, dict):
        media = {}
    url = str(media.get("hls") or media.get("url") or media.get("stream") or "")
    if not url:
        raise HTTPException(502, f"Seedr did not return a {type} playback URL for {file['name']}")
    return {"url": url, "name": file["name"]}


@app.delete("/api/seedr/tasks/{task_id}")
async def seedr_task_delete(task_id: str):
    if not SEEDR_TOKEN:
        raise HTTPException(503, "Seedr is not configured")

    task_id = str(task_id).strip()
    if not task_id:
        raise HTTPException(400, "Seedr task id is required")

    # Seedr's task API may expose cancellation as an action endpoint rather
    # than allowing DELETE on the task resource. Try the REST-style DELETE
    # first, then the action form when Seedr responds with 405.
    try:
        return await seedr_request(f"/tasks/{quote(task_id)}", "DELETE")
    except HTTPException as exc:
        if exc.status_code == 404:
            return {"success": True, "alreadyGone": True, "taskId": task_id}
        if exc.status_code != 405:
            raise

    try:
        return await seedr_request(f"/tasks/{quote(task_id)}/delete", "POST")
    except HTTPException as exc:
        if exc.status_code == 404:
            return {"success": True, "alreadyGone": True, "taskId": task_id}
        raise


@app.delete("/api/seedr/files/{file_id}")
async def seedr_file_delete(file_id: str):
    return await seedr_request(f"/fs/file/{quote(str(file_id))}", "DELETE")


@app.get("/api/seedr/folders/{folder_id}/download")
async def seedr_folder_download(folder_id: str):
    archive_id = str(uuid.uuid4())
    result = _seedr_data(await seedr_request(
        f"/download/archive/init/{archive_id}",
        "PUT",
        {"archive_arr": [{"type": "folder", "id": int(folder_id)}]},
    ))
    if isinstance(result, dict):
        url = str(result.get("url") or result.get("download_url") or result.get("downloadUrl") or result.get("signed_url") or result.get("signedUrl") or "")
    else:
        url = str(result or "")
    if not url:
        raise HTTPException(502, "Seedr did not return a folder download URL")
    return {"url": url}


@app.delete("/api/seedr/folders/{folder_id}")
async def seedr_folder_delete(folder_id: str):
    return await seedr_request(f"/fs/folder/{quote(str(folder_id))}", "DELETE")


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
