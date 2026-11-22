"""Housekeeping for the hidden/starred indexes.

Both indexes remember files by relative path plus a (mtime, size) fingerprint.
Files come and go behind our back (manual deletes, ComfyUI's own Assets panel,
nodes that clean folders), so every listing reconciles the indexes with what is
actually on disk:

* an entry whose file vanished is dropped (orphan);
* an orphan whose fingerprint matches exactly one new, unmarked file is treated
  as a move/rename and follows the file;
* an entry whose file changed in place is dropped for *strict* indexes (hidden:
  a replaced file must not stay hidden) and re-fingerprinted for lenient ones
  (starred: editing an image must not silently lose its star).
"""
from __future__ import annotations

import os
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

from .storage import HiddenEntry

Fingerprint = tuple[int, int]  # (mtime, size)


@dataclass(frozen=True)
class MarkScope:
    """Which entries of an index belong to one gallery root."""

    base_dir: Path
    prefix: str = ""
    other_prefix: str | None = None

    def owns(self, key: str) -> bool:
        if not key.startswith(self.prefix):
            return False
        return not (self.other_prefix and key.startswith(self.other_prefix))

    def relpath_of(self, key: str) -> str:
        return key[len(self.prefix):]

    def key_of(self, relpath: str) -> str:
        return f"{self.prefix}{relpath}"


def _fingerprint(base_dir: Path, base_resolved: Path, relpath: str) -> Fingerprint | None:
    try:
        target = (base_dir / relpath).resolve()
        if base_resolved != target and base_resolved not in target.parents:
            return None
        stat = os.stat(target)
    except (OSError, ValueError):
        return None
    return int(stat.st_mtime), stat.st_size


def _root_is_available(base_dir: Path) -> bool:
    """False for a missing or empty root (e.g. an unmounted drive)."""
    try:
        with os.scandir(str(base_dir)) as entries:
            return any(True for _ in entries)
    except OSError:
        return False


def reconcile_marks(
    entries: dict[str, HiddenEntry],
    scope: MarkScope,
    scanned: dict[str, Fingerprint],
    *,
    strict: bool,
) -> dict[str, HiddenEntry]:
    """Return *entries* reconciled with the disk for one gallery scope.

    *scanned* maps relpath -> fingerprint for every file the listing walked.
    Entries of other scopes pass through untouched.  Nothing is dropped while
    the gallery root looks unavailable, so a detached drive cannot wipe the index.
    """
    owned = {key: entry for key, entry in entries.items() if scope.owns(key)}
    if not owned or not _root_is_available(scope.base_dir):
        return entries

    try:
        base_resolved = scope.base_dir.resolve()
    except OSError:
        return entries

    kept: dict[str, HiddenEntry] = {}
    orphans: list[HiddenEntry] = []
    for key, entry in owned.items():
        relpath = scope.relpath_of(key)
        # The listing already knows the fingerprint of every file it walked: no need to stat each mark again.
        current = scanned.get(relpath) or _fingerprint(scope.base_dir, base_resolved, relpath)
        if current is None:
            orphans.append(entry)
        elif current == (entry.mtime, entry.size):
            kept[key] = entry
        elif not strict:
            kept[key] = HiddenEntry(relpath=key, mtime=current[0], size=current[1])
        # strict + changed in place: the entry is stale, drop it

    if orphans:
        marked = {scope.relpath_of(key) for key in kept}
        by_fingerprint: dict[Fingerprint, list[str]] = defaultdict(list)
        for relpath, fingerprint in scanned.items():
            if relpath not in marked:
                by_fingerprint[fingerprint].append(relpath)
        for entry in orphans:
            candidates = by_fingerprint.get((entry.mtime, entry.size), [])
            if len(candidates) != 1:
                continue  # nothing found, or ambiguous: let the orphan go
            moved_to = candidates[0]
            new_key = scope.key_of(moved_to)
            kept[new_key] = HiddenEntry(relpath=new_key, mtime=entry.mtime, size=entry.size)
            by_fingerprint[(entry.mtime, entry.size)] = []

    result = {key: entry for key, entry in entries.items() if not scope.owns(key)}
    result.update(kept)
    return result
