from __future__ import annotations

import asyncio
import importlib.util
import logging
import os
from pathlib import Path
from typing import Any

from aiohttp import web
from PIL import Image
from server import PromptServer

from .config import load_config, thumbnail_size_from_quality
from .storage import HiddenEntry, load_hidden, thumb_cache_dir, update_hidden, evict_thumb_cache
from .paths import get_output_directory, get_input_directory, get_i18n_directory, resolve_relpath, load_translation_file, LANGUAGE_CODE_RE
from .scanner import list_directory_items, _classify_kind, _placeholder_png
from .metadata import read_metadata, build_thumb_cache_key, remove_thumb_cache_entries, clear_thumb_cache
from .pagination import parse_cursor, encode_cursor, apply_cursor_filter, apply_since_filter

SEND2TRASH_AVAILABLE = importlib.util.find_spec("send2trash") is not None
if SEND2TRASH_AVAILABLE:
    import send2trash

LOGGER = logging.getLogger("assets_plus")


def _set_content_type(response: web.StreamResponse, path: Path) -> None:
    """Set Content-Type header based on file extension."""
    ext = path.suffix.lower()
    content_types = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".gif": "image/gif",
        ".bmp": "image/bmp",
        ".tiff": "image/tiff",
        ".mp4": "video/mp4",
        ".webm": "video/webm",
        ".mov": "video/quicktime",
        ".mkv": "video/x-matroska",
        ".mp3": "audio/mpeg",
        ".flac": "audio/flac",
        ".wav": "audio/wav",
        ".ogg": "audio/ogg",
        ".m4a": "audio/mp4",
        ".glb": "model/gltf-binary",
        ".gltf": "model/gltf+json",
    }
    content_type = content_types.get(ext, "application/octet-stream")
    response.headers["Content-Type"] = content_type


async def _generate_thumbnail(path: Path, width: int, height: int, cache_path: Path) -> None:
    """Generate thumbnail in thread pool with timeout."""
    def _sync_thumb() -> None:
        with Image.open(path) as image:
            image.thumbnail((width, height))
            image.save(cache_path, format="PNG")
            evict_thumb_cache()
    await asyncio.wait_for(asyncio.to_thread(_sync_thumb), timeout=30.0)


def delete_assets(
    base_dir: Path,
    relpaths: list[str],
    mode: str,
    hidden_prefix: str = "",
    thumbnail_sizes: tuple[tuple[int, int], ...] = ((256, 256), (512, 512)),
) -> tuple[list[str], list[str], dict[str, str]]:
    """Delete assets. Returns (removed, failed, actual_modes)."""
    removed: list[str] = []
    failed: list[str] = []
    actual_modes: dict[str, str] = {}
    hidden_updates: dict[str, HiddenEntry] = {}

    for relpath in relpaths:
        try:
            path = resolve_relpath(relpath, base_dir)
        except web.HTTPError:
            failed.append(relpath)
            continue
        if not path.exists():
            failed.append(relpath)
            continue
        stat = path.stat()
        remove_thumb_cache_entries(relpath, int(stat.st_mtime), stat.st_size, thumbnail_sizes)
        if mode == "hide":
            hidden_key = f"{hidden_prefix}{relpath}" if hidden_prefix else relpath
            hidden_updates[hidden_key] = HiddenEntry(
                relpath=hidden_key,
                mtime=int(stat.st_mtime),
                size=stat.st_size,
            )
            removed.append(relpath)
            continue
        try:
            if mode == "trash" and SEND2TRASH_AVAILABLE:
                send2trash.send2trash(str(path))
                actual_modes[relpath] = "trash"
            else:
                path.unlink()
                actual_modes[relpath] = "deleted_permanently" if mode == "trash" else mode
            removed.append(relpath)
        except PermissionError:
            LOGGER.warning("[Assets+ Explorer] Permission denied for %s", relpath)
            failed.append(relpath)
        except OSError:
            LOGGER.exception("Failed to remove asset %s", relpath)
            failed.append(relpath)

    if mode == "hide" and hidden_updates:
        update_hidden(lambda h: {**h, **hidden_updates})
    return removed, failed, actual_modes


