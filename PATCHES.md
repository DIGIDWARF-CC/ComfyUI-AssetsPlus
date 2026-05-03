# Patches in this fork

This branch (`feat/arrow-keybindings`) carries downstream patches on top of
[`DIGIDWARF-CC/ComfyUI-AssetsPlus`](https://github.com/DIGIDWARF-CC/ComfyUI-AssetsPlus).

The list below describes each change and why it was made. Anything in
`README.md` and the rest of the codebase is unchanged from upstream — every
modification lives in this branch and is documented here.

---

## 1. Arrow-key navigation (overlay)

**File**: `web/assets_plus.js` (the OVERLAY_KEYBINDINGS table near the top).

Replaces the WASD-style overlay shortcuts with arrow keys, and adds a sidebar-
toggle binding so the panel can be toggled without leaving the keyboard:

| Key | Action |
|-----|--------|
| ← / →  | overlay prev / next |
| ↓      | overlay last |
| ↑      | toggle Assets+ Explorer sidebar tab |
| `x`    | overlay delete (unchanged) |

Reason: muscle memory — most image viewers use arrow keys, the upstream
default required taking a hand off the mouse.

---

## 2. Expanded `allowed_extensions` whitelist

**File**: `assets_plus/config.py` → `AssetsPlusConfig.allowed_extensions`.

Upstream defaults to image (png/jpg/jpeg/webp) + video (mp4/webm) only. We
extend the whitelist to cover everything our ComfyUI workflow library
generates:

- **Images**: `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`, `.bmp`, `.tiff`
- **Video**: `.mp4`, `.webm`, `.mov`, `.mkv`
- **Audio**: `.mp3`, `.flac`, `.wav`, `.ogg`, `.m4a`
- **3D mesh**: `.glb`, `.gltf`, `.obj`

Without this, audio outputs from ACE-Step / Stable-Audio / etc. and 3D
meshes from Hunyuan3D simply don't appear in the explorer.

---

## 3. Item-kind classification

**File**: `assets_plus/api.py` → `_classify_kind()` + `list_items`.

Each entry returned by the listing API now carries a `type` field set to one
of `image`, `video`, `audio`, `mesh`, `other`. Frontend uses this to branch
the overlay rendering (point 5 below).

Upstream only distinguished `image` vs `video`; the new kinds let us treat
audio and mesh items differently without parsing extensions in the JS.

---

## 4. Placeholder thumbnails for non-displayable types

**File**: `assets_plus/api.py` → `output_thumb` / `input_thumb` +
`_placeholder_png()`.

Upstream's thumb endpoint raised `HTTP 415 Unsupported Media Type` for any
file Pillow couldn't open as an image, leaving cards with broken-image
icons. Now we render (and cache) a Pillow-generated labeled placeholder PNG
(`MESH`, `AUDIO`, `OTHER`) so every card has something to show.

The cache key follows the same scheme as the regular thumbnails, just with
a `_placeholder_<kind>_<width>x<height>` filename.

---

## 5. Inline `<model-viewer>` 3D preview in the overlay

**File**: `web/assets_plus.js` → `updateOverlayView()` mesh branch.

Clicking a `.glb` / `.gltf` / `.obj` opens an inline interactive viewer:

- `<model-viewer>` web component (Google's polyfill)
- `auto-rotate` + `camera-controls` (mouse drag to orbit, scroll to zoom)
- Neutral environment lighting + soft shadow
- Lazily loads the polyfill from `https://ajax.googleapis.com/ajax/libs/model-viewer/4.0.0/model-viewer.min.js`
  if ComfyUI's main bundle hasn't already registered the custom element.

Reason: matches the inline 3D preview behaviour of ComfyUI's built-in
**Assets** panel, which AssetsPlus didn't have.

---

## 6. Audio overlay control

**File**: `web/assets_plus.js` → `updateOverlayView()` audio branch.

Mp3 / flac / wav / ogg / m4a items now render a `<audio controls>` element
in the overlay. Plays in-place; previously the overlay tried to render the
audio file as `<img>` and showed a broken-image icon.

---

## 7. Generic-file overlay download link

**File**: `web/assets_plus.js` → `updateOverlayView()` `other` branch.

Items not classified as image / video / audio / mesh get an
`Open <filename> ↗` link inside the overlay (target `_blank`). Lets the
browser handle the file natively (download, OS handler, etc.) instead of
choking on an unsupported `<img>`.

---

## 8. `handleOverlayBackgroundClick` exemption fix

**File**: `web/assets_plus.js` → `handleOverlayBackgroundClick()`.

Without this, dragging to rotate the `<model-viewer>` ended in a `click`
event that bubbled to the overlay backdrop and closed the modal. Now the
exemption list (which already covered `.assets-plus-overlay-image` and
`.assets-plus-overlay-video`) also covers:

- `.assets-plus-overlay-mesh`
- `.assets-plus-overlay-audio`
- `.assets-plus-overlay-download`
- `MODEL-VIEWER` element directly

So mouse-up inside any of those interactive widgets no longer closes the
overlay.

---

## How to install this fork

```bash
cd /opt/ComfyUI/custom_nodes        # or wherever your ComfyUI lives
git clone https://github.com/svilendotorg/ComfyUI-AssetsPlus
```

Default branch on this fork is `feat/arrow-keybindings`, so the clone lands
on the patched code automatically. Restart ComfyUI.

To track upstream:

```bash
cd ComfyUI-AssetsPlus
git remote add upstream https://github.com/DIGIDWARF-CC/ComfyUI-AssetsPlus.git
git fetch upstream
git rebase upstream/main
git push --force-with-lease
```

The patches above are designed to minimise upstream conflict surface.
