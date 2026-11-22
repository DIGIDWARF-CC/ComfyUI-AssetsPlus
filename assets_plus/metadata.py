from __future__ import annotations

import hashlib
import logging
import threading
from collections import OrderedDict
from pathlib import Path
from typing import Any

from PIL import Image

from .video_metadata import read_matroska_metadata, read_mp4_metadata

LOGGER = logging.getLogger("assets_plus")

# Only the "has a workflow" flag is cached (the workflow JSON itself can be large and is
# read on demand), keyed by (path, mtime, size) so a changed file is re-read.
_workflow_flag_cache: OrderedDict[tuple[str, int, int], bool] = OrderedDict()
WORKFLOW_FLAG_CACHE_MAX_ENTRIES = 50000
_workflow_flag_lock = threading.Lock()


def _read_picture_metadata(path: Path) -> dict[str, Any]:
    try:
        with Image.open(path) as image:
            info = image.info or {}
    except Exception:  # unreadable, truncated or decompression-bomb image: no metadata, never fail a listing
        return {}
    metadata: dict[str, Any] = {}
    for key in ("workflow", "prompt"):
        value = info.get(key)
        if value:
            metadata[key] = value
    return metadata


_MP4_EXTENSIONS = {".mp4", ".mov", ".m4v"}
_MATROSKA_EXTENSIONS = {".webm", ".mkv"}


def _read_embedded_metadata(path: Path) -> dict[str, Any]:
    """Workflow/prompt embedded in an image (PNG/WebP text chunks) or a video (MP4/MOV/WebM/MKV)."""
    if path.suffix.lower() in _MP4_EXTENSIONS:
        return dict(read_mp4_metadata(path))
    if path.suffix.lower() in _MATROSKA_EXTENSIONS:
        return dict(read_matroska_metadata(path))
    return _read_picture_metadata(path)


def read_workflow_metadata(path: Path) -> tuple[bool, dict[str, Any]]:
    """Read workflow metadata from an image file. Returns (has_workflow, metadata_dict)."""
    metadata = _read_embedded_metadata(path)
    return bool(metadata), metadata


def has_workflow(path: Path, mtime: int, size: int) -> bool:
    """Cheap, cached check used by gallery listings (does not reopen unchanged images)."""
    cache_key = (str(path), mtime, size)
    with _workflow_flag_lock:
        cached = _workflow_flag_cache.get(cache_key)
        if cached is not None:
            _workflow_flag_cache.move_to_end(cache_key)
            return cached
    flag = bool(_read_embedded_metadata(path))  # workflow, or a prompt the graph can be rebuilt from
    with _workflow_flag_lock:
        _workflow_flag_cache[cache_key] = flag
        while len(_workflow_flag_cache) > WORKFLOW_FLAG_CACHE_MAX_ENTRIES:
            _workflow_flag_cache.popitem(last=False)
    return flag


def read_metadata(path: Path) -> dict[str, Any]:
    """Read metadata from an image file."""
    return _read_embedded_metadata(path)
