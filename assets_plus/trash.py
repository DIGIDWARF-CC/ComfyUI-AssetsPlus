"""Move files to the system trash without requiring extra Python packages.

``send2trash`` is used when it is installed (it is well tested), otherwise a small
native implementation takes over: SHFileOperation on Windows, the freedesktop.org
trash specification on Linux and ``~/.Trash`` on macOS. Nothing here ever deletes a
file permanently: if the file cannot be trashed, TrashError is raised and the file
stays where it was.
"""
from __future__ import annotations

import ctypes
import importlib.util
import logging
import os
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import quote

LOGGER = logging.getLogger("assets_plus")

SEND2TRASH_AVAILABLE = importlib.util.find_spec("send2trash") is not None


class TrashError(OSError):
    """The file could not be moved to the trash (and was left untouched)."""


def move_to_trash(path: Path) -> str:
    """Move *path* to the trash. Returns the method used; raises TrashError on failure."""
    path = Path(os.path.abspath(path))
    if not os.path.lexists(path):
        raise TrashError(f"{path} does not exist")

    if SEND2TRASH_AVAILABLE:
        try:
            import send2trash

            send2trash.send2trash(str(path))
            if not os.path.lexists(path):
                return "send2trash"
        except Exception:  # noqa: BLE001 - fall through to the native implementation
            LOGGER.warning("[Assets+ Explorer] send2trash failed for %s, trying native trash", path, exc_info=True)

    try:
        if sys.platform == "win32":
            _trash_windows(path)
        elif sys.platform == "darwin":
            _trash_macos(path)
        else:
            _trash_freedesktop(path)
    except TrashError:
        raise
    except Exception as error:  # noqa: BLE001
        raise TrashError(f"could not move {path} to the trash: {error}") from error
    if os.path.lexists(path):
        raise TrashError(f"{path} is still in place after moving it to the trash")
    return "native"


# --- Windows -----------------------------------------------------------------

_FO_DELETE = 0x0003
_FOF_SILENT = 0x0004
_FOF_NOCONFIRMATION = 0x0010
_FOF_ALLOWUNDO = 0x0040
_FOF_NOERRORUI = 0x0400


def _trash_windows(path: Path) -> None:
    from ctypes import wintypes

    class SHFILEOPSTRUCTW(ctypes.Structure):
        _pack_ = 8 if ctypes.sizeof(ctypes.c_void_p) == 8 else 1
        _fields_ = [
            ("hwnd", wintypes.HWND),
            ("wFunc", wintypes.UINT),
            ("pFrom", wintypes.LPCWSTR),
            ("pTo", wintypes.LPCWSTR),
            ("fFlags", ctypes.c_ushort),
            ("fAnyOperationsAborted", wintypes.BOOL),
            ("hNameMappings", ctypes.c_void_p),
            ("lpszProgressTitle", wintypes.LPCWSTR),
        ]

    # pFrom is a list of paths, each terminated by NUL, and the list by an extra NUL.
    source = ctypes.create_unicode_buffer(str(path).replace("/", "\\") + "\0")
    operation = SHFILEOPSTRUCTW()
    operation.wFunc = _FO_DELETE
    operation.pFrom = ctypes.cast(source, wintypes.LPCWSTR)
    operation.fFlags = _FOF_ALLOWUNDO | _FOF_NOCONFIRMATION | _FOF_NOERRORUI | _FOF_SILENT
    result = ctypes.windll.shell32.SHFileOperationW(ctypes.byref(operation))  # type: ignore[attr-defined]
    if result != 0 or operation.fAnyOperationsAborted:
        raise TrashError(f"SHFileOperation failed with code {result:#x}")


# --- Linux and other freedesktop systems -------------------------------------

def _trash_freedesktop(path: Path) -> None:
    """Implements the freedesktop.org trash specification (home trash, then volume trash)."""
    info = os.lstat(path)
    data_home = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share")
    home_trash = data_home / "Trash"
    uid = os.getuid()

    attempts: list[tuple[Path, Path | None]] = []  # (trash dir, base for relative Path= or None)
    try:
        data_home.mkdir(parents=True, exist_ok=True)
        if os.stat(data_home).st_dev == info.st_dev:
            attempts.append((home_trash, None))
    except OSError:
        pass
    topdir = path.parent
    while not os.path.ismount(topdir) and topdir != topdir.parent:
        topdir = topdir.parent
    attempts.append((topdir / f".Trash-{uid}", topdir))

    last_error: Exception | None = None
    for trash_dir, base in attempts:
        try:
            _trash_into(path, trash_dir, base)
            return
        except OSError as error:
            last_error = error
    raise TrashError(f"no usable trash directory for {path}: {last_error}")


def _trash_into(path: Path, trash_dir: Path, base: Path | None) -> None:
    files_dir, info_dir = trash_dir / "files", trash_dir / "info"
    for directory in (trash_dir, files_dir, info_dir):
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    recorded = path if base is None else path.relative_to(base)
    stamp = time.strftime("%Y-%m-%dT%H:%M:%S")
    body = f"[Trash Info]\nPath={quote(str(recorded))}\nDeletionDate={stamp}\n"

    counter = 0
    while True:
        name = path.name if counter == 0 else f"{path.stem}.{counter}{path.suffix}"
        info_path = info_dir / f"{name}.trashinfo"
        try:
            descriptor = os.open(info_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            counter += 1
            continue
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(body)
        target = files_dir / name
        if os.path.lexists(target):
            info_path.unlink(missing_ok=True)
            counter += 1
            continue
        try:
            os.rename(path, target)
        except OSError:
            info_path.unlink(missing_ok=True)
            raise
        return


# --- macOS -------------------------------------------------------------------

def _trash_macos(path: Path) -> None:
    trash = Path.home() / ".Trash"
    counter = 0
    while True:
        name = path.name if counter == 0 else f"{path.stem} {counter}{path.suffix}"
        target = trash / name
        if not os.path.lexists(target):
            try:
                os.rename(path, target)
                return
            except OSError:
                break  # other volume: let Finder handle it
        counter += 1
    script = 'tell application "Finder" to delete POSIX file "{}"'.format(
        str(path).replace("\\", "\\\\").replace('"', '\\"')
    )
    subprocess.run(["osascript", "-e", script], check=True, capture_output=True, timeout=30)
