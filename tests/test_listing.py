"""Tests for the snapshot cache and lazy paging. Run with:  python tests/test_listing.py <path-to-repo-root>

Uses plain asserts (pytest would collect the same ``test_*`` functions). ComfyUI itself is stubbed out.
"""
from __future__ import annotations

import os
import random
import sys
import tempfile
import time
import traceback
import types
from pathlib import Path
from unittest.mock import MagicMock

REPO = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent
WORK = Path(tempfile.mkdtemp(prefix="ap_listing_"))
USER = WORK / "user"
sys.modules["folder_paths"] = types.SimpleNamespace(
    get_user_directory=lambda: str(USER),
    get_output_directory=lambda: str(WORK / "out"),
    get_input_directory=lambda: str(WORK / "in"),
)
server = types.ModuleType("server")
server.PromptServer = types.SimpleNamespace(instance=types.SimpleNamespace(routes=MagicMock()))
sys.modules["server"] = server
sys.path.insert(0, str(REPO))
sys.path.insert(0, str(REPO / "tests"))

from assets_plus import handlers, listing  # noqa: E402
from assets_plus.pagination import encode_cursor, parse_cursor  # noqa: E402
import reference_listing as ref  # noqa: E402

EXTENSIONS = (".png", ".jpg", ".mp4", ".wav", ".glb")
OLD = time.time() - 3600


