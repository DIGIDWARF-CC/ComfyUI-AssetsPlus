/*
 * Previews of 3D models. The server cannot render a model, the browser can: the bundled <model-viewer> draws it
 * into a hidden element, the picture is sent to the server, and from then on the preview is an ordinary cached
 * thumbnail. One model at a time; nothing leaves the machine.
 */

const MODEL_VIEWER_URL = new URL("./vendor/model-viewer.min.js", import.meta.url).href;
const LOAD_TIMEOUT_MS = 30000;
const IDLE_DISPOSE_MS = 10000; // drop the WebGL context when no preview was asked for a while

let loading = null;

/** Load the bundled <model-viewer> once (works offline / in air-gapped installs). */
export const ensureModelViewer = () => {
  if (customElements.get("model-viewer")) return Promise.resolve(true);
  if (!loading) {
    loading = new Promise((resolve) => {
      if (!document.querySelector("script[data-model-viewer-loader]")) {
        const script = document.createElement("script");
        script.type = "module";
        script.src = MODEL_VIEWER_URL;
        script.dataset.modelViewerLoader = "true";
        script.addEventListener("error", () => resolve(false), { once: true });
        document.head.appendChild(script);
      }
      customElements.whenDefined("model-viewer").then(() => resolve(true));
    });
  }
  return loading;
};

const waitFor = (element, name, timeoutMs) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("timeout"));
    }, timeoutMs);
    const onDone = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("the model could not be loaded"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      element.removeEventListener(name, onDone);
      element.removeEventListener("error", onError);
    };
    element.addEventListener(name, onDone, { once: true });
    element.addEventListener("error", onError, { once: true });
  });

const nextFrames = (count) =>
  new Promise((resolve) => {
    const step = (left) => (left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1)));
    step(count);
  });

/** True when the picture has (almost) nothing in it: a frame taken before the model was drawn. */
const isBlank = async (blob) => {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = 48;
  canvas.height = 48;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0, 48, 48);
  bitmap.close?.();
  const pixels = context.getImageData(0, 0, 48, 48).data;
  let filled = 0;
  for (let index = 3; index < pixels.length; index += 4) if (pixels[index] > 16) filled += 1;
  return filled < 48 * 48 * 0.01;
};

class MeshPreviews {
  constructor() {
    this.queue = [];
    this.pending = new Map(); // key -> Promise<boolean>
    this.running = false;
    this.viewer = null;
    this.idleTimer = 0;
  }

  /**
   * Render `modelUrl` at size x size and upload the picture to `uploadUrl`.
   * Resolves true when the server has the preview, false when it could not be made (too slow, no WebGL, refused,
   * or `alive()` said the tile is gone before its turn came).
   */
  render(key, { modelUrl, uploadUrl, size, alive = null }) {
    if (this.pending.has(key)) return this.pending.get(key);
    const promise = new Promise((resolve) => {
      this.queue.push({ modelUrl, uploadUrl, size, alive, resolve });
      this.pump();
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }

  async pump() {
    if (this.running) return;
    this.running = true;
    clearTimeout(this.idleTimer);
    try {
      while (this.queue.length) {
        const job = this.queue.shift();
        let ok = false;
        // A tile that was scrolled away while it waited needs no picture (it asks again if it comes back).
        if (!job.alive || job.alive()) {
          try {
            ok = await this.run(job);
          } catch {
            ok = false;
          }
        }
        job.resolve(ok);
      }
    } finally {
      this.running = false;
      this.idleTimer = setTimeout(() => this.dispose(), IDLE_DISPOSE_MS);
    }
  }

  ensureViewer(size) {
    if (!this.viewer) {
      const viewer = document.createElement("model-viewer");
      viewer.setAttribute("environment-image", "neutral");
      viewer.setAttribute("shadow-intensity", "0");
      viewer.setAttribute("interaction-prompt", "none");
      viewer.setAttribute("camera-orbit", "32deg 68deg auto");
      viewer.setAttribute("field-of-view", "28deg");
      viewer.setAttribute("aria-hidden", "true");
      // On screen (a hidden element is not drawn) but invisible, inert and behind everything.
      viewer.style.cssText = "position:fixed;left:0;top:0;opacity:0.01;pointer-events:none;z-index:-1;";
      document.body.appendChild(viewer);
      this.viewer = viewer;
    }
    this.viewer.style.width = `${size}px`;
    this.viewer.style.height = `${size}px`;
    return this.viewer;
  }

  async run({ modelUrl, uploadUrl, size }) {
    if (!(await ensureModelViewer())) return false;
    const viewer = this.ensureViewer(size);
    viewer.src = modelUrl;
    await waitFor(viewer, "load", LOAD_TIMEOUT_MS);
    // The first frames after "load" can still be empty (textures upload, the scene is framed): take pictures until
    // one has the model in it.
    let blob = null;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await nextFrames(attempt === 0 ? 3 : 6);
      blob = await viewer.toBlob({ mimeType: "image/webp", qualityArgument: 0.85, idealAspect: false });
      if (blob && blob.size && !(await isBlank(blob))) break;
      blob = null;
    }
    viewer.removeAttribute("src"); // free the model right away
    if (!blob) return false;
    const response = await fetch(uploadUrl, { method: "POST", headers: { "Content-Type": "image/webp" }, body: blob });
    return response.ok;
  }

  dispose() {
    if (this.running || this.queue.length) return;
    this.viewer?.remove();
    this.viewer = null;
  }
}

export const meshPreviews = new MeshPreviews();
