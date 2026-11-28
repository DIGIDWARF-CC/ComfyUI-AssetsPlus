"""Cached gallery snapshots and lazy, cursor-based paging over them.

A request used to walk the whole folder, stat every file, open every image to look for a workflow and
sort everything, only to return one page of 200 items. With tens of thousands of files that made every
scroll step cost seconds. Now:

* a *snapshot* (all matching files, sorted newest first) is kept in memory and reused while the folder
  tree is unchanged. Validity is checked by comparing the mtime of every directory in the tree (a few
  stat calls); a snapshot taken right after a change ("racy": directory mtimes within RACY_WINDOW of the
  scan time, so a second change could share the same timestamp) is never reused, and an old snapshot
  expires after MAX_AGE for file systems with unreliable directory mtimes;
* a page is produced lazily from the sorted rows: the cursor is found by bisecting, hidden and filtered
  rows are skipped while iterating, and iteration stops after ``limit + 1`` rows;
* workflow detection (opening images and videos) only runs for the rows of the returned page.
"""
from __future__ import annotations

import bisect
import itertools
import os
import threading
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from functools import cached_property
from pathlib import Path
from typing import Any, Iterable, Iterator

from .metadata import has_workflow
from .pagination import Cursor
from .scanner import _KIND_BY_EXT

R_REL, R_NAME, R_MTIME, R_SIZE, R_KIND = range(5)
Row = tuple  # (relpath, filename, mtime, size, kind)

MAX_AGE = 60.0
RACY_WINDOW = 2.0  # coarse (whole second) timestamps
RACY_WINDOW_FINE = 0.25  # timestamps with sub-second precision
MAX_SNAPSHOTS = 6

_workflow_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="assets-plus-meta")


@dataclass
class Snapshot:
    rows: list[Row]
    keys: list[tuple[int, str]]  # (-mtime, relpath) per row, for bisecting
    index: dict[str, int]  # relpath -> position in rows
    dir_stamps: tuple[tuple[str, int], ...]
    created: float
    racy: bool
    started: float = 0.0  # time.perf_counter() when the scan began

    @cached_property
    def scanned(self) -> dict[str, tuple[int, int]]:
        """relpath -> (mtime, size); only needed when orphaned index entries are reconciled."""
        return {row[R_REL]: (row[R_MTIME], row[R_SIZE]) for row in self.rows}


_cache: OrderedDict[tuple, Snapshot] = OrderedDict()
_lock = threading.RLock()


def scan_tree(
    base_dir: Path,
    extensions: tuple[str, ...],
    recursive: bool,
    scan_depth: int | None,
) -> tuple[list[Row], list[tuple[str, int]]]:
    """Walk the gallery once. Returns (rows sorted newest first, [(directory, mtime_ns)])."""
    suffixes = tuple(ext.lower() for ext in extensions)
    rows: list[Row] = []
    stamps: list[tuple[str, int]] = []

    def walk(directory: str, prefix: str, depth: int) -> None:
        if scan_depth is not None and depth > scan_depth:
            return
        try:
            # Stamp before listing: a change that races with the listing makes the stamp stale, never fresh.
            stamps.append((directory, os.stat(directory).st_mtime_ns))
            with os.scandir(directory) as entries:
                for entry in entries:
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            # A volume's trash can live inside the gallery root (e.g. Docker bind mounts).
                            # Do not list trashed assets or let them be trashed again on refresh.
                            if entry.name in (".Trash", ".Trashes") or (
                                entry.name.startswith(".Trash-") and entry.name[7:].isdigit()
                            ):
                                continue
                            if recursive and (scan_depth is None or depth < scan_depth):
                                walk(entry.path, f"{prefix}{entry.name}/", depth + 1)
                            continue
                        if not entry.is_file(follow_symlinks=False):
                            continue
                        name = entry.name
                        lowered = name.lower()
                        if not lowered.endswith(suffixes):
                            continue
                        stat = entry.stat()
                        kind = _KIND_BY_EXT.get(os.path.splitext(lowered)[1], "other")
                        rows.append((f"{prefix}{name}", name, int(stat.st_mtime), stat.st_size, kind))
                    except OSError:
                        continue
        except OSError:
            return

    walk(str(base_dir), "", 0)
    rows.sort(key=lambda row: (-row[R_MTIME], row[R_REL]))
    return rows, stamps


