from __future__ import annotations

from pathlib import Path

from PIL import Image
from PIL import ImageDraw

from .storage import thumb_cache_dir


_KIND_BY_EXT = {
    ".png": "image", ".jpg": "image", ".jpeg": "image", ".webp": "image",
    ".gif": "image", ".bmp": "image", ".tiff": "image",
    ".mp4": "video", ".webm": "video", ".mov": "video", ".mkv": "video",
    ".mp3": "audio", ".flac": "audio", ".wav": "audio", ".ogg": "audio", ".m4a": "audio",
    ".glb": "mesh", ".gltf": "mesh",
}


def _classify_kind(path: Path) -> str:
    return _KIND_BY_EXT.get(path.suffix.lower(), "other")


def _placeholder_png(label: str, width: int, height: int) -> Path | None:
    """Render (and cache) a tiny labeled placeholder image. Idempotent.
    
    Returns the path to the cached placeholder, or *None* if rendering
    fails (callers must handle the None gracefully).
    """
    cache = thumb_cache_dir() / f"_placeholder_{label}_{width}x{height}.png"
    if cache.exists():
        return cache
    try:
        img = Image.new("RGB", (width, height), (40, 40, 48))
        try:
            from PIL import ImageDraw
            draw = ImageDraw.Draw(img)
            text = label.upper()
            tw, th = draw.textbbox((0, 0), text)[2:]
            draw.text(((width - tw) / 2, (height - th) / 2), text, fill=(220, 220, 230))
        except Exception:
            pass
        img.save(cache, format="PNG")
        return cache
    except Exception:
        if cache.exists():
            cache.unlink()
        return None
