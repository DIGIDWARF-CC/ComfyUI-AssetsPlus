"""Tests for the snapshot cache and lazy paging. Run with:  python tests/test_listing.py <path-to-repo-root>

Uses plain asserts (pytest would collect the same ``test_*`` functions). ComfyUI itself is stubbed out.
"""
from __future__ import annotations

import json
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


def make_noise_image(path: Path, size: int = 400, mode: str = "RGB") -> None:
    from PIL import Image

    channels = {"RGB": 3, "RGBA": 4, "L": 1}[mode]
    Image.frombytes(mode, (size, size), os.urandom(size * size * channels)).save(path)


def test_thumbnails_are_shared_between_simultaneous_requests_and_handle_odd_modes() -> None:
    import asyncio

    from PIL import Image

    from assets_plus import thumbcache

    folder = WORK / "thumbs"
    folder.mkdir(exist_ok=True)
    source = folder / "cmyk.tif"
    Image.new("CMYK", (600, 400), (10, 20, 30, 40)).save(source)
    key = thumbcache.cache_key("output", "cmyk.tif", 1, 2, 128, 128)

    calls = []
    original = thumbcache.write_thumbnail

    def counting(*args):
        calls.append(1)
        time.sleep(0.1)
        return original(*args)

    thumbcache.write_thumbnail = counting

    class FakeTransport:
        def __init__(self) -> None:
            self.closed = False

        def is_closing(self) -> bool:
            return self.closed

    class FakeRequest:
        def __init__(self) -> None:
            self.transport = FakeTransport()

    async def burst() -> list:
        return await asyncio.gather(*(handlers._generate_thumbnail(FakeRequest(), source, 128, 128, key) for _ in range(8)))

    try:
        results = asyncio.run(burst())
    finally:
        thumbcache.write_thumbnail = original
    assert len(calls) == 1, f"{len(calls)} conversions for 8 simultaneous requests of one tile"
    assert not handlers._THUMB_INFLIGHT, "finished work must be forgotten"
    assert all(path == results[0] for path in results) and thumbcache.lookup(key) == results[0]
    with Image.open(results[0]) as thumb:
        assert thumb.format == "WEBP" and thumb.size[0] <= 128 and thumb.size[1] <= 128 and thumb.mode == "RGB"


def test_thumbnail_queue_runs_newest_first_and_drops_abandoned_tiles() -> None:
    import asyncio
    import threading

    from PIL import Image

    from assets_plus import thumbcache

    folder = WORK / "thumbs_queue"
    folder.mkdir(exist_ok=True)
    sources = []
    for index in range(8):
        source = folder / f"tile{index}.png"
        Image.new("RGB", (64, 64), (index * 20, 0, 0)).save(source)
        sources.append(source)

    started: list[str] = []
    gate = threading.Event()
    original = thumbcache.write_thumbnail

    def slow(path, *args):
        started.append(path.name)
        gate.wait(5)
        return original(path, *args)

    class FakeTransport:
        closing = False

        def is_closing(self) -> bool:
            return self.closing

    class FakeRequest:
        def __init__(self) -> None:
            self.transport = FakeTransport()

    async def scenario() -> tuple[list, list]:
        requests = [FakeRequest() for _ in sources]
        keys = [thumbcache.cache_key("output", f"queue{index}", 1, 2, 32, 32) for index in range(len(sources))]
        tasks = [
            asyncio.ensure_future(handlers._generate_thumbnail(request, source, 32, 32, key))
            for request, source, key in zip(requests, sources, keys)
        ]
        await asyncio.sleep(0.2)  # the first three occupy the workers, the other five wait
        requests[7].transport.closing = True  # the newest tile: its client already left
        requests[5].transport.closing = True
        gate.set()
        results = await asyncio.gather(*tasks, return_exceptions=True)
        return results, keys

    thumbcache.write_thumbnail = slow
    try:
        results, _keys = asyncio.run(scenario())
    finally:
        thumbcache.write_thumbnail = original
    assert started[:3] == ["tile0.png", "tile1.png", "tile2.png"], started
    # Waiting tiles run newest first; the two whose clients left are never rendered.
    assert started[3:] == ["tile6.png", "tile4.png", "tile3.png"], started
    for index in (5, 7):
        assert isinstance(results[index], handlers.ThumbnailDropped), results[index]
    for index in (0, 1, 2, 3, 4, 6):
        assert not isinstance(results[index], BaseException), results[index]
    assert not handlers._THUMB_INFLIGHT and not handlers._THUMB_PENDING