def _racy_window(stamp_ns: int) -> float:
    """How long after a directory changed its timestamp cannot be trusted to show a further change.

    A timestamp with a sub-second part comes from a file system with a fine clock (NTFS, ext4, APFS): a change
    within one clock tick (a few ms, up to ~16 ms on Windows) can share it. Whole seconds mean a coarse one (FAT,
    some network shares) where the tick is up to 2 s.
    """
    return RACY_WINDOW_FINE if stamp_ns % 1_000_000_000 else RACY_WINDOW


def _is_current(snapshot: Snapshot) -> bool:
    if snapshot.racy or time.monotonic() - snapshot.created >= MAX_AGE:
        return False
    for directory, stamp in snapshot.dir_stamps:
        try:
            if os.stat(directory).st_mtime_ns != stamp:
                return False
        except OSError:
            return False
    return True


def get_snapshot(
    base_dir: Path,
    extensions: tuple[str, ...],
    recursive: bool,
    scan_depth: int | None,
    *,
    fresh: bool = False,
) -> Snapshot:
    key = (str(base_dir), tuple(ext.lower() for ext in extensions), bool(recursive), scan_depth)
    arrived = time.perf_counter()  # not time.monotonic(): its tick on Windows is ~15 ms
    with _lock:
        snapshot = _cache.get(key)
        if snapshot is not None:
            # A scan that began after this request arrived is as new as a scan of our own, racy or not: requests
            # that queued behind one scan share it instead of each walking the whole tree again.
            shared = snapshot.started > arrived
            if shared or (not fresh and _is_current(snapshot)):
                _cache.move_to_end(key)
                return snapshot
        started = time.perf_counter()
        rows, stamps = scan_tree(base_dir, extensions, recursive, scan_depth)
        wall = time.time()
        racy = any(wall - stamp / 1e9 < _racy_window(stamp) for _, stamp in stamps)
        snapshot = Snapshot(
            started=started,
            rows=rows,
            keys=[(-row[R_MTIME], row[R_REL]) for row in rows],
            index={row[R_REL]: position for position, row in enumerate(rows)},
            dir_stamps=tuple(stamps),
            created=time.monotonic(),
            racy=racy,
        )
        _cache[key] = snapshot
        _cache.move_to_end(key)
        while len(_cache) > MAX_SNAPSHOTS:
            _cache.popitem(last=False)
        return snapshot


def invalidate(base_dir: Path | None = None) -> None:
    """Forget snapshots (all, or those of one gallery root), e.g. after files were deleted or moved."""
    with _lock:
        if base_dir is None:
            _cache.clear()
            return
        prefix = str(base_dir)
        for key in [key for key in _cache if key[0] == prefix]:
            del _cache[key]


# --- ordered, lazily filtered iteration ---------------------------------------------------------------

@dataclass
class Filters:
    """What hides or restricts rows. ``hidden`` and ``starred`` hold relpaths."""

    hidden: frozenset[str] | set[str]
    starred: frozenset[str] | set[str]
    query: str = ""  # already stripped and lowercased
    starred_only: bool = False
    mtime_min: int | None = None  # keep rows with mtime >= mtime_min
    mtime_max: int | None = None  # keep rows with mtime < mtime_max

    def accepts(self, row: Row) -> bool:
        if row[R_REL] in self.hidden:
            return False
        if self.starred_only and row[R_REL] not in self.starred:
            return False
        if self.mtime_min is not None and row[R_MTIME] < self.mtime_min:
            return False
        if self.mtime_max is not None and row[R_MTIME] >= self.mtime_max:
            return False
        if self.query and self.query not in f"{row[R_NAME]} {row[R_REL]}".lower():
            return False
        return True


def _rows_from(
    snapshot: Snapshot,
    start: int,
    flt: Filters,
    *,
    starred: bool | None,
    floor: int | None,
) -> Iterator[Row]:
    """Rows in base order from *start*; *starred* selects only starred (True) / only other (False) rows."""
    rows = snapshot.rows
    # Rows are newest first, so a time range is a slice: skip what is too new, stop at what is too old.
    if flt.mtime_max is not None:
        start = max(start, bisect.bisect_left(snapshot.keys, (-(flt.mtime_max - 1), "")))
    if flt.mtime_min is not None:
        floor = flt.mtime_min if floor is None else max(floor, flt.mtime_min)
    for position in range(start, len(rows)):
        row = rows[position]
        if floor is not None and row[R_MTIME] < floor:
            return
        if starred is not None and (row[R_REL] in flt.starred) is not starred:
            continue
        if flt.accepts(row):
            yield row


