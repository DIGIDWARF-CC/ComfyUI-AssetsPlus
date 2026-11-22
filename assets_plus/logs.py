"""Log verbosity of the extension.

The default is quiet: a single start-up banner (see ``banner.py``), then only warnings and errors. The level is a
setting (config.json ``log_level``, changeable in ComfyUI's settings):

* ``silent``: errors only, no banner
* ``quiet`` (default): banner, then warnings and errors
* ``info``: also notable events (deletes, moves, stars, cache housekeeping)
* ``debug``: also every request
"""
from __future__ import annotations

import logging

LOGGER_NAME = "assets_plus"
BANNER_LOGGER_NAME = "assets_plus.banner"

LEVELS: dict[str, int] = {
    "silent": logging.ERROR,
    "quiet": logging.WARNING,
    "info": logging.INFO,
    "debug": logging.DEBUG,
}
DEFAULT_LEVEL = "quiet"


def coerce_level(value: object) -> str:
    """A valid level name, or the default for anything else."""
    if isinstance(value, str):
        name = value.strip().lower()
        if name in LEVELS:
            return name
    return DEFAULT_LEVEL


class _ShowDebugOnConsole(logging.Filter):
    """ComfyUI's console handler only prints INFO and above, so debug records would be dropped there.
    At the ``debug`` level they are passed on as INFO (they were asked for explicitly)."""

    def filter(self, record: logging.LogRecord) -> bool:
        if record.levelno == logging.DEBUG:
            record.levelno = logging.INFO
            record.levelname = "INFO"
        return True


_debug_filter = _ShowDebugOnConsole()


def apply_level(name: object) -> str:
    """Set the verbosity of every Assets+ logger. Returns the level name that is now in effect."""
    level = coerce_level(name)
    logger = logging.getLogger(LOGGER_NAME)
    logger.setLevel(LEVELS[level])
    if level == "debug":
        logger.addFilter(_debug_filter)
    else:
        logger.removeFilter(_debug_filter)
    # The banner is its own logger so it can be shown while the rest stays at WARNING.
    logging.getLogger(BANNER_LOGGER_NAME).setLevel(logging.CRITICAL + 1 if level == "silent" else logging.INFO)
    return level