def test_thumbnail_cache_layout_format_and_keys() -> None:
    from PIL import Image

    from assets_plus import thumbcache

    folder = WORK / "thumbs_layout"
    folder.mkdir(exist_ok=True)
    plain = folder / "photo.png"
    make_noise_image(plain, 500)
    alpha = folder / "alpha.png"
    make_noise_image(alpha, 300, "RGBA")
    tall = folder / "tall.jpg"
    exif = Image.Exif()
    exif[0x0112] = 6  # stored rotated: shown turned by 90 degrees
    Image.frombytes("RGB", (200, 100), os.urandom(200 * 100 * 3)).save(tall, exif=exif)

    key = thumbcache.cache_key("output", "photo.png", 5, 6, 256, 256)
    path = thumbcache.write_thumbnail(plain, 256, 256, key)
    assert path == thumbcache.entry_path(key) and path.parent.name == key[:2] and path.suffix == ".webp"
    assert path.stat().st_size < plain.stat().st_size / 3, "the thumbnail must be much smaller than the noisy source"
    with Image.open(path) as thumb:
        assert thumb.size == (256, 256)

    with Image.open(thumbcache.write_thumbnail(alpha, 128, 128, thumbcache.cache_key("output", "alpha.png", 1, 1, 128, 128))) as thumb:
        assert "A" in thumb.getbands(), "transparency must survive"
    with Image.open(thumbcache.write_thumbnail(tall, 128, 128, thumbcache.cache_key("input", "tall.jpg", 1, 1, 128, 128))) as thumb:
        assert thumb.size[1] > thumb.size[0], "EXIF orientation must be applied"

    keys = {
        thumbcache.cache_key(scope, "a.png", mtime, size, 256, 256)
        for scope in ("output", "input")
        for mtime in (1, 2)
        for size in (10, 11)
    }
    assert len(keys) == 8, "gallery, mtime and size must all change the key"
    assert thumbcache.cache_key("output", "a.png", 1, 1, 256, 256) != thumbcache.cache_key("output", "a.png", 1, 1, 512, 512)


def test_mesh_previews_rendered_by_the_browser_are_validated_and_stored() -> None:
    import io

    from aiohttp import web
    from PIL import Image

    from assets_plus import handlers, thumbcache

    folder = WORK / "meshes"
    folder.mkdir(exist_ok=True)
    model = folder / "duck.glb"
    model.write_bytes(b"glTF" + os.urandom(64))
    picture = folder / "photo.png"
    make_noise_image(picture, 64)
    stat = model.stat()
    version = f"{int(stat.st_mtime)}-{stat.st_size}"

    def webp(size: int = 256) -> bytes:
        buffer = io.BytesIO()
        Image.new("RGBA", (size, size), (200, 160, 40, 255)).save(buffer, format="WEBP")
        return buffer.getvalue()

    key = thumbcache.cache_key("output", "duck.glb", int(stat.st_mtime), stat.st_size, 256, 256)
    assert thumbcache.lookup(key) is None, "no preview before the browser sent one"

    def refused(**changes: object) -> None:
        arguments = dict(base_dir=folder, scope="output", relpath="duck.glb", width=256, height=256, version=version, data=webp())
        arguments.update(changes)
        try:
            handlers.store_mesh_preview(**arguments)
        except ValueError:
            return
        raise AssertionError(f"must be refused: {changes}")

    refused(relpath="photo.png")  # only 3D models take an uploaded preview
    refused(version="1-1")  # the file changed since the page saw it
    refused(width=300, height=300)
    refused(data=b"")
    refused(data=b"definitely not an image")
    refused(data=b"\0" * (handlers.MESH_PREVIEW_MAX_BYTES + 1))
    try:
        handlers.store_mesh_preview(folder, "output", "../outside.glb", 256, 256, version, webp())
    except (ValueError, web.HTTPException):
        pass
    else:
        raise AssertionError("a path outside the gallery must be refused")
    assert thumbcache.lookup(key) is None, "refused uploads must leave nothing behind"

    handlers.store_mesh_preview(folder, "output", "duck.glb", 256, 256, version, webp())
    stored = thumbcache.lookup(key)
    assert stored is not None
    with Image.open(stored) as preview:
        assert preview.size == (256, 256)
    assert not list(thumbcache.cache_root().glob(".upload.*")), "no temporary upload file may stay"