def _build_list_response(base_dir: Path, hidden_prefix: str, params: dict[str, str]) -> dict[str, Any]:
    """Shared logic for output_list and input_list handlers."""
    config = load_config()

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
    cursor = parse_cursor(params.get("cursor"))
    query = params.get("query") or params.get("q")
    since_param = params.get("since")
    since = None
    if since_param is not None:
        try:
            since = int(since_param)
        except ValueError:
            since = None

    hidden = load_hidden()
    items = list_directory_items(
        base_dir, extensions, recursive, scan_depth,
        hidden=hidden, hidden_prefix=hidden_prefix, query=query,
    )
    latest_mtime = items[0]["mtime"] if items else 0

    if since is not None:
        items = apply_since_filter(items, since)
    else:
        items = apply_cursor_filter(items, cursor)

    has_more = False
    if limit:
        has_more = len(items) > limit
        items = items[:limit]

    next_cursor = encode_cursor(items[-1]) if items else params.get("cursor") or ""

    return {
        "items": items,
        "cursor": next_cursor,
        "has_more": has_more,
        "latest_mtime": latest_mtime,
    }


@PromptServer.instance.routes.get("/assets_plus/output/list")
async def output_list(request: web.Request) -> web.Response:
    params = request.rel_url.query
    LOGGER.info("Assets+ output list request params=%s", dict(params))
    result = _build_list_response(get_output_directory(), "", params)
    return web.json_response(result)


@PromptServer.instance.routes.get("/assets_plus/input/list")
async def input_list(request: web.Request) -> web.Response:
    params = request.rel_url.query
    LOGGER.info("Assets+ input list request params=%s", dict(params))
    result = _build_list_response(get_input_directory(), "input/", params)
    return web.json_response(result)


