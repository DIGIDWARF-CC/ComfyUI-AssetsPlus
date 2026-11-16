from __future__ import annotations

from typing import Any

# (mtime, relpath, has_relpath, tier). ``tier`` is None for the plain
# newest-first cursor and 0/1 (starred/other) for the starred-first one.
Cursor = tuple[int, str, bool, "int | None"]

_STARRED_PREFIX = "s"


def parse_cursor(raw: str | None) -> Cursor | None:
    if not raw:
        return None
    tier: int | None = None
    if raw.startswith(_STARRED_PREFIX) and "|" in raw:
        tier_raw, raw = raw[len(_STARRED_PREFIX):].split("|", 1)
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


def encode_cursor(item: dict[str, Any], starred_first: bool = False) -> str:
    base = f"{item['mtime']}:{item['relpath']}"
    if starred_first:
        tier = 0 if item.get("starred") else 1
        return f"{_STARRED_PREFIX}{tier}|{base}"
    return base


def _order_key(item: dict[str, Any]) -> tuple[int, int, str]:
    return (0 if item.get("starred") else 1, -item["mtime"], item["relpath"])


def apply_cursor_filter(
    items: list[dict[str, Any]],
    cursor: Cursor | None,
) -> list[dict[str, Any]]:
    if not cursor:
        return items
    mtime, relpath, has_relpath, tier = cursor
    if tier is not None:
        # Starred-first order: (tier, newest first, relpath). Keep what comes after the cursor.
        marker = (tier, -mtime, relpath)
        return [item for item in items if _order_key(item) > marker]
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
    # mtime has one-second resolution: a file saved in the same second as the newest known
    # one must still be reported, so the boundary is inclusive (clients de-duplicate).
    return [item for item in items if item["mtime"] >= since]
