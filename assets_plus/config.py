from __future__ import annotations

from dataclasses import dataclass
import json
import logging
from pathlib import Path
from typing import Any

import folder_paths


@dataclass(frozen=True)
class AssetsPlusConfig:
    allowed_extensions: tuple[str, ...] = (
        ".png",
        ".jpg",
        ".jpeg",
        ".webp",
        ".mp4",
        ".webm",
    )
    thumbnail_size: tuple[int, int] = (256, 256)
    list_limit: int = 500
    recursive: bool = True
    poll_seconds: int = 5
    default_delete_mode: str = "trash"
    scan_depth: int | None = None


DEFAULT_CONFIG = AssetsPlusConfig()

LOGGER = logging.getLogger("assets_plus")


def config_path() -> Path:
    user_dir = Path(folder_paths.get_user_directory())
    return user_dir / "__assets_plus" / "config.json"


def _coerce_thumbnail_size(value: Any) -> tuple[int, int] | None:
    if isinstance(value, (list, tuple)) and len(value) >= 2:
        try:
            width = int(value[0])
            height = int(value[1])
            return (width, height)
        except (TypeError, ValueError):
            return None
    if isinstance(value, (int, float)):
        size = int(value)
        return (size, size)
    return None


def _coerce_scan_depth(value: Any) -> int | None:
    if value is None:
        return None
    try:
        depth = int(value)
    except (TypeError, ValueError):
        return None
    if depth < 0:
        return None
    return depth


def load_config() -> AssetsPlusConfig:
    path = config_path()
    if not path.exists():
        return DEFAULT_CONFIG
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        LOGGER.warning("Assets+ config.json is invalid; using defaults.")
        return DEFAULT_CONFIG
    if not isinstance(raw, dict):
        return DEFAULT_CONFIG

    allowed_extensions = raw.get("allowed_extensions", DEFAULT_CONFIG.allowed_extensions)
    if isinstance(allowed_extensions, list):
        allowed_extensions = tuple(
            ext if str(ext).startswith(".") else f".{ext}" for ext in allowed_extensions
        )
    else:
        allowed_extensions = DEFAULT_CONFIG.allowed_extensions

    thumbnail_size = _coerce_thumbnail_size(raw.get("thumbnail_size")) or DEFAULT_CONFIG.thumbnail_size

    try:
        list_limit = int(raw.get("list_limit", DEFAULT_CONFIG.list_limit))
    except (TypeError, ValueError):
        list_limit = DEFAULT_CONFIG.list_limit

    recursive = raw.get("recursive", DEFAULT_CONFIG.recursive)
    if not isinstance(recursive, bool):
        recursive = DEFAULT_CONFIG.recursive

    try:
        poll_seconds = int(raw.get("poll_seconds", DEFAULT_CONFIG.poll_seconds))
    except (TypeError, ValueError):
        poll_seconds = DEFAULT_CONFIG.poll_seconds
    poll_seconds = max(1, poll_seconds)

    default_delete_mode = raw.get("default_delete_mode", DEFAULT_CONFIG.default_delete_mode)
    if default_delete_mode not in {"trash", "delete", "hide"}:
        default_delete_mode = DEFAULT_CONFIG.default_delete_mode

    scan_depth = _coerce_scan_depth(raw.get("scan_depth", DEFAULT_CONFIG.scan_depth))

    return AssetsPlusConfig(
        allowed_extensions=allowed_extensions,
        thumbnail_size=thumbnail_size,
        list_limit=list_limit,
        recursive=recursive,
        poll_seconds=poll_seconds,
        default_delete_mode=default_delete_mode,
        scan_depth=scan_depth,
    )
