from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

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


def thumb_cache_dir() -> Path:
    path = get_assets_plus_root() / "thumb_cache"
    path.mkdir(parents=True, exist_ok=True)
    return path