def test_thumbnail_cache_evicts_least_recently_used_down_to_the_low_water_mark() -> None:
    from assets_plus import thumbcache

    thumbcache.clear()
    folder = WORK / "thumbs_lru"
    folder.mkdir(exist_ok=True)
    source = folder / "noise.png"
    make_noise_image(source, 300)
    keys = [thumbcache.cache_key("output", f"n{i}.png", i, i, 128, 128) for i in range(40)]
    for key in keys:
        thumbcache.write_thumbnail(source, 128, 128, key)
    entry_size = thumbcache.entry_path(keys[0]).stat().st_size
    now = time.time()
    for position, key in enumerate(keys):  # entry 0 is the oldest, entry 39 the newest
        os.utime(thumbcache.entry_path(key), (now - 1000 + position, now - 1000 + position))
    # an old entry is used again: lookup must give it a fresh last-use time
    os.utime(thumbcache.entry_path(keys[0]), (now - 100000, now - 100000))
    assert thumbcache.lookup(keys[0]) is not None
    assert time.time() - thumbcache.entry_path(keys[0]).stat().st_mtime < 60

    budget = entry_size * 30
    original_budget, original_wait = thumbcache.budget_bytes, thumbcache.MIN_PASS_INTERVAL
    thumbcache.budget_bytes = lambda: budget
    try:
        thumbcache._maintenance_pass()
    finally:
        thumbcache.budget_bytes = original_budget
    left = [key for key in keys if thumbcache.entry_path(key).exists()]
    total = sum(thumbcache.entry_path(key).stat().st_size for key in left)
    assert total <= budget * thumbcache.LOW_WATER + entry_size, "eviction must reach the low-water mark"
    assert len(left) < 40 and keys[0] in left, "the entry used last must survive"
    assert keys[1] not in left and keys[39] in left, "the least recently used entries go first"
    assert thumbcache._total_bytes == total, "the running size must match the disk after a pass"


def test_thumbnail_cache_cleanup_of_old_layout_removal_clear_and_failures() -> None:
    from assets_plus import thumbcache
    from assets_plus.storage import thumb_cache_dir

    thumbcache.clear()
    root = thumb_cache_dir()
    legacy = root / ("a" * 64 + ".png")
    legacy.write_bytes(b"old png thumbnail")
    placeholder = root / "_placeholder_other_256x256.png"
    placeholder.write_bytes(b"placeholder")
    stray = root / "notes.txt"
    stray.write_bytes(b"not ours to delete")
    thumbcache._legacy_purged = False
    thumbcache._maintenance_pass()
    assert not legacy.exists() and placeholder.exists() and stray.exists()

    folder = WORK / "thumbs_cleanup"
    folder.mkdir(exist_ok=True)
    source = folder / "noise.png"
    make_noise_image(source, 200)
    sizes = ((256, 256), (512, 512))
    for width, height in sizes:
        thumbcache.write_thumbnail(source, width, height, thumbcache.cache_key("input", "gone.png", 7, 8, width, height))
    assert thumbcache.remove_entries("input", "gone.png", 7, 8, sizes) == 2
    assert thumbcache.remove_entries("input", "gone.png", 7, 8, sizes) == 0
    other = thumbcache.cache_key("input", "kept.png", 1, 1, 256, 256)
    thumbcache.write_thumbnail(source, 256, 256, other)
    legacy.write_bytes(b"old again")
    assert thumbcache.clear() == 2, "clear removes the new entries and old-layout files, not placeholders"
    assert thumbcache.lookup(other) is None and not legacy.exists() and placeholder.exists()

    assert not thumbcache.recently_failed("broken")
    thumbcache.remember_failure("broken")
    assert thumbcache.recently_failed("broken")
    thumbcache._failures["broken"] -= thumbcache.FAILURE_MEMORY + 1
    assert not thumbcache.recently_failed("broken"), "a failure is forgotten after a while"


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

    from assets_plus import thumbcache

    keys = {thumbcache.cache_key("output", name, item["mtime"], item["size"], 256, 256) for item in (old, new)}
    assert len(keys) == 2, "the thumbnail cache must not serve the old file's thumbnail for the new one"

    # a star belongs to the old file: a file generated again under the name does not inherit it
    path.write_bytes(b"third version, with a star")
    os.utime(path, (1_790_000_060, 1_790_000_060))
    handlers._build_list_response(out, "", {"limit": "0", "fresh": "1"})
    handlers.set_starred_assets(out, "output", [name], True)
    starred = handlers._build_list_response(out, "", {"limit": "0", "fresh": "1"})
    assert next(item for item in starred["items"] if item["relpath"] == name)["starred"]
    path.unlink()
    path.write_bytes(b"fourth version, regenerated")
    os.utime(path, (1_790_000_090, 1_790_000_090))
    regenerated = handlers._build_list_response(out, "", {"limit": "0", "fresh": "1"})
    assert not next(item for item in regenerated["items"] if item["relpath"] == name)["starred"]

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


