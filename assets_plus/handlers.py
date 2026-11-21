from __future__ import annotations

import asyncio
import itertools
import logging
import os
import shutil
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from aiohttp import web
from PIL import Image
from server import PromptServer

from .config import load_config, thumbnail_size_from_quality
from .storage import (
    HiddenEntry, load_hidden, thumb_cache_dir, update_hidden, evict_thumb_cache,
    starred_key, update_starred,
)
from .paths import get_output_directory, get_input_directory, get_i18n_directory, resolve_relpath, load_translation_file, LANGUAGE_CODE_RE
from .scanner import _classify_kind, _placeholder_png
from .listing import (
    Filters, R_MTIME, R_REL, R_SIZE, Snapshot, build_items, get_snapshot, invalidate, iter_visible,
)
from .marks import MarkScope, reconcile_marks
from .metadata import read_metadata, build_thumb_cache_key, remove_thumb_cache_entries, clear_thumb_cache
from .trash import move_to_trash
from .pagination import parse_cursor, encode_cursor

LOGGER = logging.getLogger("assets_plus")
DELETE_MODES = frozenset({"trash", "delete", "hide"})


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
        # Write to a temp file and publish it atomically: a failed or concurrent save must
        # never leave a truncated PNG at cache_path (it would be served forever).
        tmp_path = cache_path.with_name(f".{cache_path.name}.{threading.get_ident()}.tmp")
        try:
            with Image.open(path) as image:
                image.thumbnail((width, height))
                image.save(tmp_path, format="PNG")
            os.replace(tmp_path, cache_path)
        finally:
            tmp_path.unlink(missing_ok=True)
        evict_thumb_cache()
    await asyncio.wait_for(asyncio.to_thread(_sync_thumb), timeout=30.0)


def _int_param(params: Any, name: str, default: int, minimum: int = 1, maximum: int | None = None) -> int:
    """Read an integer query parameter; invalid or out-of-range values fall back to *default*."""
    try:
        value = int(params.get(name, default))
    except (TypeError, ValueError):
        return default
    if value < minimum or (maximum is not None and value > maximum):
        return default
    return value


async def _thumb_response(request: web.Request, base_dir: Path) -> web.StreamResponse:
    """Shared body of the output/input thumbnail endpoints."""
    config = load_config()
    params = request.rel_url.query
    relpath = params.get("relpath")
    if not relpath:
        raise web.HTTPBadRequest(text="relpath is required")
    default_width, default_height = thumbnail_size_from_quality(config.thumbnail_quality)
    width = _int_param(params, "w", default_width, maximum=2048)
    height = _int_param(params, "h", default_height, maximum=2048)
    path = resolve_relpath(relpath, base_dir)
    if not path.is_file():
        raise web.HTTPNotFound(text="Asset not found")

    # The client puts the file's mtime and size into ``v``: a changed file gets a new URL, so a versioned
    # response can be cached by the browser for good and the grid never revalidates thumbnails.
    immutable = bool(params.get("v"))

    def respond(file_path: Path, *, cacheable: bool = True) -> web.StreamResponse:
        resp = web.FileResponse(path=file_path)
        _set_content_type(resp, file_path)
        if immutable and cacheable:
            resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return resp

    if path.suffix.lower() in {".mp4", ".webm"}:
        return respond(path)

    def placeholder_response(label: str, *, cacheable: bool = True) -> web.StreamResponse:
        placeholder = _placeholder_png(label, width, height)
        if placeholder is None:
            raise web.HTTPInternalServerError(text="Failed to generate placeholder")
        return respond(placeholder, cacheable=cacheable)

    kind = _classify_kind(path)
    if kind != "image":
        return placeholder_response(kind)

    stat = path.stat()
    cache_key = build_thumb_cache_key(relpath, int(stat.st_mtime), stat.st_size, width, height)
    cache_path = thumb_cache_dir() / f"{cache_key}.png"
    if cache_path.exists():
        return respond(cache_path)

    try:
        await _generate_thumbnail(path, width, height, cache_path)
    except Exception:  # unreadable/huge/odd-mode image or timeout: show a placeholder tile
        LOGGER.warning("[Assets+ Explorer] Thumbnail failed for %s", relpath, exc_info=True)
        return placeholder_response("other", cacheable=False)  # a later attempt may succeed
    return respond(cache_path)


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
        if not isinstance(relpath, str) or not relpath:
            continue
        try:
            path = resolve_relpath(relpath, base_dir)
        except (web.HTTPError, ValueError):
            failed.append(relpath)
            continue
        if not path.is_file():  # never trash/unlink a directory through this API
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
            if mode == "trash":
                # Never falls back to a permanent delete: on failure the file stays in place.
                move_to_trash(path)
                actual_modes[relpath] = "trash"
            else:
                path.unlink()
                actual_modes[relpath] = mode
            removed.append(relpath)
        except PermissionError:
            LOGGER.warning("[Assets+ Explorer] Permission denied for %s", relpath)
            failed.append(relpath)
        except OSError:
            LOGGER.exception("Failed to remove asset %s", relpath)
            failed.append(relpath)

    if mode == "hide" and hidden_updates:
        update_hidden(lambda h: {**h, **hidden_updates})
    elif removed:
        invalidate(base_dir)
        # Files that are really gone (trash / permanent delete) lose their star.
        scope = "input" if hidden_prefix == "input/" else "output"
        gone = {starred_key(scope, relpath) for relpath in removed}
        update_starred(lambda s: {key: entry for key, entry in s.items() if key not in gone})
    return removed, failed, actual_modes


