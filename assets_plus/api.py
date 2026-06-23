from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import time
from pathlib import Path
from typing import Any, Generator

from aiohttp import web

import folder_paths
from PIL import Image
from server import PromptServer

from .config import load_config, thumbnail_size_from_quality
from .storage import HiddenEntry, load_hidden, thumb_cache_dir, update_hidden, evict_thumb_cache

import importlib.util

SEND2TRASH_AVAILABLE = importlib.util.find_spec("send2trash") is not None
if SEND2TRASH_AVAILABLE:
    import send2trash

LOGGER = logging.getLogger("assets_plus")
LANGUAGE_CODE_RE = re.compile(r"^[A-Za-z0-9_-]+$")


def get_output_directory() -> Path:
    return Path(folder_paths.get_output_directory())


def get_input_directory() -> Path:
    return Path(folder_paths.get_input_directory())


def get_extension_root() -> Path:
    return Path(__file__).resolve().parent.parent


def get_i18n_directory() -> Path:
    return get_extension_root() / "i18n"


def load_translation_file(path: Path) -> dict[str, Any]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        LOGGER.warning("Assets+ failed to load translation %s: %s", path.name, error)
        return {}
    if not isinstance(raw, dict):
        LOGGER.warning("Assets+ translation %s is not a JSON object", path.name)
        return {}
    return raw


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


def resolve_relpath(relpath: str, base_dir: Path) -> Path:
    if os.path.isabs(relpath):
        raise web.HTTPBadRequest(text="Absolute paths are not allowed")
    candidate = base_dir / relpath
    if not is_within(base_dir, candidate):
        raise web.HTTPBadRequest(text="Path traversal detected")
    return candidate


def allowed_extension(filename: str, extensions: tuple[str, ...]) -> bool:
    return filename.lower().endswith(tuple(ext.lower() for ext in extensions))


def _iter_files(
    base_dir: Path,
    extensions: tuple[str, ...],
    recursive: bool,
    scan_depth: int | None,
) -> Generator[tuple[str, Path, int, int], None, None]:
    """Lazily yield (relpath, path, mtime, size) for files matching extensions.

    Uses os.scandir for efficient directory traversal with early filtering.
    Handles broken symlinks gracefully (skips them).
    """
    def _scan(directory: Path, depth: int = 0) -> Generator[tuple[str, Path, int, int], None, None]:
        if scan_depth is not None and depth > scan_depth:
            return
        try:
            with os.scandir(str(directory)) as it:
                for entry in it:
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            if recursive and (scan_depth is None or depth < scan_depth):
                                yield from _scan(Path(entry.path), depth + 1)
                            continue
                        if not entry.is_file(follow_symlinks=False):
                            continue
                        path = Path(entry.path)
                        ext = path.suffix.lower()
                        if not allowed_extension(path.name, extensions):
                            continue
                        stat_result = entry.stat()
                        relpath = path.relative_to(base_dir).as_posix()
                        yield relpath, path, int(stat_result.st_mtime), stat_result.st_size
                    except (OSError, FileNotFoundError):
                        continue
        except (OSError, FileNotFoundError):
            return

    yield from _scan(base_dir)


def list_directory_items(
    base_dir: Path,
    extensions: tuple[str, ...],
    recursive: bool,
    scan_depth: int | None,
    hidden: dict[str, HiddenEntry] | None = None,
    hidden_prefix: str = "",
    query: str | None = None,
) -> list[dict[str, Any]]:
    hidden = hidden or {}
    query_normalized = query.strip().lower() if query else ""
    items: list[dict[str, Any]] = []

    for relpath, path, mtime, size in _iter_files(base_dir, extensions, recursive, scan_depth):
        if query_normalized:
            haystack = f"{path.name} {relpath}".lower()
            if query_normalized not in haystack:
                continue
        hidden_key = f"{hidden_prefix}{relpath}" if hidden_prefix else relpath
        hidden_entry = hidden.get(hidden_key)
        if hidden_entry and hidden_entry.mtime == mtime and hidden_entry.size == size:
            continue
        file_type = _classify_kind(path)
        has_wf = False
        if file_type == "image":
            has_wf, _ = read_workflow_metadata(path)
        items.append({
            "relpath": relpath,
            "filename": path.name,
            "mtime": mtime,
            "size": size,
            "type": file_type,
            "has_workflow": has_wf,
        })

    items.sort(key=lambda item: (-item["mtime"], item["relpath"]))
    return items




_KIND_BY_EXT = {
    ".png": "image", ".jpg": "image", ".jpeg": "image", ".webp": "image",
    ".gif": "image", ".bmp": "image", ".tiff": "image",
    ".mp4": "video", ".webm": "video", ".mov": "video", ".mkv": "video",
    ".mp3": "audio", ".flac": "audio", ".wav": "audio", ".ogg": "audio", ".m4a": "audio",
    ".glb": "mesh", ".gltf": "mesh",
}


