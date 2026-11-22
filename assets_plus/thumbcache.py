"""On-disk cache of gallery thumbnails.

Layout::

    <user>/__assets_plus/thumb_cache/v2/<first two hex digits of the key>/<key>.webp

* A key is the SHA-256 of gallery + relative path + mtime + size + thumbnail size, so a file that is replaced under its
  name (or exists in both galleries) never shares a thumbnail with another file.
* Thumbnails are lossy WebP (quality 85): about a tenth of the size of the PNGs the first versions wrote, with no
  visible difference at tile size. The cache is private to the extension, nobody is meant to open its files.
* Entries are spread over 256 folders, so no folder grows to tens of thousands of files.
* The last use of an entry is the modification time of its file: a hit refreshes it (at most once an hour per file),
  and eviction removes the least recently used entries first, down to 90% of the budget so it does not run again
  after every new thumbnail. The running size is tracked in memory, nothing is scanned per request.
* The flat ``*.png`` files of the older layout are deleted once, in the background.
"""
from __future__ import annotations

import hashlib
import logging
import os
import shutil
import threading
import time
from pathlib import Path

from PIL import Image, ImageOps

from .config import load_config
from .storage import thumb_cache_dir

LOGGER = logging.getLogger("assets_plus")

CACHE_DIR_NAME = "v2"
EXTENSION = ".webp"
WEBP_QUALITY = 85
WEBP_METHOD = 4
LOW_WATER = 0.9  # an eviction pass frees space down to this share of the budget
MIN_PASS_INTERVAL = 10.0  # seconds between eviction passes
TOUCH_AFTER = 3600.0  # refresh the last-use time of an entry at most this often
FAILURE_MEMORY = 300.0  # seconds a thumbnail that could not be made is not tried again
MAX_FAILURES = 2000

_WEBP_MODES = {"RGB", "RGBA"}

_state_lock = threading.Lock()
_total_bytes: int | None = None  # None until the first pass has measured the cache
_pass_running = False
_last_pass = float("-inf")
_legacy_purged = False
_failures: dict[str, float] = {}


def cache_root() -> Path:
    return thumb_cache_dir() / CACHE_DIR_NAME


def cache_key(scope: str, relpath: str, mtime: int, size: int, width: int, height: int) -> str:
    material = f"{scope}\0{relpath}\0{mtime}\0{size}\0{width}\0{height}".encode("utf-8")
    return hashlib.sha256(material).hexdigest()


def entry_path(key: str) -> Path:
    return cache_root() / key[:2] / f"{key}{EXTENSION}"


def budget_bytes() -> int:
    return int(load_config().thumbnail_cache_mb) * 1024 * 1024


# --- reading ----------------------------------------------------------------------------------------------

def lookup(key: str) -> Path | None:
    """The cached file for *key*, with its last-use time refreshed when it is old enough to matter."""
    path = entry_path(key)
    try:
        info = os.stat(path)
    except OSError:
        return None
    if time.time() - info.st_mtime > TOUCH_AFTER:
        try:
            os.utime(path)
        except OSError:
            pass
    return path


def recently_failed(key: str) -> bool:
    with _state_lock:
        failed_at = _failures.get(key)
        if failed_at is None:
            return False
        if time.monotonic() - failed_at > FAILURE_MEMORY:
            del _failures[key]
            return False
        return True


def remember_failure(key: str) -> None:
    with _state_lock:
        if len(_failures) >= MAX_FAILURES:
            _failures.clear()
        _failures[key] = time.monotonic()


# --- writing ----------------------------------------------------------------------------------------------

def write_thumbnail(source: Path, width: int, height: int, key: str) -> Path:
    """Render *source* into the cache. The file is written aside and published atomically, so a failed or
    concurrent write never leaves a truncated entry behind."""
    target = entry_path(key)
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = target.with_name(f".{target.name}.{threading.get_ident()}.tmp")
    try:
        with Image.open(source) as image:
            image.draft("RGB", (width * 2, height * 2))  # JPEG: decode at a reduced scale, much cheaper
            image.thumbnail((width, height))
            try:
                image = ImageOps.exif_transpose(image)  # phone photos in the input folder
            except Exception:  # noqa: BLE001 - a broken EXIF block must not cost the thumbnail
                pass
            if image.mode not in _WEBP_MODES:
                image = image.convert("RGBA" if "A" in image.getbands() or "transparency" in image.info else "RGB")
            image.save(tmp_path, format="WEBP", quality=WEBP_QUALITY, method=WEBP_METHOD)
        size = tmp_path.stat().st_size
        os.replace(tmp_path, target)
    finally:
        tmp_path.unlink(missing_ok=True)
    _note_written(size)
    return target