def test_time_range_starred_only_histogram_and_names_only() -> None:
    from aiohttp import web

    from assets_plus.storage import HiddenEntry, starred_key, update_starred

    out = WORK / "ranges"
    out.mkdir(exist_ok=True)
    day = 86_400
    base = 1_700_000_000
    # two files per day for 0..5 days ago, one far in the past, and a sound two days ago
    spec = [(f"d{d}_{i}.png", d) for d in range(6) for i in range(2)] + [("old.png", 400), ("voice.mp3", 2)]
    for name, ago in spec:
        path = out / name
        path.write_bytes(b"x")
        stamp = base - ago * day
        os.utime(path, (stamp, stamp))
    age_directories(out)

    everything = handlers._build_list_response(out, "", {"limit": "0"})
    assert len(everything["items"]) == 14

    # [mtime_min, mtime_max) is a slice of the newest-first order (the end is exclusive)
    low, high = base - 3 * day, base - 1 * day
    window_params = {"mtime_min": str(low), "mtime_max": str(high)}
    ranged = handlers._build_list_response(out, "", {"limit": "0", **window_params})
    expected = [i["relpath"] for i in everything["items"] if low <= i["mtime"] < high]
    assert len(expected) == 5, expected  # d3 x2, d2 x2 and the sound
    assert [i["relpath"] for i in ranged["items"]] == expected
    paged, cursor = [], ""
    while True:
        page = handlers._build_list_response(out, "", {"limit": "2", "cursor": cursor, **window_params})
        paged += [i["relpath"] for i in page["items"]]
        if not page["has_more"]:
            break
        cursor = page["cursor"]
    assert paged == expected, "paging inside a time range must see the same rows"
    window = handlers._build_window_response(out, "", {"relpath": expected[2], **window_params})
    assert window["found"] and window["total"] == 5
    assert handlers._build_list_response(out, "", {"limit": "0", "mtime_max": str(base - 500 * day)})["items"] == []

    # lite: the same items, without reading any file for workflow detection
    lite = handlers._build_list_response(out, "", {"limit": "0", "lite": "1", **window_params})
    assert [i["relpath"] for i in lite["items"]] == expected and not any(i["has_workflow"] for i in lite["items"])

    # starred only, also with starred-first and a time range
    starred_names = [expected[0], expected[3]]
    scanned = {i["relpath"]: i for i in everything["items"]}
    update_starred(
        lambda current: {
            **current,
            **{
                starred_key("output", name): HiddenEntry(
                    relpath=starred_key("output", name), mtime=scanned[name]["mtime"], size=scanned[name]["size"]
                )
                for name in starred_names
            },
        }
    )
    only = handlers._build_list_response(out, "", {"limit": "0", "starred_only": "1"})
    assert sorted(i["relpath"] for i in only["items"]) == sorted(starred_names)
    both = handlers._build_list_response(out, "", {"limit": "0", "starred_only": "1", "starred_first": "1", **window_params})
    assert sorted(i["relpath"] for i in both["items"]) == sorted(starred_names)

    # histogram: one interval per pair of edges
    edges = [base - ago * day for ago in (6, 5, 4, 3, 2, 1, 0)] + [base + day]
    result = handlers._build_histogram_response(out, "", {"edges": ",".join(map(str, edges))})
    assert result["counts"] == [0, 2, 2, 2, 3, 2, 2], result
    assert result["total"] == 14 and result["min"] == base - 400 * day and result["max"] == base
    sounds = handlers._build_histogram_response(
        out, "", {"edges": f"{base - 3 * day},{base - 1 * day}", "extensions": "mp3"}
    )
    assert sounds["counts"] == [1] and sounds["total"] == 1
    starred_counts = handlers._build_histogram_response(out, "", {"edges": f"{base - 7 * day},{base + day}", "starred_only": "1"})
    assert starred_counts["counts"] == [2]
    try:
        handlers._build_histogram_response(out, "", {"edges": "5,3"})
    except web.HTTPBadRequest:
        pass
    else:
        raise AssertionError("descending edges must be refused")


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


