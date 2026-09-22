from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Generator

from PIL import Image
from PIL import ImageDraw

from .storage import HiddenEntry, thumb_cache_dir
from .metadata import read_workflow_metadata
from .paths import allowed_extension


_KIND_BY_EXT = {
    ".png": "image", ".jpg": "image", ".jpeg": "image", ".webp": "image",
    ".gif": "image", ".bmp": "image", ".tiff": "image",
    ".mp4": "video", ".webm": "video", ".mov": "video", ".mkv": "video",
    ".mp3": "audio", ".flac": "audio", ".wav": "audio", ".ogg": "audio", ".m4a": "audio",
    ".glb": "mesh", ".gltf": "mesh",
}


def _classify_kind(path: Path) -> str:
    return _KIND_BY_EXT.get(path.suffix.lower(), "other")


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