def _classify_kind(path: Path) -> str:
    return _KIND_BY_EXT.get(path.suffix.lower(), "other")


def _placeholder_png(label: str, width: int, height: int) -> Path | None:
    """Render (and cache) a tiny labeled placeholder image. Idempotent.
    
    Returns the path to the cached placeholder, or *None* if rendering
    fails (callers must handle the None gracefully).
    """
    cache = thumb_cache_dir() / f"_placeholder_{label}_{width}x{height}.png"
    if cache.exists():
        return cache
    try:
        img = Image.new("RGB", (width, height), (40, 40, 48))
        try:
            from PIL import ImageDraw
            draw = ImageDraw.Draw(img)
            text = label.upper()
            tw, th = draw.textbbox((0, 0), text)[2:]
            draw.text(((width - tw) / 2, (height - th) / 2), text, fill=(220, 220, 230))
        except Exception:
            pass
        img.save(cache, format="PNG")
        return cache
    except Exception:
        if cache.exists():
            cache.unlink()
        return None


_metadata_cache: dict[str, tuple[float, bool, dict[str, Any]]] = {}
METADATA_CACHE_TTL = 5.0


def read_workflow_metadata(path: Path) -> tuple[bool, dict[str, Any]]:
    """Read workflow metadata from an image file.

    Returns (has_workflow, metadata_dict).
    Results are cached in memory with TTL to avoid repeated disk I/O.
    """
    cache_key = str(path.resolve())
    cached = _metadata_cache.get(cache_key)
    if cached is not None:
        cache_time, has_wf, metadata = cached
        if time.monotonic() - cache_time < METADATA_CACHE_TTL:
            return has_wf, metadata

    try:
        with Image.open(path) as image:
            info = image.info or {}
    except OSError:
        _metadata_cache[cache_key] = (time.monotonic(), False, {})
        return False, {}

    metadata: dict[str, Any] = {}
    for key in ("workflow", "prompt"):
        value = info.get(key)
        if value:
            metadata[key] = value
    has_wf = bool(metadata)
    _metadata_cache[cache_key] = (time.monotonic(), has_wf, metadata)
    return has_wf, metadata


def read_metadata(path: Path) -> dict[str, Any]:
    """Read metadata from an image file. Backward-compatible wrapper."""
    _, metadata = read_workflow_metadata(path)
    return metadata


def build_thumb_cache_key(relpath: str, mtime: int, size: int, width: int, height: int) -> str:
    hash_input = f"{relpath}:{mtime}:{size}:{width}:{height}".encode("utf-8")
    return hashlib.sha256(hash_input).hexdigest()


def remove_thumb_cache_entries(
    relpath: str,
    mtime: int,
    size: int,
    thumbnail_sizes: tuple[tuple[int, int], ...],
) -> int:
    removed = 0
    cache_root = thumb_cache_dir()
    for width, height in thumbnail_sizes:
        cache_key = build_thumb_cache_key(relpath, mtime, size, width, height)
        cache_path = cache_root / f"{cache_key}.png"
        if not cache_path.exists():
            continue
        try:
            cache_path.unlink()
            removed += 1
        except OSError:
            LOGGER.warning(
                "[Assets+ Explorer] Failed to remove thumbnail cache %s for %s",
                cache_path,
                relpath,
            )
    return removed


def clear_thumb_cache() -> int:
    cache_root = thumb_cache_dir()
    removed = 0
    for entry in cache_root.glob("*.png"):
        try:
            entry.unlink()
            removed += 1
        except OSError:
            LOGGER.warning("[Assets+ Explorer] Failed to remove thumbnail cache %s", entry)
    return removed


def parse_cursor(raw: str | None) -> tuple[int, str, bool] | None:
    if not raw:
        return None
    if ":" in raw:
        mtime_raw, relpath = raw.split(":", 1)
        try:
            return int(mtime_raw), relpath, True
        except ValueError:
            return None
    try:
        return int(raw), "", False
    except ValueError:
        return None


def encode_cursor(item: dict[str, Any]) -> str:
    return f"{item['mtime']}:{item['relpath']}"


def apply_cursor_filter(
    items: list[dict[str, Any]],
    cursor: tuple[int, str, bool] | None,
) -> list[dict[str, Any]]:
    if not cursor:
        return items
    mtime, relpath, has_relpath = cursor
    if has_relpath:
        return [
            item
            for item in items
            if item["mtime"] < mtime or (item["mtime"] == mtime and item["relpath"] > relpath)
        ]
    return [item for item in items if item["mtime"] < mtime]


def apply_since_filter(
    items: list[dict[str, Any]],
    since: int | None,
) -> list[dict[str, Any]]:
    if since is None:
        return items
    return [item for item in items if item["mtime"] > since]


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
