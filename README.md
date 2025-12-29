# Assets+

Assets+ is an extension for ComfyUI that adds a **Generated+** tab and provides a
persistent overview of the output directory via the `/assets_plus` API.

## Installation

1. Clone the repository into ComfyUI’s `custom_nodes/` (you should end up with
   the folder `custom_nodes/ComfyUI-AssetsPlus/`).
2. Restart ComfyUI.
3. (Optional) To enable sending files to the trash bin, install the dependency:
   `pip install send2trash`.

The frontend part is located at `custom_nodes/ComfyUI-AssetsPlus/web/assets_plus.js` and will be
loaded automatically.

## How to enable Generated+

1. Open the **Media Assets** sidebar panel.
2. Switch to the **Generated+** tab (the icon with multiple images).

If the tab doesn’t show up:
- check that the folder is named `custom_nodes/ComfyUI-AssetsPlus/`;
- make sure ComfyUI was restarted after installation.

## Settings

The config file is located at `user/__assets_plus/config.json`. If the file doesn’t exist,
defaults are used.

Available options:
- `allowed_extensions`: a list of extensions (e.g. `[".png", ".jpg", ".webp"]`).
- `thumbnail_size`: thumbnail size, either a number or an array `[w, h]`.
- `list_limit`: maximum number of items returned per request.
- `recursive`: recursive scan of the output directory (`true/false`).
- `poll_seconds`: auto-refresh interval (seconds).
- `default_delete_mode`: `"trash" | "delete" | "hide"`.
- `scan_depth`: depth limit for recursive scanning (`null` = no limit).

Example:
```json
{
  "allowed_extensions": [".png", ".jpg", ".jpeg", ".webp", ".mp4", ".webm"],
  "thumbnail_size": [256, 256],
  "list_limit": 500,
  "recursive": true,
  "poll_seconds": 5,
  "default_delete_mode": "trash",
  "scan_depth": null
}
````

## Features

* List assets from the output directory (recursively).
* Thumbnails via `/assets_plus/output/thumb`.
* Workflow/prompt metadata via `/assets_plus/output/meta`.
* Deleting from disk (trash/delete) or hiding (hide) with confirmation.
* Auto-refresh list (polling every 5 seconds).

## Deletion modes

* **trash** — moves files to the trash bin via `send2trash` (if available). If the dependency
  is not installed, regular deletion is used.
* **delete** — permanently deletes the file.
* **hide** — hides the asset from the list while keeping the file on disk
  (the index is stored in `user/__assets_plus/hidden.json`).

## Workflow actions

If an asset has workflow metadata:

* **Open workflow (new tab)** — opens the workflow in a new tab (like standard Media Assets).
* **Replace current workflow** — replaces the workflow in the current tab without creating a new one.

If there’s no metadata, the buttons will be disabled.

## Limitations

* Asset source is ComfyUI’s output directory only (no arbitrary paths).
* Videos (`.mp4/.webm`) are served as-is; no thumbnails are generated.
* Auto-refresh is implemented via polling (interval in `poll_seconds`).

## ComfyUI-Manager compatibility

The extension structure matches Manager requirements:

* `__init__.py` exports `WEB_DIRECTORY` so the frontend is picked up automatically.
* `web/assets_plus.js` registers the **Generated+** tab via `registerSidebarTab`.
* No extra installation steps are needed besides restarting ComfyUI.

## Notes

* `send2trash` is used for moving to trash (if available).
* Hidden assets are stored in `user/__assets_plus/hidden.json`.
* Thumbnail cache: `user/__assets_plus/thumb_cache/`.