def test_log_level_setting_is_coerced_saved_and_applied() -> None:
    import logging

    from assets_plus import config as config_module
    from assets_plus import logs

    assert logs.coerce_level("DEBUG ") == "debug" and logs.coerce_level("loud") == "quiet" and logs.coerce_level(None) == "quiet"
    assert logs.apply_level("silent") == "silent"
    assert logging.getLogger("assets_plus").level == logging.ERROR
    assert logging.getLogger("assets_plus.banner").level > logging.CRITICAL, "silent hides the banner too"
    assert logs.apply_level("quiet") == "quiet"
    assert logging.getLogger("assets_plus").level == logging.WARNING, "quiet: warnings and errors"
    assert logging.getLogger("assets_plus.banner").level == logging.INFO, "quiet still shows the banner"
    assert logs.apply_level("debug") == "debug" and logging.getLogger("assets_plus").level == logging.DEBUG

    class Console(logging.Handler):  # like ComfyUI's console handler: nothing below INFO gets through
        def __init__(self) -> None:
            super().__init__(level=logging.INFO)
            self.lines: list[str] = []

        def emit(self, record: logging.LogRecord) -> None:
            self.lines.append(record.getMessage())

    console = Console()
    logging.getLogger().addHandler(console)
    try:
        logging.getLogger("assets_plus").debug("every request")
        assert console.lines == ["every request"], "debug records must reach an INFO console at the debug level"
        logs.apply_level("info")
        logging.getLogger("assets_plus").debug("hidden")
        assert console.lines == ["every request"], "and not at the info level"
    finally:
        logging.getLogger().removeHandler(console)
    logs.apply_level("quiet")

    path = config_module.config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('{"list_limit": 321, "log_level": "loud"}', encoding="utf-8")
    config_module._config_cache = None
    loaded = config_module.load_config()
    assert loaded.log_level == "quiet" and loaded.list_limit == 321

    config_module.save_config_value("log_level", "info")
    saved = json.loads(path.read_text(encoding="utf-8"))
    assert saved == {"list_limit": 321, "log_level": "info"}, "other keys must survive"
    assert config_module.load_config().log_level == "info", "saving must refresh the cached config"
    path.unlink()
    config_module._config_cache = None


def test_obsolete_config_keys_are_removed_once_and_formats_are_saved() -> None:
    from assets_plus import config as config_module

    path = config_module.config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {
                "allowed_extensions": ["png", ".JPG", ".png", ".custom"],
                "thumbnail_size": [512, 512],
                "poll_seconds": 5,
                "list_limit": 200,
            }
        ),
        encoding="utf-8",
    )
    config_module._config_cache = None
    config_module._obsolete_keys_checked = False
    loaded = config_module.load_config()
    assert loaded.allowed_extensions == (".png", ".jpg", ".custom"), "normalized, without duplicates"
    assert loaded.thumbnail_quality == "high", "the old thumbnail size becomes a quality"
    saved = json.loads(path.read_text(encoding="utf-8"))
    assert "poll_seconds" not in saved and "thumbnail_size" not in saved, "obsolete keys are gone from the file"
    assert saved["thumbnail_quality"] == "high" and saved["list_limit"] == 200

    path.write_text('{"allowed_extensions": []}', encoding="utf-8")
    config_module._config_cache = None
    assert config_module.load_config().allowed_extensions == config_module.KNOWN_EXTENSIONS, "empty list = defaults"

    # the settings page: known formats switch on and off, unknown ones typed by hand survive
    path.write_text('{"allowed_extensions": [".png", ".custom"]}', encoding="utf-8")
    config_module._config_cache = None
    result = config_module.save_allowed_extensions([".flac", ".png", ".MP3", ".nonsense"])
    assert result == (".png", ".mp3", ".flac", ".custom"), result
    assert json.loads(path.read_text(encoding="utf-8"))["allowed_extensions"] == list(result)
    # custom ones keep the list non-empty, so switching off every known format is allowed
    assert config_module.save_allowed_extensions([]) == (".custom",)

    path.write_text("{}", encoding="utf-8")
    config_module._config_cache = None
    try:
        config_module.save_allowed_extensions([])
    except ValueError:
        pass
    else:
        raise AssertionError("nothing enabled must be refused")
    config_module.save_allowed_extensions(list(config_module.KNOWN_EXTENSIONS))
    assert "allowed_extensions" not in json.loads(path.read_text(encoding="utf-8")), "all on follows the defaults"
    path.unlink()
    config_module._config_cache = None


