"""Read the ComfyUI workflow/prompt that SaveVideo embeds into MP4/MOV files.

ComfyUI writes them as QuickTime "mdta" metadata (``moov/udta/meta`` with ``keys`` + ``ilst``,
FFmpeg option ``use_metadata_tags``). The reader needs no extra packages: it walks box headers,
skips ``mdat`` by seeking and only loads the ``moov`` box, so it stays cheap on large videos.
Every failure results in an empty dict, never an exception: a broken video must not break a listing.
"""
from __future__ import annotations

import struct
from pathlib import Path
from typing import BinaryIO, Iterator

WANTED_KEYS = ("workflow", "prompt")
MAX_MOOV_BYTES = 64 * 1024 * 1024
MAX_DEPTH = 6


def _iter_boxes(data: bytes, start: int, end: int) -> Iterator[tuple[bytes, int, int]]:
    """Yield (type, payload_start, box_end) for the boxes in data[start:end]."""
    position = start
    while position + 8 <= end:
        size, kind = struct.unpack(">I4s", data[position:position + 8])
        header = 8
        if size == 1:
            if position + 16 > end:
                return
            size = struct.unpack(">Q", data[position + 8:position + 16])[0]
            header = 16
        elif size == 0:
            size = end - position
        if size < header or position + size > end:
            return
        yield kind, position + header, position + size
        position += size


def _read_moov(handle: BinaryIO, file_size: int) -> bytes | None:
    """Locate the top-level 'moov' box by seeking over everything else (mdat can be gigabytes)."""
    position = 0
    while position + 8 <= file_size:
        handle.seek(position)
        header = handle.read(16)
        if len(header) < 8:
            return None
        size, kind = struct.unpack(">I4s", header[:8])
        header_size = 8
        if size == 1:
            if len(header) < 16:
                return None
            size = struct.unpack(">Q", header[8:16])[0]
            header_size = 16
        elif size == 0:
            size = file_size - position
        if size < header_size:
            return None
        if kind == b"moov":
            payload = size - header_size
            if payload > MAX_MOOV_BYTES or position + size > file_size:
                return None
            handle.seek(position + header_size)
            return handle.read(payload)
        position += size
    return None


def _parse_meta(data: bytes, start: int, end: int) -> dict[str, str]:
    # QuickTime style: child boxes follow immediately; ISO style: 4 bytes of version/flags first.
    inner = start if data[start + 4:start + 8] in (b"hdlr", b"keys", b"ilst") else start + 4
    keys: list[str] = []
    result: dict[str, str] = {}
    for kind, payload_start, box_end in _iter_boxes(data, inner, end):
        if kind == b"keys":
            count = struct.unpack(">I", data[payload_start + 4:payload_start + 8])[0]
            position = payload_start + 8
            for _ in range(count):
                entry_size = struct.unpack(">I", data[position:position + 4])[0]
                if entry_size < 8:
                    break
                keys.append(data[position + 8:position + entry_size].decode("utf-8", "replace"))
                position += entry_size
        elif kind == b"ilst":
            for item_kind, item_start, item_end in _iter_boxes(data, payload_start, box_end):
                index = struct.unpack(">I", item_kind)[0]
                if not 0 < index <= len(keys) or keys[index - 1] not in WANTED_KEYS:
                    continue
                for sub_kind, sub_start, sub_end in _iter_boxes(data, item_start, item_end):
                    if sub_kind == b"data":
                        # 4 bytes type indicator + 4 bytes locale, then the value.
                        result[keys[index - 1]] = data[sub_start + 8:sub_end].decode("utf-8", "replace")
    return result


def _walk(data: bytes, start: int, end: int, depth: int, found: dict[str, str]) -> None:
    if depth > MAX_DEPTH:
        return
    for kind, payload_start, box_end in _iter_boxes(data, start, end):
        if kind == b"meta":
            found.update(_parse_meta(data, payload_start, box_end))
        elif kind in (b"udta", b"moov"):
            _walk(data, payload_start, box_end, depth + 1, found)


def read_mp4_metadata(path: Path) -> dict[str, str]:
    """Return {"workflow": json_text, "prompt": json_text} for the keys present in the file."""
    try:
        with open(path, "rb") as handle:
            handle.seek(0, 2)
            moov = _read_moov(handle, handle.tell())
        if not moov:
            return {}
        found: dict[str, str] = {}
        _walk(moov, 0, len(moov), 0, found)
        return {key: value for key, value in found.items() if value}
    except Exception:  # noqa: BLE001 - corrupt or exotic file: no metadata, never fail a listing
        return {}


