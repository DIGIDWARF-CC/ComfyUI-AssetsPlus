# Security notes

Assets+ Explorer is a gallery for ComfyUI's `output` and `input` folders. This document describes what the
extension can touch, so that reviewers and automated scanners can see what is intentional.

## What the extension does and does not do

- **No outgoing network requests.** The backend (`assets_plus/`) imports no networking library and contacts
  no external host. The frontend (`web/`) calls only ComfyUI's own origin: `/assets_plus/*`, `/view` and
  ComfyUI's settings API. There are no hard-coded URLs.
- **No code execution.** No `eval`, `exec`, `subprocess`, `os.system`, shell invocation, runtime package
  installation or dynamic imports of downloaded code. Nothing is obfuscated.
- **No environment or credential access.** The extension does not read environment variables, tokens or
  API keys.
- **File access is confined.** Every path from the browser goes through `resolve_relpath()` in
  `assets_plus/paths.py`: absolute paths and any path that resolves outside the ComfyUI `output` or `input`
  directory are rejected (`400`). Only regular files are ever deleted or moved, never directories.
- **Its own data** lives in `user/__assets_plus/` (`hidden.json`, `starred.json`, `config.json`,
  `thumb_cache/`). Index files are written atomically (temp file plus `os.replace`).

## File operations the extension performs (all user-initiated from the UI)

| Action | What happens |
| --- | --- |
| Delete, mode *trash* | Moves the file to the system trash. `send2trash` if installed, otherwise `assets_plus/trash.py`: `SHFileOperationW` through `ctypes` on Windows, the freedesktop.org trash layout on Linux, `~/.Trash` on macOS. There is no fallback to permanent deletion. |
| Delete, mode *delete* | `unlink()` of the selected file (only when the user picks this mode). |
| Delete, mode *hide* | Records the file in `hidden.json`; the file is not touched. |
| Move to Imported | `output/<file>` to the input root with `os.link` plus `unlink`, or copy, size check, `os.replace`, `unlink` across volumes. Never overwrites; name clashes get a numeric suffix. |
| Star | Records the file in `starred.json`; the file is not touched. |
| Thumbnails | Pillow reads the image and writes a WebP preview into `user/__assets_plus/thumb_cache/`. |
| 3D model previews | The browser draws the model with the bundled `model-viewer` and sends the picture to ComfyUI's own `/assets_plus/*/thumb_upload`. The server accepts it only for an existing `.glb`/`.gltf` of the gallery, only for the file version the page saw, only up to 2 MB, and only if Pillow can decode it; it is re-encoded into the same thumbnail cache. |

`ctypes` is used only in `assets_plus/trash.py`, only on Windows, only to call `SHFileOperationW` (the
Recycle Bin API) on a single absolute path inside the output or input directory.

## Vendored code

`web/vendor/model-viewer.min.js` is the unmodified `@google/model-viewer` 4.0.0 release, used for 3D
previews and bundled so the extension works offline. See [VENDORED.md](VENDORED.md) for the upstream
source, license and a SHA-256 you can verify against the npm package. Static scanners flag this minified
bundle (generic model/texture loading code inside the Google library). Assets+ only hands it a same-origin
`/view?...` URL.

## Known scanner false positives

- Settings accessors in `web/utils.js` (`extensionManager.setting.get(...)`) can look like socket or
  network calls to pattern-based scanners; they read ComfyUI frontend settings.
- Generic loader code inside `web/vendor/model-viewer.min.js` (see above).

## Reporting a vulnerability

Please open an issue at <https://github.com/DIGIDWARF-CC/ComfyUI-AssetsPlus/issues> (without exploit
details; ask for a private channel if the report is sensitive) and the maintainers will respond as soon as
possible.