def _note_written(size: int) -> None:
    global _total_bytes
    with _state_lock:
        if _total_bytes is not None:
            _total_bytes += size
        over_budget = _total_bytes is None or _total_bytes > budget_bytes()
    if over_budget:
        schedule_maintenance()


# --- removing ---------------------------------------------------------------------------------------------

def remove_entries(
    scope: str,
    relpath: str,
    mtime: int,
    size: int,
    thumbnail_sizes: tuple[tuple[int, int], ...],
) -> int:
    global _total_bytes
    removed = 0
    for width, height in thumbnail_sizes:
        path = entry_path(cache_key(scope, relpath, mtime, size, width, height))
        try:
            freed = path.stat().st_size
            path.unlink()
        except FileNotFoundError:
            continue
        except OSError:
            LOGGER.warning("[Assets+ Explorer] Failed to remove thumbnail cache %s for %s", path, relpath)
            continue
        removed += 1
        with _state_lock:
            if _total_bytes is not None:
                _total_bytes = max(0, _total_bytes - freed)
    return removed


def clear() -> int:
    """Remove every cached thumbnail (also the files of the older flat layout). Returns the number of files."""
    global _total_bytes
    removed = _purge_legacy()
    root = cache_root()
    if root.exists():
        with os.scandir(root) as shards:
            for shard in shards:
                try:
                    with os.scandir(shard.path) as entries:
                        removed += sum(1 for entry in entries if entry.is_file())
                except OSError:
                    continue
        shutil.rmtree(root, ignore_errors=True)
    with _state_lock:
        _total_bytes = 0
        _failures.clear()
    return removed


def _purge_legacy() -> int:
    """Delete the flat ``<sha256>.png`` files that earlier versions kept next to the placeholders."""
    removed = 0
    try:
        with os.scandir(thumb_cache_dir()) as entries:
            for entry in entries:
                name = entry.name
                if name.startswith("_placeholder_") or not name.endswith(".png") or not entry.is_file():
                    continue
                try:
                    os.unlink(entry.path)
                    removed += 1
                except OSError:
                    pass
    except OSError:
        pass
    return removed


# --- maintenance (size accounting and eviction) -----------------------------------------------------------

def schedule_maintenance() -> None:
    """Start an eviction pass in the background unless one is running or ran a moment ago."""
    global _pass_running
    with _state_lock:
        if _pass_running or time.monotonic() - _last_pass < MIN_PASS_INTERVAL:
            return
        _pass_running = True
    threading.Thread(target=_maintenance_pass, name="assets-plus-cache", daemon=True).start()


def _maintenance_pass() -> None:
    global _pass_running, _last_pass, _total_bytes, _legacy_purged
    try:
        if not _legacy_purged:
            _legacy_purged = True
            purged = _purge_legacy()
            if purged:
                LOGGER.info("[Assets+ Explorer] Removed %s thumbnails of the old cache layout", purged)
        entries: list[tuple[float, int, str]] = []
        total = 0
        root = cache_root()
        if root.exists():
            with os.scandir(root) as shards:
                for shard in shards:
                    if not shard.is_dir():
                        continue
                    try:
                        with os.scandir(shard.path) as files:
                            for entry in files:
                                if not entry.name.endswith(EXTENSION):
                                    continue
                                info = entry.stat()
                                entries.append((info.st_mtime, info.st_size, entry.path))
                                total += info.st_size
                    except OSError:
                        continue
        budget = budget_bytes()
        if total > budget:
            entries.sort()  # least recently used first
            goal = int(budget * LOW_WATER)
            for _, size, path in entries:
                if total <= goal:
                    break
                try:
                    os.unlink(path)
                    total -= size
                except OSError:
                    pass
        with _state_lock:
            _total_bytes = total
    except Exception:  # noqa: BLE001 - housekeeping must never hurt a request
        LOGGER.warning("[Assets+ Explorer] Thumbnail cache maintenance failed", exc_info=True)
    finally:
        with _state_lock:
            _last_pass = time.monotonic()
            _pass_running = False