TRUE_VALUES = {"1", "true", "True"}


@dataclass
class _View:
    """Everything a listing or window request needs, after the indexes were reconciled."""

    snapshot: Snapshot
    filters: Filters
    starred_first: bool


def _prepare_view(base_dir: Path, hidden_prefix: str, params: dict[str, str]) -> _View:
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
    scope_name = "input" if hidden_prefix == "input/" else "output"

    snapshot = get_snapshot(
        base_dir, extensions, recursive, scan_depth, fresh=params.get("fresh", "0") in TRUE_VALUES
    )
    scanned = snapshot.scanned
    hidden_scope = MarkScope(
        base_dir, prefix=hidden_prefix, other_prefix=None if hidden_prefix else "input/"
    )
    starred_scope = MarkScope(base_dir, prefix=f"{scope_name}/")
    hidden = update_hidden(lambda h: reconcile_marks(h, hidden_scope, scanned, strict=True))
    starred_entries = update_starred(lambda s: reconcile_marks(s, starred_scope, scanned, strict=False))

    # A hidden entry only hides the file it was recorded for (same mtime and size).
    hidden_relpaths = set()
    for key, entry in hidden.items():
        if not hidden_scope.owns(key):
            continue
        relpath = hidden_scope.relpath_of(key)
        position = snapshot.index.get(relpath)
        if position is not None:
            row = snapshot.rows[position]
            if row[R_MTIME] == entry.mtime and row[R_SIZE] == entry.size:
                hidden_relpaths.add(relpath)
    starred = {starred_scope.relpath_of(key) for key in starred_entries if starred_scope.owns(key)}

    query = params.get("query") or params.get("q") or ""
    return _View(
        snapshot=snapshot,
        filters=Filters(hidden=hidden_relpaths, starred=starred, query=query.strip().lower()),
        starred_first=params.get("starred_first", "0") in TRUE_VALUES,
    )


def _build_list_response(base_dir: Path, hidden_prefix: str, params: dict[str, str]) -> dict[str, Any]:
    """One page of the gallery (cursor paging) or everything newer than ``since``."""
    config = load_config()
    limit = _int_param(params, "limit", config.list_limit, minimum=0)
    cursor = parse_cursor(params.get("cursor"))
    since = None
    if params.get("since") is not None:
        try:
            since = int(params["since"])
        except ValueError:
            since = None

    view = _prepare_view(base_dir, hidden_prefix, params)
    latest_row = next(iter_visible(view.snapshot, view.filters), None)
    latest_mtime = latest_row[R_MTIME] if latest_row else 0

    ordered = iter_visible(
        view.snapshot, view.filters, starred_first=view.starred_first, cursor=cursor, since=since
    )
    rows = list(itertools.islice(ordered, limit + 1 if limit else None))
    has_more = bool(limit) and len(rows) > limit
    if limit:
        rows = rows[:limit]
    items = build_items(base_dir, rows, view.filters.starred)
    next_cursor = (
        encode_cursor(items[-1], view.starred_first) if items else params.get("cursor") or ""
    )
    return {
        "items": items,
        "cursor": next_cursor,
        "has_more": has_more,
        "latest_mtime": latest_mtime,
    }


