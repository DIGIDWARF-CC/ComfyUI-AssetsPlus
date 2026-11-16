from __future__ import annotations

import json
import os
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import folder_paths


@dataclass(frozen=True)
class HiddenEntry:
    relpath: str
    mtime: int
    size: int


def get_assets_plus_root() -> Path:
    user_dir = Path(folder_paths.get_user_directory())
    root = user_dir / "__assets_plus"
    root.mkdir(parents=True, exist_ok=True)
    return root


def hidden_index_path() -> Path:
    return get_assets_plus_root() / "hidden.json"


def load_hidden() -> dict[str, HiddenEntry]:
    path = hidden_index_path()
    if not path.exists():
        return {}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    entries: dict[str, HiddenEntry] = {}
    for relpath, payload in raw.items():
        if not isinstance(payload, dict):
            continue
        mtime = int(payload.get("mtime", 0))
        size = int(payload.get("size", 0))
        entries[relpath] = HiddenEntry(relpath=relpath, mtime=mtime, size=size)
    return entries


def save_hidden(entries: dict[str, HiddenEntry]) -> None:
    path = hidden_index_path()
    data = {
        relpath: {"mtime": entry.mtime, "size": entry.size}
        for relpath, entry in entries.items()
    }
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")


_hidden_lock = threading.Lock()


def update_hidden(
    updater: Callable[[dict[str, HiddenEntry]], dict[str, HiddenEntry]],
) -> dict[str, HiddenEntry]:
    """Atomically read hidden.json, apply *updater*, and write back.

    The updater receives the current hidden dict and must return the
    modified dict.  The write is performed to a temporary file followed
    by os.replace() for atomicity under the module-level lock.
    """
    with _hidden_lock:
        hidden = load_hidden()
        modified = updater(dict(hidden))
        if modified == hidden:
            return modified
        path = hidden_index_path()
        tmp_path = path.with_suffix(".tmp")
        data = {
            relpath: {"mtime": entry.mtime, "size": entry.size}
            for relpath, entry in modified.items()
        }
        tmp_path.write_text(json.dumps(data, indent=2), encoding="utf-8")
        os.replace(str(tmp_path), str(path))
        return modified


# --- Starred index -----------------------------------------------------------
# Starred markers live next to hidden.json instead of inside the media files:
# rewriting PNG/MP4/GLB containers on every toggle is slow and risky, and would
# change size/mtime that other indexes and ComfyUI itself rely on.  Keys are
# "<scope>/<relpath>" with scope "output" or "input" so the two galleries can
# never collide.

STARRED_SCOPES = ("output", "input")


def starred_key(scope: str, relpath: str) -> str:
    return f"{scope}/{relpath}"


def starred_index_path() -> Path:
    return get_assets_plus_root() / "starred.json"


def load_starred() -> dict[str, HiddenEntry]:
    path = starred_index_path()
    if not path.exists():
        return {}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}
    if not isinstance(raw, dict):
        return {}
    entries: dict[str, HiddenEntry] = {}
    for key, payload in raw.items():
        if not isinstance(payload, dict):
            continue
        try:
            entries[key] = HiddenEntry(
                relpath=key,
                mtime=int(payload.get("mtime", 0)),
                size=int(payload.get("size", 0)),
            )
        except (TypeError, ValueError):
            continue
    return entries


_starred_lock = threading.Lock()


def update_starred(
    updater: Callable[[dict[str, HiddenEntry]], dict[str, HiddenEntry]],
) -> dict[str, HiddenEntry]:
    """Atomically read starred.json, apply *updater* and write it back.

    Nothing is written when the updater leaves the content unchanged.
    """
    with _starred_lock:
        starred = load_starred()
        modified = updater(dict(starred))
        if modified == starred:
            return modified
        path = starred_index_path()
        tmp_path = path.with_suffix(".tmp")
        data = {
            key: {"mtime": entry.mtime, "size": entry.size}
            for key, entry in modified.items()
        }
        tmp_path.write_text(json.dumps(data, indent=2), encoding="utf-8")
        os.replace(str(tmp_path), str(path))
        return modified


def thumb_cache_dir() -> Path:
    path = get_assets_plus_root() / "thumb_cache"
    path.mkdir(parents=True, exist_ok=True)
    return path


MAX_CACHE_SIZE_MB = 500


def evict_thumb_cache() -> int:
    """Remove oldest cached thumbnails until total size ≤ MAX_CACHE_SIZE_MB.

    Returns the number of files removed.
    """
    cache_dir = thumb_cache_dir()
    entries = sorted(
        cache_dir.iterdir(),
        key=lambda p: p.stat().st_mtime,  # oldest first
    )
    total_size = sum(p.stat().st_size for p in entries)
    max_bytes = MAX_CACHE_SIZE_MB * 1024 * 1024
    removed = 0
    for entry in entries:
        if total_size <= max_bytes:
            break
        try:
            size = entry.stat().st_size
            entry.unlink()
            total_size -= size
            removed += 1
        except OSError:
            pass
    return removed