@PromptServer.instance.routes.get("/assets_plus/config")
async def assets_plus_config(_: web.Request) -> web.Response:
    config = load_config()
    thumbnail_size = thumbnail_size_from_quality(config.thumbnail_quality)
    return web.json_response(
        {
            "allowed_extensions": list(config.allowed_extensions),
            "thumbnail_quality": config.thumbnail_quality,
            "thumbnail_size": list(thumbnail_size),
            "list_limit": config.list_limit,
            "recursive": config.recursive,
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
    default_width, default_height = thumbnail_size_from_quality(config.thumbnail_quality)
    width = int(params.get("w", default_width))
    height = int(params.get("h", default_height))
    path = resolve_relpath(relpath, get_output_directory())
    if not path.exists():
        raise web.HTTPNotFound(text="Asset not found")

    if path.suffix.lower() in {".mp4", ".webm"}:
        resp = web.FileResponse(path=path)
        _set_content_type(resp, path)
        return resp

    kind = _classify_kind(path)
    if kind not in ("image",):
        placeholder = _placeholder_png(kind, width, height)
        if placeholder is None:
            raise web.HTTPInternalServerError(text="Failed to generate placeholder")
        resp = web.FileResponse(path=placeholder)
        _set_content_type(resp, placeholder)
        return resp

    stat = path.stat()
    cache_key = build_thumb_cache_key(relpath, int(stat.st_mtime), stat.st_size, width, height)
    cache_path = thumb_cache_dir() / f"{cache_key}.png"

    if cache_path.exists():
        resp = web.FileResponse(path=cache_path)
        _set_content_type(resp, cache_path)
        return resp

    try:
        await _generate_thumbnail(path, width, height, cache_path)
    except (OSError, asyncio.TimeoutError):
        placeholder = _placeholder_png("other", width, height)
        if placeholder is None:
            raise web.HTTPInternalServerError(text="Failed to generate placeholder")
        resp = web.FileResponse(path=placeholder)
        _set_content_type(resp, placeholder)
        return resp

    resp = web.FileResponse(path=cache_path)
    _set_content_type(resp, cache_path)
    return resp


@PromptServer.instance.routes.get("/assets_plus/input/thumb")
async def input_thumb(request: web.Request) -> web.StreamResponse:
    config = load_config()
    params = request.rel_url.query
    relpath = params.get("relpath")
    if not relpath:
        raise web.HTTPBadRequest(text="relpath is required")
    default_width, default_height = thumbnail_size_from_quality(config.thumbnail_quality)
    width = int(params.get("w", default_width))
    height = int(params.get("h", default_height))
    path = resolve_relpath(relpath, get_input_directory())
    if not path.exists():
        raise web.HTTPNotFound(text="Asset not found")

    if path.suffix.lower() in {".mp4", ".webm"}:
        resp = web.FileResponse(path=path)
        _set_content_type(resp, path)
        return resp

    kind = _classify_kind(path)
    if kind not in ("image",):
        placeholder = _placeholder_png(kind, width, height)
        if placeholder is None:
            raise web.HTTPInternalServerError(text="Failed to generate placeholder")
        resp = web.FileResponse(path=placeholder)
        _set_content_type(resp, placeholder)
        return resp

    stat = path.stat()
    cache_key = build_thumb_cache_key(relpath, int(stat.st_mtime), stat.st_size, width, height)
    cache_path = thumb_cache_dir() / f"{cache_key}.png"

    if cache_path.exists():
        resp = web.FileResponse(path=cache_path)
        _set_content_type(resp, cache_path)
        return resp

    try:
        await _generate_thumbnail(path, width, height, cache_path)
    except (OSError, asyncio.TimeoutError):
        placeholder = _placeholder_png("other", width, height)
        if placeholder is None:
            raise web.HTTPInternalServerError(text="Failed to generate placeholder")
        resp = web.FileResponse(path=placeholder)
        _set_content_type(resp, placeholder)
        return resp

    resp = web.FileResponse(path=cache_path)
    _set_content_type(resp, cache_path)
    return resp


@PromptServer.instance.routes.post("/assets_plus/thumb/clear")
async def clear_thumbnails(_: web.Request) -> web.Response:
    removed = clear_thumb_cache()
    LOGGER.info("[Assets+ Explorer] Cleared thumbnail cache entries=%s", removed)
    return web.json_response({"removed": removed})


@PromptServer.instance.routes.get("/assets_plus/output/meta")
async def output_meta(request: web.Request) -> web.Response:
    params = request.rel_url.query
    relpath = params.get("relpath")
    if not relpath:
        raise web.HTTPBadRequest(text="relpath is required")
    path = resolve_relpath(relpath, get_output_directory())
    if not path.exists():
        raise web.HTTPNotFound(text="Asset not found")
    metadata = read_metadata(path)
    return web.json_response({"relpath": relpath, "metadata": metadata})


@PromptServer.instance.routes.get("/assets_plus/input/meta")
async def input_meta(request: web.Request) -> web.Response:
    params = request.rel_url.query
    relpath = params.get("relpath")
    if not relpath:
        raise web.HTTPBadRequest(text="relpath is required")
    path = resolve_relpath(relpath, get_input_directory())
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

    removed, failed, actual_modes = delete_assets(get_output_directory(), relpaths, mode)
    LOGGER.info("Assets+ delete mode=%s removed=%s failed=%s", mode, removed, failed)
    return web.json_response({"removed": removed, "failed": failed, "mode": mode, "actual_modes": actual_modes})


@PromptServer.instance.routes.post("/assets_plus/input/delete")
async def input_delete(request: web.Request) -> web.Response:
    config = load_config()
    payload = await request.json()
    relpaths = payload.get("relpaths", [])
    mode = payload.get("mode") or config.default_delete_mode
    if not isinstance(relpaths, list):
        raise web.HTTPBadRequest(text="relpaths must be a list")

    removed, failed, actual_modes = delete_assets(get_input_directory(), relpaths, mode, hidden_prefix="input/")
    LOGGER.info("Assets+ input delete mode=%s removed=%s failed=%s", mode, removed, failed)
    return web.json_response({"removed": removed, "failed": failed, "mode": mode, "actual_modes": actual_modes})


@PromptServer.instance.routes.get("/assets_plus/i18n")
async def assets_plus_i18n(request: web.Request) -> web.Response:
    params = request.rel_url.query
    lang = params.get("lang")
    i18n_dir = get_i18n_directory()
    if lang:
        if not LANGUAGE_CODE_RE.match(lang):
            raise web.HTTPBadRequest(text="Invalid language code")
        translation_path = i18n_dir / f"{lang}.json"
        if not translation_path.exists():
            raise web.HTTPNotFound(text="Translation not found")
        return web.json_response(load_translation_file(translation_path))

    translations: list[dict[str, str]] = []
    if i18n_dir.exists():
        for path in sorted(i18n_dir.glob("*.json")):
            code = path.stem
            data = load_translation_file(path)
            translations.append(
                {
                    "code": code,
                    "translation-name": str(data.get("translation-name", code)),
                    "translation-author": str(data.get("translation-author", "")),
                }
            )
    return web.json_response({"translations": translations})