def test_banner_text_and_version_come_from_the_own_pyproject() -> None:
    from assets_plus import banner

    root = WORK / "installed"
    root.mkdir(parents=True, exist_ok=True)
    (root / "pyproject.toml").write_text('[project]\nname = "x"\nversion = "2.3.4"\n', encoding="utf-8")
    assert banner.local_version(root) == "2.3.4" and banner.local_version(WORK / "nowhere") is None
    assert banner.compose_banner("2.3.4") == "Assets+ v2.3.4 \u00b7 ready"
    assert "unknown version" in banner.compose_banner(None)
    assert "\033[" in banner.compose_banner("2.3.4", color=True) and "\033[" not in banner.compose_banner("2.3.4")


def test_announce_logs_one_banner_and_silent_hides_it() -> None:
    import logging

    from assets_plus import banner, logs

    class Capture(logging.Handler):
        def __init__(self) -> None:
            super().__init__()
            self.records: list[logging.LogRecord] = []

        def emit(self, record: logging.LogRecord) -> None:
            self.records.append(record)

    capture = Capture()
    banner_logger = logging.getLogger("assets_plus.banner")
    banner_logger.addHandler(capture)
    root = WORK / "installed"
    root.mkdir(parents=True, exist_ok=True)
    (root / "pyproject.toml").write_text('version = "1.1.2"\n', encoding="utf-8")
    try:
        logs.apply_level("quiet")
        text = banner.announce(root)
        assert "Assets+ v1.1.2" in text and len(capture.records) == 1 and capture.records[0].levelno == logging.INFO
        logs.apply_level("silent")
        banner.announce(root)
        assert len(capture.records) == 1, "silent: no banner"
    finally:
        banner_logger.removeHandler(capture)
        logs.apply_level("quiet")


def test_scan_excludes_volume_trash_directories() -> None:
    with tempfile.TemporaryDirectory(prefix="ap_trash_") as tmp:
        root = Path(tmp)
        visible = ("keep.png", "nested/keep.png", ".hidden/keep.png", ".Trash-backup/keep.png")
        trashed = (
            ".Trash-0/files/deleted.png",
            ".Trash-1000/files/deleted.png",
            ".Trash/1000/files/deleted.png",
            "nested/.Trashes/501/deleted.png",
        )
        for name in visible + trashed:
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"x")

        rows, stamps = listing.scan_tree(root, EXTENSIONS, True, None)
        assert {row[listing.R_REL] for row in rows} == set(visible)
        assert {Path(directory).relative_to(root).as_posix() for directory, _ in stamps} == {
            ".", "nested", ".hidden", ".Trash-backup",
        }

        rows, _ = listing.scan_tree(root, EXTENSIONS, False, None)
        assert {row[listing.R_REL] for row in rows} == {"keep.png"}


def test_trashed_asset_does_not_reappear_after_refresh() -> None:
    from unittest.mock import patch

    with tempfile.TemporaryDirectory(prefix="ap_trash_refresh_") as tmp:
        root = Path(tmp)
        victim = root / "victim.png"
        victim.write_bytes(b"x")
        (root / "keep.png").write_bytes(b"x")
        trash = root / ".Trash-0" / "files" / victim.name
        before = listing.get_snapshot(root, EXTENSIONS, True, None, fresh=True)
        assert {row[listing.R_REL] for row in before.rows} == {"keep.png", "victim.png"}

        def fake_trash(path: Path) -> str:
            trash.parent.mkdir(parents=True, exist_ok=True)
            path.rename(trash)
            return "native"

        with patch.object(handlers, "move_to_trash", side_effect=fake_trash):
            removed, failed, modes = handlers.delete_assets(root, ["victim.png"], "trash")
        assert removed == ["victim.png"] and not failed
        assert modes == {"victim.png": "trash"}
        assert not victim.exists() and trash.is_file(), "trash must remain recoverable"

        for fresh in (False, True):
            after = listing.get_snapshot(root, EXTENSIONS, True, None, fresh=fresh)
            assert {row[listing.R_REL] for row in after.rows} == {"keep.png"}
        listing.invalidate(root)


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