def _build_window_response(base_dir: Path, hidden_prefix: str, params: dict[str, str]) -> dict[str, Any]:
    """A slice of the gallery around one file (or at its head/tail), for lens navigation.

    The lens must be able to jump anywhere (e.g. to the oldest file) without the gallery having loaded
    the pages in between, so it asks for a window and keeps it as its own small cache.
    """
    before = _int_param(params, "before", 10, minimum=0, maximum=100)
    after = _int_param(params, "after", 10, minimum=0, maximum=100)
    view = _prepare_view(base_dir, hidden_prefix, params)
    visible = list(iter_visible(view.snapshot, view.filters, starred_first=view.starred_first))
    total = len(visible)
    relpath = params.get("relpath")
    if relpath:
        position = next((index for index, row in enumerate(visible) if row[R_REL] == relpath), None)
        if position is None:
            return {"found": False, "items": [], "start": 0, "total": total,
                    "has_before": False, "has_after": False}
        start, end = max(0, position - before), min(total, position + after + 1)
    elif params.get("anchor") == "last":
        start, end = max(0, total - (before + 1)), total
    else:
        start, end = 0, min(total, after + 1)
    items = build_items(base_dir, visible[start:end], view.filters.starred)
    return {"found": True, "items": items, "start": start, "total": total,
            "has_before": start > 0, "has_after": end < total}


@PromptServer.instance.routes.get("/assets_plus/output/list")
async def output_list(request: web.Request) -> web.Response:
    params = request.rel_url.query
    LOGGER.info("Assets+ output list request params=%s", dict(params))
    result = await asyncio.to_thread(_build_list_response, get_output_directory(), "", params)
    return web.json_response(result)


@PromptServer.instance.routes.get("/assets_plus/input/list")
async def input_list(request: web.Request) -> web.Response:
    params = request.rel_url.query
    LOGGER.info("Assets+ input list request params=%s", dict(params))
    result = await asyncio.to_thread(_build_list_response, get_input_directory(), "input/", params)
    return web.json_response(result)


@PromptServer.instance.routes.get("/assets_plus/output/window")
async def output_window(request: web.Request) -> web.Response:
    result = await asyncio.to_thread(_build_window_response, get_output_directory(), "", request.rel_url.query)
    return web.json_response(result)


@PromptServer.instance.routes.get("/assets_plus/input/window")
async def input_window(request: web.Request) -> web.Response:
    result = await asyncio.to_thread(_build_window_response, get_input_directory(), "input/", request.rel_url.query)
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
    return await _thumb_response(request, get_output_directory())


@PromptServer.instance.routes.get("/assets_plus/input/thumb")
async def input_thumb(request: web.Request) -> web.StreamResponse:
    return await _thumb_response(request, get_input_directory())


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
    if mode not in DELETE_MODES:
        raise web.HTTPBadRequest(text="mode must be trash, delete or hide")

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
    if mode not in DELETE_MODES:
        raise web.HTTPBadRequest(text="mode must be trash, delete or hide")

    removed, failed, actual_modes = delete_assets(get_input_directory(), relpaths, mode, hidden_prefix="input/")
    LOGGER.info("Assets+ input delete mode=%s removed=%s failed=%s", mode, removed, failed)
    return web.json_response({"removed": removed, "failed": failed, "mode": mode, "actual_modes": actual_modes})


def set_starred_assets(
    base_dir: Path,
    scope: str,
    relpaths: list[Any],
    starred: bool,
) -> tuple[list[str], list[str]]:
    """Star or unstar assets. Returns (updated, failed) relpath lists."""
    updated: list[str] = []
    failed: list[str] = []
    fingerprints: dict[str, tuple[int, int]] = {}

    for relpath in relpaths:
        if not isinstance(relpath, str) or not relpath:
            continue
        if not starred:
            updated.append(relpath)  # unstarring never needs the file to exist
            continue
        try:
            path = resolve_relpath(relpath, base_dir)
            stat = path.stat()
        except (web.HTTPError, OSError):
            failed.append(relpath)
            continue
        if not path.is_file():
            failed.append(relpath)
            continue
        fingerprints[relpath] = (int(stat.st_mtime), stat.st_size)
        updated.append(relpath)

    def apply(entries: dict[str, HiddenEntry]) -> dict[str, HiddenEntry]:
        if starred:
            for relpath, (mtime, size) in fingerprints.items():
                key = starred_key(scope, relpath)
                entries[key] = HiddenEntry(relpath=key, mtime=mtime, size=size)
        else:
            for relpath in updated:
                entries.pop(starred_key(scope, relpath), None)
        return entries

    update_starred(apply)
    return updated, failed


async def _star_response(request: web.Request, base_dir: Path, scope: str) -> web.Response:
    payload = await request.json()
    relpaths = payload.get("relpaths", [])
    if not isinstance(relpaths, list):
        raise web.HTTPBadRequest(text="relpaths must be a list")
    starred = bool(payload.get("starred", True))
    updated, failed = set_starred_assets(base_dir, scope, relpaths, starred)
    LOGGER.info("Assets+ %s star starred=%s updated=%s failed=%s", scope, starred, len(updated), len(failed))
    return web.json_response({"updated": updated, "failed": failed, "starred": starred})


