# Security notes

Assets+ Explorer is a gallery for ComfyUI's `output` and `input` folders. This document describes what the
extension can touch, so that reviewers and automated scanners can see what is intentional.

## What the extension does and does not do

- **One optional outgoing request, nothing else.** Once per start the backend asks `api.comfy.org` (the version
  list of this node) and, for a git clone on `main`, `api.github.com` (the latest commit of `main`), to say in the
  start-up banner whether a newer version exists (`assets_plus/updates.py`, standard library `urllib`). The requests
  are read-only GETs, carry no identifier, path or usage data, and `"update_check": false` in `config.json` turns
  them off. The frontend (`web/`) calls only ComfyUI's own origin: `/assets_plus/*`, `/view` and ComfyUI's
  settings API. There are no other hard-coded URLs.
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
| Update check | Once per start, in a background thread, two read-only GET requests (the node's version list at `api.comfy.org` and the latest commit of `main` at `api.github.com`) to say in the start-up banner whether a newer version exists. Nothing is sent but the request. `"update_check": false` in `config.json` turns it off. |
| Thumbnails | Pillow reads the image and writes a PNG preview into `user/__assets_plus/thumb_cache/`. |

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