# --- WebM / Matroska ---------------------------------------------------------
# SaveWEBM stores the same keys as Matroska tags: Segment > Tags > Tag > SimpleTag(TagName, TagString).

_EBML_SEGMENT = 0x18538067
_EBML_TAGS = 0x1254C367
_EBML_TAG = 0x7373
_EBML_SIMPLE_TAG = 0x67C8
_EBML_TAG_NAME = 0x45A3
_EBML_TAG_STRING = 0x4487
_MAX_TAGS_BYTES = 64 * 1024 * 1024
_UNKNOWN_SIZE = -1


def _read_vint(handle: BinaryIO, keep_marker: bool) -> tuple[int, int] | None:
    """Read an EBML variable-length integer. Returns (value, length) or None at EOF/garbage."""
    first = handle.read(1)
    if not first:
        return None
    lead = first[0]
    length = 1
    mask = 0x80
    while length <= 8 and not lead & mask:
        length += 1
        mask >>= 1
    if length > 8:
        return None
    rest = handle.read(length - 1)
    if len(rest) != length - 1:
        return None
    value = lead if keep_marker else lead & (mask - 1)
    for byte in rest:
        value = (value << 8) | byte
    if not keep_marker and value == (1 << (7 * length)) - 1:
        return _UNKNOWN_SIZE, length
    return value, length


def _read_element_header(handle: BinaryIO) -> tuple[int, int] | None:
    element_id = _read_vint(handle, keep_marker=True)
    if element_id is None:
        return None
    size = _read_vint(handle, keep_marker=False)
    if size is None:
        return None
    return element_id[0], size[0]


def _parse_tags(payload: bytes) -> dict[str, str]:
    import io

    result: dict[str, str] = {}
    stream = io.BytesIO(payload)
    end = len(payload)

    def elements(start: int, limit: int):
        position = start
        while position < limit:
            stream.seek(position)
            header = _read_element_header(stream)
            if header is None:
                return
            element_id, size = header
            payload_start = stream.tell()
            if size == _UNKNOWN_SIZE or payload_start + size > limit:
                return
            yield element_id, payload_start, payload_start + size
            position = payload_start + size

    for tag_id, tag_start, tag_end in elements(0, end):
        if tag_id != _EBML_TAG:
            continue
        for simple_id, simple_start, simple_end in elements(tag_start, tag_end):
            if simple_id != _EBML_SIMPLE_TAG:
                continue
            name = value = None
            for child_id, child_start, child_end in elements(simple_start, simple_end):
                text = payload[child_start:child_end].decode("utf-8", "replace").rstrip("\x00")
                if child_id == _EBML_TAG_NAME:
                    name = text
                elif child_id == _EBML_TAG_STRING:
                    value = text
            # FFmpeg's Matroska muxer upper-cases tag names (WORKFLOW, PROMPT).
            if name and name.lower() in WANTED_KEYS and value:
                result[name.lower()] = value
    return result


def read_matroska_metadata(path: Path) -> dict[str, str]:
    """Return {"workflow": ..., "prompt": ...} from the Tags of a WebM/MKV file."""
    try:
        with open(path, "rb") as handle:
            handle.seek(0, 2)
            file_size = handle.tell()
            handle.seek(0)
            header = _read_element_header(handle)
            if header is None or header[0] != 0x1A45DFA3 or header[1] < 0:
                return {}
            handle.seek(header[1], 1)  # skip the EBML header
            segment = _read_element_header(handle)
            if segment is None or segment[0] != _EBML_SEGMENT:
                return {}
            segment_end = file_size if segment[1] == _UNKNOWN_SIZE else min(file_size, handle.tell() + segment[1])
            found: dict[str, str] = {}
            while handle.tell() < segment_end:
                element = _read_element_header(handle)
                if element is None:
                    break
                element_id, size = element
                if size == _UNKNOWN_SIZE:
                    break  # live-style unknown-size clusters cannot be skipped reliably
                if element_id == _EBML_TAGS:
                    if size <= _MAX_TAGS_BYTES and handle.tell() + size <= file_size:
                        found.update(_parse_tags(handle.read(size)))
                    else:
                        handle.seek(size, 1)
                else:
                    handle.seek(size, 1)
            return found
    except Exception:  # noqa: BLE001 - corrupt or exotic file: no metadata
        return {}
