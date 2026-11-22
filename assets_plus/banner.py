"""Start-up banner: which Assets+ this is.

One line, printed once when the extension loads, from the version in the extension's own ``pyproject.toml``.
Nothing else is read and nothing is requested: whether a newer version exists is the business of ComfyUI-Manager.
"""
from __future__ import annotations

import logging
import re
import sys
from pathlib import Path

from .logs import BANNER_LOGGER_NAME

PACKAGE_ROOT = Path(__file__).resolve().parent.parent
_VERSION_RE = re.compile(r'^version\s*=\s*"(\d+\.\d+\.\d+)"', re.MULTILINE)


def local_version(root: Path = PACKAGE_ROOT) -> str | None:
    try:
        match = _VERSION_RE.search((root / "pyproject.toml").read_text(encoding="utf-8"))
    except OSError:
        return None
    return match.group(1) if match else None


def compose_banner(version: str | None, *, color: bool = False) -> str:
    """The banner text. Pure, so it can be tested."""
    def paint(code: str, text: str) -> str:
        return f"\033[{code}m{text}\033[0m" if color else text

    shown = paint("1", f"v{version}") if version else paint("33", "unknown version")
    return f"{paint('1;36', 'Assets+')} {shown} · ready"


def _use_color() -> bool:
    try:
        return bool(sys.stdout.isatty())
    except (AttributeError, ValueError):
        return False


def announce(root: Path = PACKAGE_ROOT) -> str:
    """Log the banner (unless the log level is ``silent``). Returns the text."""
    text = compose_banner(local_version(root), color=_use_color())
    logging.getLogger(BANNER_LOGGER_NAME).info(text)
    return text
