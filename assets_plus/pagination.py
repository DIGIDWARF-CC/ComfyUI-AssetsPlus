from __future__ import annotations

from typing import Any


def parse_cursor(raw: str | None) -> tuple[int, str, bool] | None:
    if not raw:
        return None
    if ":" in raw:
        mtime_raw, relpath = raw.split(":", 1)
        try:
            return int(mtime_raw), relpath, True
        except ValueError:
            return None
    try:
        return int(raw), "", False
    except ValueError:
        return None


def encode_cursor(item: dict[str, Any]) -> str:
    return f"{item['mtime']}:{item['relpath']}"


def apply_cursor_filter(
    items: list[dict[str, Any]],
    cursor: tuple[int, str, bool] | None,
) -> list[dict[str, Any]]:
    if not cursor:
        return items
    mtime, relpath, has_relpath = cursor
    if has_relpath:
        return [
            item
            for item in items
            if item["mtime"] < mtime or (item["mtime"] == mtime and item["relpath"] > relpath)
        ]
    return [item for item in items if item["mtime"] < mtime]


def apply_since_filter(
    items: list[dict[str, Any]],
    since: int | None,
) -> list[dict[str, Any]]:
    if since is None:
        return items
    return [item for item in items if item["mtime"] > since]