@PromptServer.instance.routes.post("/assets_plus/output/star")
async def output_star(request: web.Request) -> web.Response:
    return await _star_response(request, get_output_directory(), "output")


@PromptServer.instance.routes.post("/assets_plus/input/star")
async def input_star(request: web.Request) -> web.Response:
    return await _star_response(request, get_input_directory(), "input")


def _unique_destination(directory: Path, filename: str) -> Path:
    """First free path for *filename* in *directory*: name.ext, name_1.ext, name_2.ext, ..."""
    candidate = directory / filename
    stem, suffix = os.path.splitext(filename)
    counter = 0
    while candidate.exists():
        counter += 1
        candidate = directory / f"{stem}_{counter}{suffix}"
    return candidate


def _move_file(source: Path, destination: Path) -> None:
    """Move without ever overwriting; falls back to copy+verify+delete across volumes."""
    try:
        # A hard link fails with FileExistsError instead of overwriting (unlike os.rename on POSIX).
        os.link(source, destination)
    except FileExistsError:
        raise
    except OSError:
        pass  # different volume or no hard-link support: copy below
    else:
        try:
            source.unlink()
        except OSError:
            destination.unlink(missing_ok=True)
            raise
        return
    partial = destination.with_name(f".{destination.name}.part")
    try:
        shutil.copy2(source, partial)
        if partial.stat().st_size != source.stat().st_size:
            raise OSError("copy size mismatch")
        if destination.exists():
            raise FileExistsError(str(destination))
        os.replace(partial, destination)
    except BaseException:
        partial.unlink(missing_ok=True)
        raise
    source.unlink()


def move_assets_to_input(
    output_dir: Path,
    input_dir: Path,
    relpaths: list[Any],
    thumbnail_sizes: tuple[tuple[int, int], ...] = ((256, 256), (512, 512)),
) -> tuple[list[dict[str, str]], list[str]]:
    """Turn generated results into inputs: move files from output into the input root.

    Name clashes get a numeric suffix instead of overwriting. Returns
    (moved, failed) where moved items are {"from": <output relpath>, "to": <input relpath>}.
    """
    moved: list[dict[str, str]] = []
    failed: list[str] = []
    transfers: list[tuple[str, str, int, int]] = []  # (from, to, mtime, size)

    for relpath in relpaths:
        if not isinstance(relpath, str) or not relpath:
            continue
        try:
            source = resolve_relpath(relpath, output_dir)
            stat = source.stat()
        except (web.HTTPError, OSError):
            failed.append(relpath)
            continue
        if not source.is_file():
            failed.append(relpath)
            continue
        placed = False
        for _ in range(100):  # a concurrent writer can take the name between check and move
            destination = _unique_destination(input_dir, source.name)
            try:
                _move_file(source, destination)
            except FileExistsError:
                continue
            except OSError:
                LOGGER.exception("Failed to move asset %s to input", relpath)
                break
            placed = True
            break
        if not placed:
            failed.append(relpath)
            continue
        remove_thumb_cache_entries(relpath, int(stat.st_mtime), stat.st_size, thumbnail_sizes)
        moved.append({"from": relpath, "to": destination.name})
        transfers.append((relpath, destination.name, int(stat.st_mtime), stat.st_size))

    if transfers:
        invalidate(output_dir)
        invalidate(input_dir)
        gone_hidden = {relpath for relpath, _, _, _ in transfers}

        def move_starred(entries: dict[str, HiddenEntry]) -> dict[str, HiddenEntry]:
            for old_relpath, new_relpath, mtime, size in transfers:
                if entries.pop(starred_key("output", old_relpath), None) is not None:
                    new_key = starred_key("input", new_relpath)
                    entries[new_key] = HiddenEntry(relpath=new_key, mtime=mtime, size=size)
            return entries

        update_starred(move_starred)
        update_hidden(lambda h: {k: v for k, v in h.items() if k not in gone_hidden})
    return moved, failed


@PromptServer.instance.routes.post("/assets_plus/output/move_to_input")
async def output_move_to_input(request: web.Request) -> web.Response:
    payload = await request.json()
    relpaths = payload.get("relpaths", [])
    if not isinstance(relpaths, list):
        raise web.HTTPBadRequest(text="relpaths must be a list")
    moved, failed = await asyncio.to_thread(
        move_assets_to_input, get_output_directory(), get_input_directory(), relpaths
    )
    LOGGER.info("Assets+ move to input moved=%s failed=%s", len(moved), len(failed))
    return web.json_response({"moved": moved, "failed": failed})


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
