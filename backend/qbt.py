import asyncio
import base64
import os
from typing import Any
from urllib.parse import urlencode

import httpx


class QBitClient:
    def __init__(self) -> None:
        self.base_url = (os.getenv("QBT_URL") or os.getenv("QBITTORRENT_URL") or "http://qbittorrent:8080").rstrip("/")
        self.username = os.getenv("QBT_USERNAME") or os.getenv("QBITTORRENT_USERNAME") or ""
        self.password = os.getenv("QBT_PASSWORD") or os.getenv("QBITTORRENT_PASSWORD") or ""
        self.api_key = os.getenv("QBT_API_KEY") or os.getenv("QBITTORRENT_API_KEY") or ""
        self.cookie = ""
        self._login_lock = asyncio.Lock()

    def configured(self) -> bool:
        return bool(self.api_key or (self.username and self.password))

    async def login(self) -> None:
        if self.api_key or self.cookie:
            return
        if not self.configured():
            raise RuntimeError("Set QBT_API_KEY or QBT_USERNAME and QBT_PASSWORD")
        async with self._login_lock:
            if self.cookie:
                return
            async with httpx.AsyncClient(timeout=20) as client:
                response = await client.post(
                    f"{self.base_url}/api/v2/auth/login",
                    data={"username": self.username, "password": self.password},
                    headers={"Referer": f"{self.base_url}/", "Origin": self.base_url},
                )
            if response.status_code >= 400:
                raise httpx.HTTPStatusError(
                    response.text or "qBittorrent login failed",
                    request=response.request,
                    response=response,
                )
            cookie = response.headers.get("set-cookie", "")
            marker = next((part for part in cookie.split(";") if part.strip().startswith("QBT_SID_")), "")
            if not marker:
                raise RuntimeError("qBittorrent login succeeded but no session cookie was returned")
            self.cookie = marker.strip()

    async def request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        await self.login()
        headers = dict(kwargs.pop("headers", {}) or {})
        headers.setdefault("Referer", f"{self.base_url}/")
        headers.setdefault("Origin", self.base_url)
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        else:
            headers["Cookie"] = self.cookie

        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
            response = await client.request(method, f"{self.base_url}{path}", headers=headers, **kwargs)

        if response.status_code == 403 and not self.api_key:
            self.cookie = ""
            await self.login()
            headers["Cookie"] = self.cookie
            async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
                response = await client.request(method, f"{self.base_url}{path}", headers=headers, **kwargs)
        return response

    async def json(self, method: str, path: str, **kwargs: Any) -> Any:
        response = await self.request(method, path, **kwargs)
        if response.status_code >= 400:
            raise RuntimeError(response.text or response.reason_phrase)
        if not response.content:
            return None
        try:
            return response.json()
        except Exception:
            return response.text

    @staticmethod
    def map_state(state: str) -> str:
        return {
            "downloading": "downloading", "stalledDL": "stalledDL",
            "pausedDL": "pausedDL", "stoppedDL": "pausedDL",
            "uploading": "uploading", "stalledUP": "uploading",
            "pausedUP": "completed", "stoppedUP": "completed",
            "checkingDL": "checkingDL", "checkingUP": "checkingDL",
            "checkingResumeData": "checkingDL", "moving": "checkingDL",
            "error": "error", "missingFiles": "error",
            "forcedDL": "downloading", "forcedUP": "uploading",
            "metaDL": "downloading", "forcedMetaDL": "downloading",
        }.get(state, state or "downloading")

    @classmethod
    def map_file(cls, f: dict[str, Any]) -> dict[str, Any]:
        return {
            "index": int(f.get("index", 0)),
            "name": f.get("name") or f.get("path") or "Unknown file",
            "size": int(f.get("size", 0)),
            "progress": float(f.get("progress", 0)),
            "priority": int(f.get("priority", 1)),
            "is_seed": bool(f.get("is_seed", False)),
            "path": f.get("name") or f.get("path") or "",
        }

    @classmethod
    def map_torrent(cls, t: dict[str, Any], files: list[dict[str, Any]] | None = None) -> dict[str, Any]:
        mapped_files = [cls.map_file(x) for x in (files if files is not None else t.get("files", []))]
        selected = sum(x["size"] for x in mapped_files if x["priority"] > 0)
        return {
            "hash": t.get("hash"),
            "name": t.get("name"),
            "size": int(t.get("size", t.get("total_size", 0))),
            "progress": float(t.get("progress", 0)),
            "dlspeed": int(t.get("dlspeed", 0)),
            "upspeed": int(t.get("upspeed", 0)),
            "priority": int(t.get("priority", 0)),
            "num_seeds": int(t.get("num_seeds", 0)),
            "num_leechs": int(t.get("num_leechs", t.get("num_leeches", 0))),
            "ratio": float(t.get("ratio", 0)),
            "eta": int(t.get("eta", -1)),
            "state": cls.map_state(str(t.get("state", ""))),
            "category": t.get("category") or "Downloads",
            "added_on": int(t.get("added_on", 0)),
            "completion_on": int(t.get("completion_on", 0)),
            "total_size": int(t.get("total_size", t.get("size", 0))),
            "selected_size": selected or int(t.get("total_size", t.get("size", 0))),
            "magnetUri": t.get("magnet_uri") or t.get("magnetUri"),
            "save_path": t.get("save_path"),
            "content_path": t.get("content_path"),
            "files": mapped_files,
        }

    async def torrents_info(self, params: dict[str, str] | None = None) -> list[dict[str, Any]]:
        query = f"?{urlencode(params or {})}" if params else ""
        torrents = await self.json("GET", f"/api/v2/torrents/info{query}") or []
        result = []
        for torrent in torrents if isinstance(torrents, list) else []:
            files = await self.torrent_files(str(torrent.get("hash", "")))
            result.append(self.map_torrent(torrent, files))
        return result

    async def torrent_files(self, torrent_hash: str) -> list[dict[str, Any]]:
        data = await self.json("GET", f"/api/v2/torrents/files?{urlencode({'hash': torrent_hash})}") or []
        return [self.map_file(x) for x in data] if isinstance(data, list) else []

    async def add(self, urls: str, **fields: Any) -> Any:
        data = {"urls": urls, **{k: str(v) for k, v in fields.items() if v is not None}}
        return await self.json("POST", "/api/v2/torrents/add", data=data)

    async def pause(self, hashes: str) -> Any:
        return await self.json("POST", "/api/v2/torrents/pause", data={"hashes": hashes})

    async def resume(self, hashes: str) -> Any:
        return await self.json("POST", "/api/v2/torrents/resume", data={"hashes": hashes})

    async def delete(self, hashes: str, delete_files: bool = False) -> Any:
        return await self.json(
            "POST", "/api/v2/torrents/delete",
            data={"hashes": hashes, "deleteFiles": str(delete_files).lower()},
        )

    async def file_priority(self, torrent_hash: str, ids: str, priority: int) -> Any:
        return await self.json(
            "POST", "/api/v2/torrents/filePrio",
            data={"hash": torrent_hash, "id": ids, "priority": str(priority)},
        )

    async def export(self, torrent_hash: str) -> bytes:
        response = await self.request("GET", f"/api/v2/torrents/export?{urlencode({'hash': torrent_hash})}")
        if response.status_code >= 400:
            raise RuntimeError(response.text or "Failed to export torrent")
        return response.content

    async def inspect_magnet(self, magnet: str, category: str = "Downloads") -> dict[str, Any]:
        await self.add(
            magnet,
            savepath="/downloads",
            autoTMM="false",
            stopCondition="MetadataReceived",
            category=category,
        )
        info_hash = self.extract_info_hash(magnet)
        for _ in range(30):
            await asyncio.sleep(1)
            torrents = await self.json("GET", f"/api/v2/torrents/info?{urlencode({'hash': info_hash})}") or []
            if torrents:
                torrent = torrents[0]
                files = await self.torrent_files(info_hash)
                if files:
                    return {
                        "name": torrent.get("name") or "Torrent",
                        "hash": info_hash,
                        "files": files,
                        "totalSize": sum(x["size"] for x in files),
                        "source": "qbt_metadata",
                        "createdPreview": True,
                    }
        return {
            "name": "Torrent",
            "hash": info_hash,
            "files": [],
            "totalSize": 0,
            "source": "qbt_metadata_pending",
            "pending": True,
            "message": "qBittorrent is still resolving the torrent metadata.",
        }

    @staticmethod
    def extract_info_hash(source: str) -> str:
        import re
        match = re.search(r"urn:btih:([a-zA-Z0-9]+)", source or "", re.I)
        return (match.group(1) if match else "").lower()

    async def health(self) -> dict[str, Any]:
        return {
            "version": await self.json("GET", "/api/v2/app/version"),
            "webapiVersion": await self.json("GET", "/api/v2/app/webapiVersion"),
        }


qbt = QBitClient()
