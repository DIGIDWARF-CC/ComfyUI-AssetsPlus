from __future__ import annotations

import json
import logging
import os
import re
from pathlib import Path
from typing import Any

import folder_paths
from aiohttp import web

LOGGER = logging.getLogger("assets_plus")
LANGUAGE_CODE_RE = re.compile(r"^[A-Za-z0-9_-]+$")


def get_output_directory() -> Path:
    return Path(folder_paths.get_output_directory())


def get_input_directory() -> Path:
    return Path(folder_paths.get_input_directory())


def get_extension_root() -> Path:
    return Path(__file__).resolve().parent.parent


def get_i18n_directory() -> Path:
    return get_extension_root() / "i18n"


def load_translation_file(path: Path) -> dict[str, Any]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        LOGGER.warning("Assets+ failed to load translation %s: %s", path.name, error)
        return {}
    if not isinstance(raw, dict):
        LOGGER.warning("Assets+ translation %s is not a JSON object", path.name)
        return {}
    return raw


def is_within(base: Path, path: Path) -> bool:
    try:
        base_resolved = base.resolve()
        path_resolved = path.resolve()
    except FileNotFoundError:
        base_resolved = base
        path_resolved = path
    try:
        return os.path.commonpath([base_resolved, path_resolved]) == str(base_resolved)
    except ValueError:
        return False


def resolve_relpath(relpath: str, base_dir: Path) -> Path:
    if os.path.isabs(relpath):
        raise web.HTTPBadRequest(text="Absolute paths are not allowed")
    candidate = base_dir / relpath
    if not is_within(base_dir, candidate):
        raise web.HTTPBadRequest(text="Path traversal detected")
    return candidate


def allowed_extension(filename: str, extensions: tuple[str, ...]) -> bool:
    return filename.lower().endswith(tuple(ext.lower() for ext in extensions))
