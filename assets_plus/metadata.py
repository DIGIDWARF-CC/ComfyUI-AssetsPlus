from __future__ import annotations

import hashlib
import logging
import time
from pathlib import Path
from typing import Any

from PIL import Image

from .storage import thumb_cache_dir

LOGGER = logging.getLogger("assets_plus")

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