def make_gallery(root: Path, count: int, seed: int) -> list[str]:
    """Random nested gallery with many mtime ties; every directory is aged so snapshots are not racy."""
    rng = random.Random(seed)
    root.mkdir(parents=True, exist_ok=True)
    dirs = [root] + [root / "a", root / "a" / "b", root / "c", root / "Sub Dir"]
    for directory in dirs:
        directory.mkdir(parents=True, exist_ok=True)
    names = []
    for index in range(count):
        directory = rng.choice(dirs)
        ext = rng.choice([".png", ".png", ".png", ".jpg", ".mp4", ".wav", ".glb", ".txt"])
        name = f"{rng.choice(['cat', 'dog', 'Fox', 'sheet', 'x'])}_{index:04d}{ext}"
        path = directory / name
        path.write_bytes(b"x" * rng.randint(1, 50))
        stamp = 1_700_000_000 + rng.randint(0, count // 3)  # ties on purpose
        os.utime(path, (stamp, stamp))
        names.append(path.relative_to(root).as_posix())
    age_directories(root)
    return names


def age_directories(root: Path) -> None:
    for directory, _, _ in os.walk(root):
        os.utime(directory, (OLD, OLD))


def strip(item: dict) -> dict:
    return {key: value for key, value in item.items() if key != "has_workflow"}


def new_pages(root, *, hidden, starred, query, starred_first, limit, cursor_raw=None, since=None, extensions=EXTENSIONS):
    snapshot = listing.get_snapshot(root, extensions, True, None)
    flt = listing.Filters(hidden=hidden, starred=starred, query=query.strip().lower())
    latest = next(listing.iter_visible(snapshot, flt), None)
    ordered = listing.iter_visible(
        snapshot, flt, starred_first=starred_first, cursor=parse_cursor(cursor_raw), since=since
    )
    import itertools
    rows = list(itertools.islice(ordered, limit + 1 if limit else None))
    has_more = bool(limit) and len(rows) > limit
    if limit:
        rows = rows[:limit]
    items = listing.build_items(root, rows, flt.starred)
    return {
        "items": [strip(i) for i in items],
        "cursor": encode_cursor(items[-1], starred_first) if items else cursor_raw or "",
        "has_more": has_more,
        "latest_mtime": latest[listing.R_MTIME] if latest else 0,
    }


def test_pages_match_reference_for_random_galleries() -> None:
    for seed in range(6):
        root = WORK / f"gallery{seed}"
        make_gallery(root, 260, seed)
        files = ref.scan_files(root, EXTENSIONS, True, None)
        rng = random.Random(1000 + seed)
        relpaths = [f[0] for f in files]
        hidden = set(rng.sample(relpaths, 20))
        starred = set(rng.sample(relpaths, 25))
        for query in ("", "cat", "FOX_01", "sub dir", "zzz-none"):
            for starred_first in (False, True):
                for limit in (7, 50, 0):
                    cursor = None
                    reference_cursor = None
                    for _page in range(60):
                        expected = ref.reference_page(
                            files, hidden, starred, query=query, starred_first=starred_first,
                            cursor_raw=reference_cursor, since=None, limit=limit,
                        )
                        actual = new_pages(
                            root, hidden=hidden, starred=starred, query=query,
                            starred_first=starred_first, limit=limit, cursor_raw=cursor,
                        )
                        assert actual == expected, (seed, query, starred_first, limit, cursor)
                        if not expected["has_more"]:
                            break
                        cursor = reference_cursor = expected["cursor"]


def test_since_matches_reference() -> None:
    root = WORK / "gallery_since"
    make_gallery(root, 200, 42)
    files = ref.scan_files(root, EXTENSIONS, True, None)
    rng = random.Random(7)
    starred = set(rng.sample([f[0] for f in files], 15))
    mtimes = sorted({f[2] for f in files})
    for since in (mtimes[0], mtimes[len(mtimes) // 2], mtimes[-1], mtimes[-1] + 1):
        for starred_first in (False, True):
            expected = ref.reference_page(
                files, set(), starred, query="", starred_first=starred_first,
                cursor_raw=None, since=since, limit=0,
            )
            actual = new_pages(root, hidden=set(), starred=starred, query="", starred_first=starred_first, limit=0, since=since)
            assert actual["items"] == expected["items"], (since, starred_first)


def test_legacy_cursor_formats_still_work() -> None:
    root = WORK / "gallery_legacy"
    make_gallery(root, 120, 3)
    files = ref.scan_files(root, EXTENSIONS, True, None)
    mid = sorted(files, key=lambda f: (-f[2], f[0]))[40]
    for cursor_raw in (str(mid[2]), f"{mid[2]}:{mid[0]}"):
        for starred_first in (False, True):
            starred = {mid[0]}
            expected = ref.reference_page(files, set(), starred, query="", starred_first=starred_first,
                                          cursor_raw=cursor_raw, since=None, limit=30)
            actual = new_pages(root, hidden=set(), starred=starred, query="", starred_first=starred_first,
                               limit=30, cursor_raw=cursor_raw)
            assert actual["items"] == expected["items"], (cursor_raw, starred_first)


def test_snapshot_is_reused_until_the_tree_changes() -> None:
    root = WORK / "gallery_cache"
    make_gallery(root, 30, 5)
    first = listing.get_snapshot(root, EXTENSIONS, True, None)
    assert not first.racy
    assert listing.get_snapshot(root, EXTENSIONS, True, None) is first, "unchanged tree must reuse the snapshot"

    new_file = root / "a" / "fresh_9999.png"
    new_file.write_bytes(b"y")
    second = listing.get_snapshot(root, EXTENSIONS, True, None)
    assert second is not first and "a/fresh_9999.png" in second.index, "added file must be seen"

    age_directories(root)
    third = listing.get_snapshot(root, EXTENSIONS, True, None)
    new_file.unlink()
    fourth = listing.get_snapshot(root, EXTENSIONS, True, None)
    assert "a/fresh_9999.png" in third.index and "a/fresh_9999.png" not in fourth.index, "deleted file must vanish"

    age_directories(root)
    listing.get_snapshot(root, EXTENSIONS, True, None)
    (root / "newdir").mkdir()
    (root / "newdir" / "deep.png").write_bytes(b"z")
    fifth = listing.get_snapshot(root, EXTENSIONS, True, None)
    assert "newdir/deep.png" in fifth.index, "a new subdirectory must be walked"


def test_racy_expired_fresh_and_invalidated_snapshots_are_rescanned() -> None:
    root = WORK / "gallery_racy"
    make_gallery(root, 10, 9)
    (root / "just_now.png").write_bytes(b"1")  # directory mtime is now: the next change could share its stamp
    racy = listing.get_snapshot(root, EXTENSIONS, True, None)
    assert racy.racy and listing.get_snapshot(root, EXTENSIONS, True, None) is not racy

    age_directories(root)
    stable = listing.get_snapshot(root, EXTENSIONS, True, None)
    assert not stable.racy and listing.get_snapshot(root, EXTENSIONS, True, None) is stable
    assert listing.get_snapshot(root, EXTENSIONS, True, None, fresh=True) is not stable

    stable = listing.get_snapshot(root, EXTENSIONS, True, None)
    listing.invalidate(root)
    assert listing.get_snapshot(root, EXTENSIONS, True, None) is not stable

    stable = listing.get_snapshot(root, EXTENSIONS, True, None)
    old_max_age = listing.MAX_AGE
    listing.MAX_AGE = 0.0
    try:
        assert listing.get_snapshot(root, EXTENSIONS, True, None) is not stable, "expired snapshot must be rescanned"
    finally:
        listing.MAX_AGE = old_max_age


def test_concurrent_requests_share_one_scan_even_when_racy() -> None:
    import threading

    root = WORK / "gallery_burst"
    make_gallery(root, 40, 13)
    listing.invalidate(root)
    (root / "just_now.png").write_bytes(b"1")  # racy: a snapshot of this tree is never reused by later requests
    scans = []
    original = listing.scan_tree

    def slow_scan(*args, **kwargs):
        scans.append(1)
        time.sleep(0.15)  # long enough for every worker to queue up behind the first scan
        return original(*args, **kwargs)

    listing.scan_tree = slow_scan
    results = []
    try:
        threads = [
            threading.Thread(target=lambda: results.append(listing.get_snapshot(root, EXTENSIONS, True, None)))
            for _ in range(6)
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
    finally:
        listing.scan_tree = original
    assert len(results) == 6 and results[0].racy
    assert len(scans) <= 2, f"{len(scans)} scans for 6 simultaneous requests (expected the first one, shared)"
    assert all(snap is results[-1] or snap is results[0] for snap in results)

    # a request that arrives after the shared scan finished does not reuse a racy snapshot
    last = results[-1]
    again = listing.get_snapshot(root, EXTENSIONS, True, None)
    assert not last.racy or again is not last


def test_marks_are_reconciled_once_per_snapshot_and_index_state() -> None:
    out = prepare_handler_gallery()
    everything = handlers._build_list_response(out, "", {"limit": "0"})
    starred = [item["relpath"] for item in everything["items"][:30]]
    handlers.set_starred_assets(out, "output", starred, True)

    calls = []
    original = handlers.reconcile_marks
    handlers.reconcile_marks = lambda *args, **kwargs: calls.append(1) or original(*args, **kwargs)
    try:
        for _ in range(5):
            page = handlers._build_list_response(out, "", {"limit": "40"})
        assert len(calls) <= 4, f"reconcile ran {len(calls)} times for 5 identical requests"
        before = len(calls)
        handlers._build_list_response(out, "", {"limit": "40"})
        assert len(calls) == before, "an unchanged snapshot and index must not be reconciled again"
        assert sum(1 for item in page["items"] if item["starred"]) == 30

        # a star toggle changes the index file: reconcile again, and the star is visible
        handlers.set_starred_assets(out, "output", starred[:1], False)
        again = handlers._build_list_response(out, "", {"limit": "40"})
        assert len(calls) > before and sum(1 for item in again["items"] if item["starred"]) == 29
    finally:
        handlers.reconcile_marks = original


def test_thumbnails_are_shared_between_simultaneous_requests_and_handle_odd_modes() -> None:
    import asyncio

    from PIL import Image

    folder = WORK / "thumbs"
    folder.mkdir(exist_ok=True)
    source = folder / "cmyk.tif"
    Image.new("CMYK", (600, 400), (10, 20, 30, 40)).save(source)
    cache_path = folder / "cmyk_thumb.png"
    cache_path.unlink(missing_ok=True)

    calls = []
    original = handlers._make_thumbnail

    def counting(*args):
        calls.append(1)
        time.sleep(0.1)
        return original(*args)

    handlers._make_thumbnail = counting

    async def burst() -> None:
        await asyncio.gather(*(handlers._generate_thumbnail(source, 128, 128, cache_path) for _ in range(8)))

    try:
        asyncio.run(burst())
    finally:
        handlers._make_thumbnail = original
    assert len(calls) == 1, f"{len(calls)} conversions for 8 simultaneous requests of one tile"
    assert not handlers._THUMB_INFLIGHT, "finished work must be forgotten"
    with Image.open(cache_path) as thumb:
        assert thumb.size[0] <= 128 and thumb.size[1] <= 128 and thumb.mode == "RGB"


def test_file_replaced_under_the_same_name_gets_a_new_fingerprint_and_thumbnail_key() -> None:
    out = prepare_handler_gallery()
    name = "ComfyUI_0015_.png"
    path = out / name
    path.write_bytes(b"first version")
    os.utime(path, (1_790_000_000, 1_790_000_000))
    first = handlers._build_list_response(out, "", {"limit": "0", "fresh": "1"})
    old = next(item for item in first["items"] if item["relpath"] == name)

    path.unlink()  # deleted behind our back, generated again under the same name a bit later
    path.write_bytes(b"second, longer version")
    os.utime(path, (1_790_000_030, 1_790_000_030))
    second = handlers._build_list_response(out, "", {"limit": "0", "fresh": "1"})
    new = next(item for item in second["items"] if item["relpath"] == name)
    assert (new["mtime"], new["size"]) != (old["mtime"], old["size"])
    assert sum(1 for item in second["items"] if item["relpath"] == name) == 1

    from assets_plus.metadata import build_thumb_cache_key

    keys = {build_thumb_cache_key(name, item["mtime"], item["size"], 256, 256) for item in (old, new)}
    assert len(keys) == 2, "the thumbnail cache must not serve the old file's thumbnail for the new one"

    # the incremental "since" poll reports the replacement too
    since = handlers._build_list_response(out, "", {"limit": "0", "since": str(old["mtime"])})
    assert name in [item["relpath"] for item in since["items"]]


def test_fine_timestamps_use_the_short_racy_window() -> None:
    assert listing._racy_window(1_790_000_000_123_456_789) == listing.RACY_WINDOW_FINE
    assert listing._racy_window(1_790_000_000_000_000_000) == listing.RACY_WINDOW


def test_workflow_detection_only_runs_for_the_returned_page() -> None:
    root = WORK / "gallery_wf"
    make_gallery(root, 150, 11)
    calls = []
    original = listing.has_workflow
    listing.has_workflow = lambda path, mtime, size: calls.append(path) or False
    try:
        page = new_pages(root, hidden=set(), starred=set(), query="", starred_first=False, limit=5)
    finally:
        listing.has_workflow = original
    assert len(page["items"]) == 5
    assert len(calls) <= 5, f"workflow detection ran for {len(calls)} files instead of at most 5"


def prepare_handler_gallery() -> Path:
    out = WORK / "out"
    if out.exists():
        for child in sorted(out.rglob("*"), reverse=True):
            child.unlink() if child.is_file() else child.rmdir()
    make_gallery(out, 80, 21)
    (WORK / "in").mkdir(exist_ok=True)
    listing.invalidate()
    return out


def test_handler_list_and_window_endpoints() -> None:
    out = prepare_handler_gallery()
    page1 = handlers._build_list_response(out, "", {"limit": "10"})
    assert len(page1["items"]) == 10 and page1["has_more"]
    page2 = handlers._build_list_response(out, "", {"limit": "10", "cursor": page1["cursor"]})
    assert page2["items"][0]["relpath"] != page1["items"][-1]["relpath"]
    everything = handlers._build_list_response(out, "", {"limit": "0"})
    total = len(everything["items"])
    assert total > 20

    # window around a file in the middle
    middle = everything["items"][total // 2]["relpath"]
    window = handlers._build_window_response(out, "", {"relpath": middle, "before": "3", "after": "4"})
    assert window["found"] and window["total"] == total
    assert [i["relpath"] for i in window["items"]] == [i["relpath"] for i in everything["items"][total // 2 - 3: total // 2 + 5]]
    assert window["start"] == total // 2 - 3 and window["has_before"] and window["has_after"]

    # tail and head anchors
    tail = handlers._build_window_response(out, "", {"anchor": "last", "before": "4"})
    assert [i["relpath"] for i in tail["items"]] == [i["relpath"] for i in everything["items"][-5:]]
    assert tail["has_before"] and not tail["has_after"]
    head = handlers._build_window_response(out, "", {"anchor": "first", "after": "4"})
    assert [i["relpath"] for i in head["items"]] == [i["relpath"] for i in everything["items"][:5]]
    assert not head["has_before"] and head["has_after"]

    # unknown file
    missing = handlers._build_window_response(out, "", {"relpath": "nope/none.png"})
    assert missing["found"] is False and missing["items"] == []

    # hidden file leaves lists and windows
    hidden_target = everything["items"][5]["relpath"]
    removed, failed, _ = handlers.delete_assets(out, [hidden_target], "hide")
    assert removed == [hidden_target] and not failed
    after_hide = handlers._build_list_response(out, "", {"limit": "0"})
    assert hidden_target not in [i["relpath"] for i in after_hide["items"]]
    assert handlers._build_window_response(out, "", {"relpath": hidden_target})["found"] is False


def test_delete_and_move_invalidate_the_snapshot() -> None:
    out = prepare_handler_gallery()
    before = handlers._build_list_response(out, "", {"limit": "0"})
    victim = before["items"][3]["relpath"]
    removed, failed, _ = handlers.delete_assets(out, [victim], "delete")
    assert removed == [victim]
    after = handlers._build_list_response(out, "", {"limit": "0"})
    assert victim not in [i["relpath"] for i in after["items"]] and len(after["items"]) == len(before["items"]) - 1

    mover = after["items"][2]["relpath"]
    moved, failed = handlers.move_assets_to_input(out, WORK / "in", [mover])
    assert moved and not failed
    after_move = handlers._build_list_response(out, "", {"limit": "0"})
    assert mover not in [i["relpath"] for i in after_move["items"]]
    imported = handlers._build_list_response(WORK / "in", "input/", {"limit": "0"})
    assert moved[0]["to"] in [i["relpath"] for i in imported["items"]]


def run() -> int:
    tests = [(name, fn) for name, fn in sorted(globals().items()) if name.startswith("test_") and callable(fn)]
    failures = 0
    for name, fn in tests:
        started = time.perf_counter()
        try:
            fn()
            print(f"ok   {name} ({time.perf_counter() - started:.2f}s)")
        except Exception:  # noqa: BLE001
            failures += 1
            print(f"FAIL {name}")
            traceback.print_exc()
    print("ALL OK" if not failures else f"{failures} FAILED")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(run())
