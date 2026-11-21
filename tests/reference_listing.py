"""The straightforward (slow) listing logic that production code used before the performance overhaul.

It is kept as an oracle: tests generate random galleries and assert that the cached, lazily paginated
implementation returns exactly what this simple implementation returns.
"""
from __future__ import annotations

import os
from pathlib import Path

_KIND_BY_EXT = {
    ".png": "image", ".jpg": "image", ".jpeg": "image", ".webp": "image",
    ".gif": "image", ".bmp": "image", ".tiff": "image",
    ".mp4": "video", ".webm": "video", ".mov": "video", ".mkv": "video",
    ".mp3": "audio", ".flac": "audio", ".wav": "audio", ".ogg": "audio", ".m4a": "audio",
    ".glb": "mesh", ".gltf": "mesh",
}


def scan_files(base_dir: Path, extensions, recursive, scan_depth):
    """Yield-all version of the old walker: [(relpath, path, mtime, size)]."""
    out = []

    def _scan(directory: Path, depth: int = 0) -> None:
        if scan_depth is not None and depth > scan_depth:
            return
        try:
            with os.scandir(str(directory)) as it:
                for entry in it:
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            if recursive and (scan_depth is None or depth < scan_depth):
                                _scan(Path(entry.path), depth + 1)
                            continue
                        if not entry.is_file(follow_symlinks=False):
                            continue
                        path = Path(entry.path)
                        if not path.name.lower().endswith(tuple(e.lower() for e in extensions)):
                            continue
                        stat_result = entry.stat()
                        relpath = path.relative_to(base_dir).as_posix()
                        out.append((relpath, path, int(stat_result.st_mtime), stat_result.st_size))
                    except OSError:
                        continue
        except OSError:
            return

    _scan(base_dir)
    return out


def reference_items(files, hidden_relpaths, starred_relpaths, query):
    """The old list_directory_items without workflow detection."""
    needle = query.strip().lower() if query else ""
    items = []
    for relpath, path, mtime, size in files:
        if needle and needle not in f"{path.name} {relpath}".lower():
            continue
        if relpath in hidden_relpaths:
            continue
        items.append({
            "relpath": relpath,
            "filename": path.name,
            "mtime": mtime,
            "size": size,
            "type": _KIND_BY_EXT.get(path.suffix.lower(), "other"),
            "starred": relpath in starred_relpaths,
        })
    items.sort(key=lambda item: (-item["mtime"], item["relpath"]))
    return items


# --- the old pagination helpers -------------------------------------------------------------------

def parse_cursor(raw):
    if not raw:
        return None
    tier = None
    if raw.startswith("s") and "|" in raw:
        tier_raw, raw = raw[1:].split("|", 1)
        if tier_raw not in {"0", "1"}:
            return None
        tier = int(tier_raw)
    if ":" in raw:
        mtime_raw, relpath = raw.split(":", 1)
        try:
            return int(mtime_raw), relpath, True, tier
        except ValueError:
            return None
    try:
        return int(raw), "", False, tier
    except ValueError:
        return None


def encode_cursor(item, starred_first=False):
    base = f"{item['mtime']}:{item['relpath']}"
    if starred_first:
        return f"s{0 if item.get('starred') else 1}|{base}"
    return base


def _order_key(item):
    return (0 if item.get("starred") else 1, -item["mtime"], item["relpath"])


def apply_cursor_filter(items, cursor):
    if not cursor:
        return items
    mtime, relpath, has_relpath, tier = cursor
    if tier is not None:
        marker = (tier, -mtime, relpath)
        return [item for item in items if _order_key(item) > marker]
    if has_relpath:
        return [
            item for item in items
            if item["mtime"] < mtime or (item["mtime"] == mtime and item["relpath"] > relpath)
        ]
    return [item for item in items if item["mtime"] < mtime]


def reference_page(files, hidden_relpaths, starred_relpaths, *, query, starred_first, cursor_raw, since, limit):
    """What the old _build_list_response returned (since boundary made inclusive, as in the new code)."""
    items = reference_items(files, hidden_relpaths, starred_relpaths, query)
    latest_mtime = items[0]["mtime"] if items else 0
    if starred_first:
        items.sort(key=lambda item: not item["starred"])
    if since is not None:
        items = [item for item in items if item["mtime"] >= since]
    else:
        items = apply_cursor_filter(items, parse_cursor(cursor_raw))
    has_more = False
    if limit:
        has_more = len(items) > limit
        items = items[:limit]
    next_cursor = encode_cursor(items[-1], starred_first) if items else cursor_raw or ""
    return {"items": items, "cursor": next_cursor, "has_more": has_more, "latest_mtime": latest_mtime}
