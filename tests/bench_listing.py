"""Rough benchmark: old simple listing vs the snapshot cache on a large synthetic gallery.

    python tests/bench_listing.py <repo> <scratch dir> [files=30000]
"""
from __future__ import annotations

import os
import sys
import tempfile
import time
import types
from pathlib import Path
from unittest.mock import MagicMock

REPO = Path(sys.argv[1])
SCRATCH = Path(sys.argv[2])
COUNT = int(sys.argv[3]) if len(sys.argv) > 3 else 30000
USER = Path(tempfile.mkdtemp(prefix="ap_bench_user_"))
sys.modules["folder_paths"] = types.SimpleNamespace(
    get_user_directory=lambda: str(USER),
    get_output_directory=lambda: str(SCRATCH / "out"),
    get_input_directory=lambda: str(SCRATCH / "in"),
)
server = types.ModuleType("server")
server.PromptServer = types.SimpleNamespace(instance=types.SimpleNamespace(routes=MagicMock()))
sys.modules["server"] = server
sys.path.insert(0, str(REPO))
sys.path.insert(0, str(REPO / "tests"))

from PIL import Image, PngImagePlugin  # noqa: E402

from assets_plus import handlers, listing  # noqa: E402
import reference_listing as ref  # noqa: E402

root = SCRATCH / "out"
if not root.exists():
    root.mkdir(parents=True)
    info = PngImagePlugin.PngInfo()
    info.add_text("workflow", "{}")
    Image.new("RGB", (16, 16)).save(root / "_template.png", pnginfo=info)
    blob = (root / "_template.png").read_bytes()
    (root / "_template.png").unlink()
    started = time.perf_counter()
    for index in range(COUNT):
        directory = root / f"batch_{index // 500:03d}"
        directory.mkdir(exist_ok=True)
        path = directory / f"img_{index:06d}_.png"
        path.write_bytes(blob)
        os.utime(path, (1_700_000_000 + index, 1_700_000_000 + index))
    for directory, _, _ in os.walk(root):
        os.utime(directory, (time.time() - 3600,) * 2)
    print(f"created {COUNT} files in {time.perf_counter() - started:.1f}s")


def timed(label, fn, repeat=1):
    started = time.perf_counter()
    result = None
    for _ in range(repeat):
        result = fn()
    elapsed = (time.perf_counter() - started) / repeat
    print(f"{label:<58} {elapsed * 1000:9.1f} ms")
    return result


exts = (".png", ".jpg", ".jpeg", ".webp", ".mp4")
print(f"gallery: {COUNT} files in {len(list(os.scandir(root)))} folders")
timed("OLD  scan + sort + filter (no workflow detection)", lambda: ref.reference_page(
    ref.scan_files(root, exts, True, None), set(), set(), query="", starred_first=False,
    cursor_raw=None, since=None, limit=200))
listing.invalidate()
timed("NEW  first request (cold snapshot, 200 items, workflow flags)", lambda: handlers._build_list_response(root, "", {"limit": "200"}))
page = handlers._build_list_response(root, "", {"limit": "200"})
timed("NEW  next page request (cached snapshot, cursor)", lambda: handlers._build_list_response(
    root, "", {"limit": "200", "cursor": page["cursor"]}), repeat=20)
timed("NEW  since request (cached, nothing new)", lambda: handlers._build_list_response(
    root, "", {"since": str(page["latest_mtime"] + 10)}), repeat=20)
timed("NEW  search 'img_0123' (cached)", lambda: handlers._build_list_response(
    root, "", {"limit": "200", "query": "img_0123"}), repeat=20)
timed("NEW  window around the oldest file (cached)", lambda: handlers._build_window_response(
    root, "", {"anchor": "last", "before": "10"}), repeat=5)
timed("NEW  snapshot validity check only", lambda: listing._is_current(next(iter(listing._cache.values()))), repeat=50)
