from __future__ import annotations

import hashlib
import json
import logging
import os
from pathlib import Path
from typing import Any

from aiohttp import web

import folder_paths
from PIL import Image
from server import PromptServer

from .config import DEFAULT_CONFIG, load_config
from .storage import HiddenEntry, load_hidden, save_hidden, thumb_cache_dir

import importlib.util

SEND2TRASH_AVAILABLE = importlib.util.find_spec("send2trash") is not None
if SEND2TRASH_AVAILABLE:
    import send2trash

LOGGER = logging.getLogger("assets_plus")


def get_output_directory() -> Path:
    return Path(folder_paths.get_output_directory())


def is_within(base: Path, path: Path) -> bool:
    try:
        base_resolved = base.resolve()
        path_resolved = path.resolve()
    except FileNotFoundError:
        base_resolved = base
        path_resolved = path
    try:
        return os.path.commonpath([base_resolved, path_resolved]) == str(base_resolved)
    except ValueError:
        return False


def resolve_relpath(relpath: str) -> Path:
    if os.path.isabs(relpath):
        raise web.HTTPBadRequest(text="Absolute paths are not allowed")
    output_dir = get_output_directory()
    candidate = output_dir / relpath
    if not is_within(output_dir, candidate):
        raise web.HTTPBadRequest(text="Path traversal detected")
    return candidate


def allowed_extension(filename: str, extensions: tuple[str, ...]) -> bool:
    return filename.lower().endswith(tuple(ext.lower() for ext in extensions))


def iter_output_files(output_dir: Path, recursive: bool, scan_depth: int | None) -> list[Path]:
    if scan_depth is None:
        return list(output_dir.rglob("*") if recursive else output_dir.glob("*"))
    files: list[Path] = []
    for root, dirs, filenames in os.walk(output_dir):
        root_path = Path(root)
        depth = len(root_path.relative_to(output_dir).parts)
        if depth > scan_depth:
            dirs[:] = []
            continue
        if depth >= scan_depth:
            dirs[:] = []
        for filename in filenames:
            files.append(root_path / filename)
    return files


def list_output_items(
    output_dir: Path,
    extensions: tuple[str, ...],
    recursive: bool,
    scan_depth: int | None,
) -> list[dict[str, Any]]:
    hidden = load_hidden()
    items: list[dict[str, Any]] = []
    for path in iter_output_files(output_dir, recursive, scan_depth):
        if not path.is_file():
            continue
        relpath = path.relative_to(output_dir).as_posix()
        if not allowed_extension(path.name, extensions):
            continue
        stat = path.stat()
        hidden_entry = hidden.get(relpath)
        if hidden_entry and hidden_entry.mtime == int(stat.st_mtime) and hidden_entry.size == stat.st_size:
            continue
        file_type = "video" if path.suffix.lower() in {".mp4", ".webm"} else "image"
        items.append(
            {
                "relpath": relpath,
                "filename": path.name,
                "mtime": int(stat.st_mtime),
                "size": stat.st_size,
                "type": file_type,
                "has_workflow": file_type == "image" and has_workflow_metadata(path),
            }
        )
    items.sort(key=lambda item: item["mtime"], reverse=True)
    return items


def has_workflow_metadata(path: Path) -> bool:
    try:
        with Image.open(path) as image:
            info = image.info or {}
    except OSError:
        return False
    return bool(info.get("workflow") or info.get("prompt"))


def read_metadata(path: Path) -> dict[str, Any]:
    try:
        with Image.open(path) as image:
            info = image.info or {}
    except OSError:
        return {}
    metadata: dict[str, Any] = {}
    for key in ("workflow", "prompt"):
        value = info.get(key)
        if value:
            metadata[key] = value
    return metadata


def build_thumb_cache_key(relpath: str, mtime: int, size: int, width: int, height: int) -> str:
    hash_input = f"{relpath}:{mtime}:{size}:{width}:{height}".encode("utf-8")
    return hashlib.sha256(hash_input).hexdigest()


