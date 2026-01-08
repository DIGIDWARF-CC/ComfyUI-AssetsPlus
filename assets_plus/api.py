from __future__ import annotations

import hashlib
import json
import logging
import os
import re
from pathlib import Path
from typing import Any

from aiohttp import web

import folder_paths
from PIL import Image
from server import PromptServer

from .config import load_config, thumbnail_size_from_quality
from .storage import HiddenEntry, load_hidden, save_hidden, thumb_cache_dir

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


def list_directory_items(
    base_dir: Path,
    extensions: tuple[str, ...],
    recursive: bool,
    scan_depth: int | None,
    hidden: dict[str, HiddenEntry] | None = None,
    hidden_prefix: str = "",
) -> list[dict[str, Any]]:
    hidden = hidden or {}
    items: list[dict[str, Any]] = []
    for path in iter_output_files(base_dir, recursive, scan_depth):
        if not path.is_file():
            continue
        relpath = path.relative_to(base_dir).as_posix()
        if not allowed_extension(path.name, extensions):
            continue
        stat = path.stat()
        hidden_key = f"{hidden_prefix}{relpath}" if hidden_prefix else relpath
        hidden_entry = hidden.get(hidden_key)
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


@PromptServer.instance.routes.get("/assets_plus/output/list")
async def output_list(request: web.Request) -> web.Response:
    config = load_config()
    params = request.rel_url.query
    LOGGER.info("Assets+ output list request params=%s", dict(params))
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
    hidden = load_hidden()
    items = list_directory_items(output_dir, extensions, recursive, scan_depth, hidden=hidden)
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


@PromptServer.instance.routes.get("/assets_plus/input/list")
async def input_list(request: web.Request) -> web.Response:
    config = load_config()
    params = request.rel_url.query
    LOGGER.info("Assets+ input list request params=%s", dict(params))
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

    input_dir = get_input_directory()
    hidden = load_hidden()
    items = list_directory_items(
        input_dir,
        extensions,
        recursive,
        scan_depth,
        hidden=hidden,
        hidden_prefix="input/",
    )
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
    thumbnail_size = thumbnail_size_from_quality(config.thumbnail_quality)
    return web.json_response(
        {
            "allowed_extensions": list(config.allowed_extensions),
            "thumbnail_quality": config.thumbnail_quality,
            "thumbnail_size": list(thumbnail_size),
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
    default_width, default_height = thumbnail_size_from_quality(config.thumbnail_quality)
    width = int(params.get("w", default_width))
    height = int(params.get("h", default_height))
    path = resolve_relpath(relpath, get_output_directory())
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
) -> tuple[list[str], list[str]]:
    hidden = load_hidden()
    removed: list[str] = []
    failed: list[str] = []

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
            hidden[hidden_key] = HiddenEntry(
                relpath=hidden_key,
                mtime=int(stat.st_mtime),
                size=stat.st_size,
            )
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
    return removed, failed


@PromptServer.instance.routes.post("/assets_plus/output/delete")
async def output_delete(request: web.Request) -> web.Response:
    config = load_config()
    payload = await request.json()
    relpaths = payload.get("relpaths", [])
    mode = payload.get("mode") or config.default_delete_mode
    if not isinstance(relpaths, list):
        raise web.HTTPBadRequest(text="relpaths must be a list")

    removed, failed = delete_assets(get_output_directory(), relpaths, mode)
    LOGGER.info("Assets+ delete mode=%s removed=%s failed=%s", mode, removed, failed)
    return web.json_response({"removed": removed, "failed": failed, "mode": mode})


@PromptServer.instance.routes.post("/assets_plus/input/delete")
async def input_delete(request: web.Request) -> web.Response:
    config = load_config()
    payload = await request.json()
    relpaths = payload.get("relpaths", [])
    mode = payload.get("mode") or config.default_delete_mode
    if not isinstance(relpaths, list):
        raise web.HTTPBadRequest(text="relpaths must be a list")

    removed, failed = delete_assets(get_input_directory(), relpaths, mode, hidden_prefix="input/")
    LOGGER.info("Assets+ input delete mode=%s removed=%s failed=%s", mode, removed, failed)
    return web.json_response({"removed": removed, "failed": failed, "mode": mode})


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
