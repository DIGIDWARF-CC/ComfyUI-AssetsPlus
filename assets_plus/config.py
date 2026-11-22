from __future__ import annotations

from dataclasses import dataclass
import json
import logging
import os
import time
from pathlib import Path
from typing import Any

import folder_paths


# The formats Assets+ knows how to show, by kind. The settings page offers exactly these as check boxes.
FORMAT_GROUPS: dict[str, tuple[str, ...]] = {
    "images": (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tiff"),
    "video": (".mp4", ".webm", ".mov", ".mkv"),
    "audio": (".mp3", ".flac", ".wav", ".ogg", ".m4a"),
    "mesh": (".glb", ".gltf"),
}
KNOWN_EXTENSIONS: tuple[str, ...] = tuple(ext for group in FORMAT_GROUPS.values() for ext in group)

# Keys older versions understood (or that were only ever dumped into the file by hand or by tools). They are
# removed from config.json once, when it is first read.
OBSOLETE_KEYS = ("poll_seconds", "thumbnail_size")


@dataclass(frozen=True)
class AssetsPlusConfig:
    allowed_extensions: tuple[str, ...] = KNOWN_EXTENSIONS
    thumbnail_quality: str = "low"
    list_limit: int = 200
    recursive: bool = True
    default_delete_mode: str = "trash"
    scan_depth: int | None = None
    thumbnail_cache_mb: int = 500
    log_level: str = "quiet"


LOG_LEVELS = ("silent", "quiet", "info", "debug")
DEFAULT_CONFIG = AssetsPlusConfig()
THUMBNAIL_QUALITY_SIZES: dict[str, tuple[int, int]] = {
    "low": (256, 256),
    "high": (512, 512),
}
DEFAULT_THUMBNAIL_QUALITY = "low"

_config_cache: AssetsPlusConfig | None = None
_config_cache_ts: float = 0.0
CONFIG_CACHE_TTL: float = 15.0

LOGGER = logging.getLogger("assets_plus")


def config_path() -> Path:
    user_dir = Path(folder_paths.get_user_directory())
    return user_dir / "__assets_plus" / "config.json"


def _coerce_thumbnail_quality(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.lower().strip()
    if normalized in THUMBNAIL_QUALITY_SIZES:
        return normalized
    return None


def _infer_quality_from_size(value: Any) -> str | None:
    if isinstance(value, (list, tuple)) and len(value) >= 2:
        try:
            width = int(value[0])
            height = int(value[1])
            size = max(width, height)
        except (TypeError, ValueError):
            return None
    elif isinstance(value, (int, float)):
        try:
            size = int(value)
        except (TypeError, ValueError):
            return None
    else:
        return None
    return "high" if size >= 512 else "low"


def thumbnail_size_from_quality(quality: str | None) -> tuple[int, int]:
    resolved = (quality or "").lower().strip()
    return THUMBNAIL_QUALITY_SIZES.get(resolved, THUMBNAIL_QUALITY_SIZES[DEFAULT_THUMBNAIL_QUALITY])


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


def normalize_extensions(values: Any) -> tuple[str, ...]:
    """Lower-case, dot-prefixed, without duplicates, in the given order. Garbage gives an empty tuple."""
    if not isinstance(values, (list, tuple)):
        return ()
    seen: dict[str, None] = {}
    for value in values:
        text = str(value).strip().lower()
        if not text or text == ".":
            continue
        seen[text if text.startswith(".") else f".{text}"] = None
    return tuple(seen)


_obsolete_keys_checked = False


def _drop_obsolete_keys(path: Path, raw: dict[str, Any]) -> dict[str, Any]:
    """Remove OBSOLETE_KEYS from the file (once per process). The old thumbnail size becomes a quality first."""
    global _obsolete_keys_checked
    if _obsolete_keys_checked:
        return raw
    _obsolete_keys_checked = True
    stale = [key for key in OBSOLETE_KEYS if key in raw]
    if not stale:
        return raw
    cleaned = {key: value for key, value in raw.items() if key not in OBSOLETE_KEYS}
    if "thumbnail_quality" not in cleaned:
        quality = _infer_quality_from_size(raw.get("thumbnail_size"))
        if quality:
            cleaned["thumbnail_quality"] = quality
    try:
        tmp_path = path.with_suffix(".tmp")
        tmp_path.write_text(json.dumps(cleaned, indent=2, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp_path, path)
        LOGGER.info("[Assets+] Removed obsolete keys from config.json: %s", ", ".join(stale))
    except OSError:
        LOGGER.warning("Assets+ could not clean obsolete keys from config.json.", exc_info=True)
    return cleaned


def load_config() -> AssetsPlusConfig:
    global _config_cache, _config_cache_ts

    now = time.monotonic()
    if _config_cache is not None and now - _config_cache_ts < CONFIG_CACHE_TTL:
        return _config_cache

    path = config_path()
    if not path.exists():
        _config_cache = DEFAULT_CONFIG
        _config_cache_ts = now
        return DEFAULT_CONFIG
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        LOGGER.warning("Assets+ config.json is invalid; using defaults.")
        _config_cache = DEFAULT_CONFIG
        _config_cache_ts = now
        return DEFAULT_CONFIG
    if not isinstance(raw, dict):
        _config_cache = DEFAULT_CONFIG
        _config_cache_ts = now
        return DEFAULT_CONFIG
    raw = _drop_obsolete_keys(path, raw)

    allowed_extensions = normalize_extensions(raw.get("allowed_extensions")) or DEFAULT_CONFIG.allowed_extensions

    thumbnail_quality = _coerce_thumbnail_quality(raw.get("thumbnail_quality"))
    if not thumbnail_quality:
        thumbnail_quality = DEFAULT_CONFIG.thumbnail_quality

    try:
        list_limit = int(raw.get("list_limit", DEFAULT_CONFIG.list_limit))
    except (TypeError, ValueError):
        list_limit = DEFAULT_CONFIG.list_limit
    if list_limit <= 0:
        list_limit = DEFAULT_CONFIG.list_limit

    recursive = raw.get("recursive", DEFAULT_CONFIG.recursive)
    if not isinstance(recursive, bool):
        recursive = DEFAULT_CONFIG.recursive

    default_delete_mode = raw.get("default_delete_mode", DEFAULT_CONFIG.default_delete_mode)
    if default_delete_mode not in {"trash", "delete", "hide"}:
        default_delete_mode = DEFAULT_CONFIG.default_delete_mode

    scan_depth = _coerce_scan_depth(raw.get("scan_depth", DEFAULT_CONFIG.scan_depth))

    try:
        thumbnail_cache_mb = int(raw.get("thumbnail_cache_mb", DEFAULT_CONFIG.thumbnail_cache_mb))
    except (TypeError, ValueError):
        thumbnail_cache_mb = DEFAULT_CONFIG.thumbnail_cache_mb
    thumbnail_cache_mb = min(max(thumbnail_cache_mb, 32), 100_000)

    log_level = str(raw.get("log_level", DEFAULT_CONFIG.log_level)).strip().lower()
    if log_level not in LOG_LEVELS:
        log_level = DEFAULT_CONFIG.log_level

    config = AssetsPlusConfig(
        allowed_extensions=allowed_extensions,
        thumbnail_quality=thumbnail_quality,
        list_limit=list_limit,
        recursive=recursive,
        default_delete_mode=default_delete_mode,
        scan_depth=scan_depth,
        thumbnail_cache_mb=thumbnail_cache_mb,
        log_level=log_level,
    )
    _config_cache = config
    _config_cache_ts = now
    return config


def save_config_value(key: str, value: Any) -> None:
    """Write one key into config.json, keeping every other key as it is. ``None`` removes the key."""
    global _config_cache
    path = config_path()
    raw: dict[str, Any] = {}
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(loaded, dict):
            raw = loaded
    except (OSError, json.JSONDecodeError):
        pass
    for stale in OBSOLETE_KEYS:
        raw.pop(stale, None)
    if value is None:
        raw.pop(key, None)
    else:
        raw[key] = value
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(".tmp")
    tmp_path.write_text(json.dumps(raw, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp_path, path)
    _config_cache = None  # the next load_config() reads the file again


def save_allowed_extensions(selected: Any) -> tuple[str, ...]:
    """Store which formats the gallery shows.

    ``selected`` is the list of known formats that are switched on. Extensions in config.json that Assets+ does not
    know (added by hand) are kept. Everything on means "follow the defaults", so the key is dropped and formats
    added in later versions appear by themselves. Raises ``ValueError`` when nothing would be left.
    """
    chosen = normalize_extensions(selected)
    custom = tuple(ext for ext in load_config().allowed_extensions if ext not in KNOWN_EXTENSIONS)
    result = tuple(ext for ext in KNOWN_EXTENSIONS if ext in chosen) + custom
    if not result:
        raise ValueError("at least one format must stay enabled")
    if tuple(sorted(result)) == tuple(sorted(KNOWN_EXTENSIONS)):
        save_config_value("allowed_extensions", None)
    else:
        save_config_value("allowed_extensions", list(result))
    return load_config().allowed_extensions