@PromptServer.instance.routes.get("/assets_plus/output/list")
async def output_list(request: web.Request) -> web.Response:
    config = load_config()
    params = request.rel_url.query
    extensions_param = params.get("extensions")
    if extensions_param:
        extensions = tuple(
            ext if ext.startswith(".") else f".{ext}" for ext in extensions_param.split(",") if ext
        )
    else:
        extensions = config.allowed_extensions
    scan_depth_param = params.get("scan_depth")
    scan_depth = None
    if scan_depth_param is not None:
        try:
            scan_depth = int(scan_depth_param)
        except ValueError:
            scan_depth = config.scan_depth
    else:
        scan_depth = config.scan_depth
    if scan_depth is not None and scan_depth < 0:
        scan_depth = None
    recursive = params.get("recursive", "1") not in {"0", "false", "False"}
    limit = int(params.get("limit", config.list_limit))
    cursor = params.get("cursor")

    output_dir = get_output_directory()
    items = list_output_items(output_dir, extensions, recursive, scan_depth)
    if cursor:
        try:
            cursor_value = int(cursor)
        except ValueError:
            cursor_value = 0
        items = [item for item in items if item["mtime"] > cursor_value]
    if limit:
        items = items[:limit]
    next_cursor = str(items[0]["mtime"]) if items else cursor or "0"
    return web.json_response({"items": items, "cursor": next_cursor})


@PromptServer.instance.routes.get("/assets_plus/config")
async def assets_plus_config(_: web.Request) -> web.Response:
    config = load_config()
    return web.json_response(
        {
            "allowed_extensions": list(config.allowed_extensions),
            "thumbnail_size": list(config.thumbnail_size),
            "list_limit": config.list_limit,
            "recursive": config.recursive,
            "poll_seconds": config.poll_seconds,
            "default_delete_mode": config.default_delete_mode,
            "scan_depth": config.scan_depth,
        }
    )


@PromptServer.instance.routes.get("/assets_plus/output/thumb")
async def output_thumb(request: web.Request) -> web.StreamResponse:
    config = load_config()
    params = request.rel_url.query
    relpath = params.get("relpath")
    if not relpath:
        raise web.HTTPBadRequest(text="relpath is required")
    width = int(params.get("w", config.thumbnail_size[0]))
    height = int(params.get("h", config.thumbnail_size[1]))
    path = resolve_relpath(relpath)
    if not path.exists():
        raise web.HTTPNotFound(text="Asset not found")

    if path.suffix.lower() in {".mp4", ".webm"}:
        return web.FileResponse(path=path)

    stat = path.stat()
    cache_key = build_thumb_cache_key(relpath, int(stat.st_mtime), stat.st_size, width, height)
    cache_path = thumb_cache_dir() / f"{cache_key}.png"

    if cache_path.exists():
        return web.FileResponse(path=cache_path)

    try:
        with Image.open(path) as image:
            image.thumbnail((width, height))
            image.save(cache_path, format="PNG")
    except OSError:
        raise web.HTTPUnsupportedMediaType(text="Unsupported image")

    return web.FileResponse(path=cache_path)


@PromptServer.instance.routes.get("/assets_plus/output/meta")
async def output_meta(request: web.Request) -> web.Response:
    params = request.rel_url.query
    relpath = params.get("relpath")
    if not relpath:
        raise web.HTTPBadRequest(text="relpath is required")
    path = resolve_relpath(relpath)
    if not path.exists():
        raise web.HTTPNotFound(text="Asset not found")
    metadata = read_metadata(path)
    return web.json_response({"relpath": relpath, "metadata": metadata})


@PromptServer.instance.routes.post("/assets_plus/output/delete")
async def output_delete(request: web.Request) -> web.Response:
    config = load_config()
    payload = await request.json()
    relpaths = payload.get("relpaths", [])
    mode = payload.get("mode") or config.default_delete_mode
    if not isinstance(relpaths, list):
        raise web.HTTPBadRequest(text="relpaths must be a list")

    hidden = load_hidden()
    removed: list[str] = []
    failed: list[str] = []

    for relpath in relpaths:
        try:
            path = resolve_relpath(relpath)
        except web.HTTPError:
            failed.append(relpath)
            continue
        if not path.exists():
            failed.append(relpath)
            continue
        stat = path.stat()
        if mode == "hide":
            hidden[relpath] = HiddenEntry(relpath=relpath, mtime=int(stat.st_mtime), size=stat.st_size)
            removed.append(relpath)
            continue
        try:
            if mode == "trash" and SEND2TRASH_AVAILABLE:
                send2trash.send2trash(str(path))
            else:
                path.unlink()
            removed.append(relpath)
        except OSError:
            LOGGER.exception("Failed to remove asset %s", relpath)
            failed.append(relpath)

    save_hidden(hidden)
    LOGGER.info("Assets+ delete mode=%s removed=%s failed=%s", mode, removed, failed)
    return web.json_response({"removed": removed, "failed": failed, "mode": mode})
