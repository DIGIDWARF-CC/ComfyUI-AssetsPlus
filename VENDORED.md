# Vendored third-party code

Assets+ ships one third-party file so that the extension is a single self-contained folder that works
offline, behind restricted networks and without an extra install step (3D previews need it).

| File | Upstream | Version | License | SHA-256 |
| --- | --- | --- | --- | --- |
| `web/vendor/model-viewer.min.js` | [`@google/model-viewer`](https://github.com/google/model-viewer) (npm `dist/model-viewer.min.js`) | 4.0.0 | Apache-2.0; the bundle also contains Lit (BSD-3-Clause) and three.js (MIT), their license headers are kept inside the file | `774edda21e1be2a0934e460ca5943af1fe3f88da130a9f98bd6a9d611576cacf` |

The file is **byte-for-byte identical** to the upstream release; it has not been modified, patched or
re-minified. To verify it:

```bash
# from the repository root (or any empty directory for the download)
curl -sL -o model-viewer.upstream.js \
  https://cdn.jsdelivr.net/npm/@google/model-viewer@4.0.0/dist/model-viewer.min.js
sha256sum model-viewer.upstream.js web/vendor/model-viewer.min.js
```

Both lines must print the hash above. `npm pack @google/model-viewer@4.0.0` gives the same
`dist/model-viewer.min.js`.

How it is used: `web/overlay.js` loads it lazily, only when a `.glb` / `.gltf` file is opened in the
lens, and points the viewer at the file served by ComfyUI itself (`/view?...`). Assets+ never passes it a
remote URL.

Automated security scanners report the minified bundle (it contains generic loader code for models and
textures). Those findings concern upstream library internals, not Assets+ behavior. See
[SECURITY.md](SECURITY.md).