def iter_visible(
    snapshot: Snapshot,
    flt: Filters,
    *,
    starred_first: bool = False,
    cursor: Cursor | None = None,
    since: int | None = None,
) -> Iterator[Row]:
    """Visible rows in display order, optionally after a cursor or newer than *since*."""
    keys = snapshot.keys
    if not starred_first:
        start = 0
        if since is None and cursor is not None:
            mtime, relpath, has_relpath, _tier = cursor
            marker = (-mtime, relpath if has_relpath else "\U0010ffff")
            start = bisect.bisect_right(keys, marker)
        yield from _rows_from(snapshot, start, flt, starred=None, floor=since)
        return

    # Starred rows come first (each tier is newest first), then everything else.
    starred_positions = sorted(
        snapshot.index[relpath] for relpath in flt.starred if relpath in snapshot.index
    )
    tier0_start = 0
    tier1_start = 0
    legacy = None
    if since is None and cursor is not None:
        mtime, relpath, has_relpath, tier = cursor
        if tier is None:
            legacy = cursor
        else:
            marker = (-mtime, relpath)
            if tier == 0:
                tier0_start = bisect.bisect_right([keys[p] for p in starred_positions], marker)
            else:
                tier0_start = len(starred_positions)
                tier1_start = bisect.bisect_right(keys, marker)

    def tier0() -> Iterator[Row]:
        for position in starred_positions[tier0_start:]:
            row = snapshot.rows[position]
            if since is not None and row[R_MTIME] < since:
                return
            if flt.accepts(row):
                yield row

    chained = itertools.chain(tier0(), _rows_from(snapshot, tier1_start, flt, starred=False, floor=since))
    if legacy is None:
        yield from chained
        return
    # Cursors without a tier come from older clients: compare by time only, like the old behaviour.
    mtime, relpath, has_relpath, _ = legacy
    for row in chained:
        if has_relpath:
            if row[R_MTIME] < mtime or (row[R_MTIME] == mtime and row[R_REL] > relpath):
                yield row
        elif row[R_MTIME] < mtime:
            yield row


def histogram(snapshot: Snapshot, flt: Filters, edges: list[int]) -> dict[str, Any]:
    """How many visible rows fall into each interval [edges[i], edges[i + 1]) (edges ascending), plus the oldest
    and newest visible mtime and the number of visible rows. Used by the date groups and the calendar."""
    counts = [0] * max(0, len(edges) - 1)
    total = 0
    oldest = newest = None
    for row in snapshot.rows:
        if not flt.accepts(row):
            continue
        mtime = row[R_MTIME]
        total += 1
        oldest = mtime if oldest is None or mtime < oldest else oldest
        newest = mtime if newest is None or mtime > newest else newest
        slot = bisect.bisect_right(edges, mtime) - 1
        if 0 <= slot < len(counts):
            counts[slot] += 1
    return {"counts": counts, "min": oldest, "max": newest, "total": total}


# --- turning rows into API items ----------------------------------------------------------------------

def build_items(
    base_dir: Path, rows: Iterable[Row], starred: Iterable[str] | set[str], *, detect_workflows: bool = True
) -> list[dict[str, Any]]:
    """API items for *rows*; workflow detection (file reads, cached) happens here, for these rows only.
    ``detect_workflows=False`` skips the file reads (``has_workflow`` is then always false)."""
    rows = list(rows)
    starred = starred if isinstance(starred, (set, frozenset)) else set(starred)
    probes = (
        [(base_dir / row[R_REL], row[R_MTIME], row[R_SIZE]) for row in rows if row[R_KIND] in ("image", "video")]
        if detect_workflows
        else []
    )
    flags = dict(zip((probe[0] for probe in probes), _workflow_pool.map(lambda args: has_workflow(*args), probes)))
    items = []
    for row in rows:
        items.append({
            "relpath": row[R_REL],
            "filename": row[R_NAME],
            "mtime": row[R_MTIME],
            "size": row[R_SIZE],
            "type": row[R_KIND],
            "has_workflow": flags.get(base_dir / row[R_REL], False),
            "starred": row[R_REL] in starred,
        })
    return items
