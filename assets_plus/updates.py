"""Start-up banner: which Assets+ this is, and whether a newer one exists.

Two read-only requests are made once per start, in a background thread, with a short timeout, and nothing is
sent besides the request itself (no identifiers, no paths, no usage data):

* the Comfy Registry's version list of this node (``api.comfy.org``), to see newer releases, flagged or not;
* GitHub's latest commit of ``main`` (``api.github.com``), to see newer nightly code when this copy is a git
  clone on ``main`` (what ComfyUI-Manager's "Nightly" installs).

Offline, blocked or slow: the banner is printed without the update lines. ``update_check`` in config.json turns
the requests off.
"""
from __future__ import annotations

import json
import logging
import re
import sys
import threading
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Callable

from .config import load_config
from .logs import BANNER_LOGGER_NAME

REGISTRY_URL = "https://api.comfy.org/nodes/comfyui-assetsplus/versions?include_status_reason=true"
GITHUB_MAIN_URL = "https://api.github.com/repos/DIGIDWARF-CC/ComfyUI-AssetsPlus/commits/main"
REQUEST_TIMEOUT = 4.0
USER_AGENT = "ComfyUI-AssetsPlus-update-check"

PACKAGE_ROOT = Path(__file__).resolve().parent.parent
_VERSION_RE = re.compile(r'^version\s*=\s*"(\d+)\.(\d+)\.(\d+)"', re.MULTILINE)
_STATUS_TEXT = {
    "NodeVersionStatusActive": "",
    "NodeVersionStatusFlagged": "flagged by the registry scan, waiting for a review",
    "NodeVersionStatusPending": "still being scanned",
}


def parse_version(text: object) -> tuple[int, int, int] | None:
    match = re.fullmatch(r"v?(\d+)\.(\d+)\.(\d+)", str(text or "").strip())
    return (int(match.group(1)), int(match.group(2)), int(match.group(3))) if match else None


def local_version(root: Path = PACKAGE_ROOT) -> str | None:
    try:
        match = _VERSION_RE.search((root / "pyproject.toml").read_text(encoding="utf-8"))
    except OSError:
        return None
    return ".".join(match.groups()) if match else None


def local_git(root: Path = PACKAGE_ROOT) -> tuple[str | None, str | None]:
    """(branch, commit) of a git clone, read from the files of ``.git`` (no git program is started).
    ``(None, None)`` when this copy is not a clone."""
    git_dir = root / ".git"
    try:
        head = (git_dir / "HEAD").read_text(encoding="utf-8").strip()
    except OSError:
        return None, None
    if not head.startswith("ref:"):
        return None, head[:40] or None  # detached
    ref = head.split(":", 1)[1].strip()
    branch = ref.removeprefix("refs/heads/")
    try:
        return branch, (git_dir / ref).read_text(encoding="utf-8").strip()
    except OSError:
        pass
    try:  # the branch lives in packed-refs after a gc
        for line in (git_dir / "packed-refs").read_text(encoding="utf-8").splitlines():
            if line.endswith(" " + ref):
                return branch, line.split(" ", 1)[0]
    except OSError:
        pass
    return branch, None


def _get(url: str, accept: str) -> str:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": accept})
    with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT) as response:
        return response.read().decode("utf-8", "replace")


def fetch_releases() -> list[dict[str, Any]]:
    payload = json.loads(_get(REGISTRY_URL, "application/json"))
    return [entry for entry in payload if isinstance(entry, dict)] if isinstance(payload, list) else []


def fetch_main_commit() -> str | None:
    text = _get(GITHUB_MAIN_URL, "application/vnd.github.sha").strip()
    return text if re.fullmatch(r"[0-9a-f]{40}", text) else None


def newest_release(releases: list[dict[str, Any]]) -> tuple[str, str] | None:
    """(version, status) of the highest registry version, whatever its status."""
    best: tuple[tuple[int, int, int], str, str] | None = None
    for entry in releases:
        parsed = parse_version(entry.get("version"))
        status = str(entry.get("status") or "")
        if parsed is None or status in {"NodeVersionStatusDeleted", "NodeVersionStatusBanned"}:
            continue
        if best is None or parsed > best[0]:
            best = (parsed, str(entry["version"]), status)
    return (best[1], best[2]) if best else None


def release_status(releases: list[dict[str, Any]], version: str | None) -> str:
    for entry in releases:
        if version and entry.get("version") == version:
            return str(entry.get("status") or "")
    return ""


def compose_banner(
    version: str | None,
    branch: str | None,
    commit: str | None,
    *,
    releases: list[dict[str, Any]] | None = None,
    main_commit: str | None = None,
    color: bool = False,
) -> str:
    """The banner text. Pure: everything it needs is passed in, so it can be tested without a network."""
    def paint(code: str, text: str) -> str:
        return f"\033[{code}m{text}\033[0m" if color else text

    name = paint("1;36", "Assets+")
    shown = paint("1", f"v{version}") if version else paint("33", "unknown version")
    origin = f"nightly {paint('2', commit[:7])}" if branch and commit else "release"
    notes: list[str] = []

    newest = newest_release(releases or [])
    if newest and version:
        latest_version, status = newest
        latest, current = parse_version(latest_version), parse_version(version)
        if latest and current and latest > current:
            detail = _STATUS_TEXT.get(status, "")
            notes.append(paint("33", f"  ↑ release {latest_version} is available" + (f" ({detail})" if detail else "")))
        elif latest == current and _STATUS_TEXT.get(release_status(releases or [], version)):
            notes.append(paint("33", f"  ! this release is {_STATUS_TEXT[release_status(releases or [], version)]}"))
    if branch == "main" and commit and main_commit and main_commit != commit:
        notes.append(paint("33", f"  ↑ nightly: newer code on main ({commit[:7]} → {main_commit[:7]})"))

    if releases is None and main_commit is None:
        verdict = ""  # nothing was checked (offline or switched off)
    elif notes:
        verdict = ""
    else:
        verdict = "  " + paint("32", "✓ up to date")
    return f"{name} {shown} · {origin}{verdict}" + ("".join("\n" + note for note in notes))


def _use_color() -> bool:
    try:
        return bool(sys.stdout.isatty())
    except (AttributeError, ValueError):
        return False


def announce(fetch_releases_fn: Callable[[], list] = fetch_releases,
             fetch_main_fn: Callable[[], str | None] = fetch_main_commit,
             root: Path = PACKAGE_ROOT) -> str:
    """Build and log the banner (blocking; called from the background thread). Returns the text."""
    version = local_version(root)
    branch, commit = local_git(root)
    releases: list | None = None
    main_commit: str | None = None
    if load_config().update_check:
        with ThreadPoolExecutor(max_workers=2, thread_name_prefix="assets-plus-update") as pool:
            releases_future = pool.submit(fetch_releases_fn)
            main_future = pool.submit(fetch_main_fn) if branch == "main" else None
            try:
                releases = releases_future.result(timeout=REQUEST_TIMEOUT + 1)
            except Exception:  # noqa: BLE001 - offline, blocked, rate limited: the banner just has no update lines
                releases = None
            try:
                main_commit = main_future.result(timeout=REQUEST_TIMEOUT + 1) if main_future else None
            except Exception:  # noqa: BLE001
                main_commit = None
    text = compose_banner(version, branch, commit, releases=releases, main_commit=main_commit, color=_use_color())
    logging.getLogger(BANNER_LOGGER_NAME).info(text)
    return text


def start_banner() -> None:
    """Print the banner from a background thread, so a slow network never delays ComfyUI's start."""
    threading.Thread(target=announce, name="assets-plus-banner", daemon=True).start()
