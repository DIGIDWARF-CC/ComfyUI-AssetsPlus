import { buildViewUrl, clamp, getFileExtension, warn, log } from './utils.js';
import { OUTPUT_TAB, INPUT_TAB, OVERLAY_COMMANDS } from './constants.js';
import { t } from './i18n.js';

export const overlayAPI = {
  getOverlayItem() {
    if (!this.state.overlay.relpath) return null;
    return this.state.items.find((item) => item.relpath === this.state.overlay.relpath) || null;
  },

  openOverlay(relpath) {
    if (!relpath) return;
    const item = this.state.items.find((entry) => entry.relpath === relpath);
    if (!item) return;
    this.state.overlay.relpath = relpath;
    this.resetOverlayZoom({ resetFit: true });
    this.elements.overlay.classList.add("active");
    this.updateOverlayShortcutHints();
    this.updateOverlayView();
  },

  closeOverlay() {
    this.elements.overlay.classList.remove("active");
    this.state.overlay.relpath = null;
    this.overlayImageLoadId += 1;
    this.resetOverlayZoom({ resetFit: true });
    this.updateOverlayMeta(null);
    this.stopOverlayPan();
    const { overlayVideo, overlayMedia } = this.elements;
    this.resetOverlayImageElement();
    this.elements.overlayImage.removeAttribute("src");
    overlayVideo.pause?.();
    overlayVideo.removeAttribute("src");
    overlayVideo.load?.();
    const audioEl = overlayMedia?.querySelector(".assets-plus-overlay-audio");
    if (audioEl) {
      audioEl.pause?.();
      audioEl.removeAttribute("src");
      audioEl.load?.();
    }
    const meshEl = overlayMedia?.querySelector(".assets-plus-overlay-mesh");
    if (meshEl) {
      meshEl.removeAttribute("src");
      meshEl.style.display = "none";
    }
  },

  handleOverlayKeydown(event) {
    if (event.key !== "Escape" || !this.state.overlay.relpath) return;
    if (event.defaultPrevented || this.isDialogEventTarget(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    this.closeOverlay();
  },

  isDialogEventTarget(target) {
    const dialogSelector = "dialog, [role='dialog'], .p-dialog, .comfy-modal";
    const activeElement = document.activeElement;
    return Boolean(
      target?.closest?.(dialogSelector) ||
      activeElement?.closest?.(dialogSelector)
    );
  },

  navigateOverlay(direction) {
    const items = this.getFilteredItems();
    if (!items.length || !this.state.overlay.relpath) return;
    const index = items.findIndex((item) => item.relpath === this.state.overlay.relpath);
    if (index === -1) return;
    let nextIndex = index + direction;
    if (direction === "first") {
      nextIndex = 0;
    } else if (direction === "last") {
      nextIndex = items.length - 1;
    }
    if (nextIndex < 0 || nextIndex >= items.length) return;
    this.state.overlay.relpath = items[nextIndex].relpath;
    this.resetOverlayZoom({ resetFit: true });
    this.updateOverlayView();
  },

  updateOverlayView() {
    this.resetOverlayZoom({ resetFit: true });
    const item = this.getOverlayItem();
    if (!item) {
      this.closeOverlay();
      return;
    }
    const { overlayInfo, overlayPrev, overlayNext, overlayImage, overlayVideo, overlayMedia } = this.elements;
    const items = this.getFilteredItems();
    const index = items.findIndex((entry) => entry.relpath === item.relpath);
    overlayPrev.disabled = index <= 0;
    overlayNext.disabled = index === -1 || index >= items.length - 1;

    const dateLabel = new Date(item.mtime * 1000).toLocaleString();
    overlayInfo.textContent = `${item.filename} • ${dateLabel}`;
    this.updateOverlayMeta(item);

    const viewUrl = buildViewUrl(item.relpath, this.state.tab);

    // Hide every media element first; the branch below shows just the one it needs.
    this.overlayImageLoadId += 1;
    this.resetOverlayImageElement();
    overlayImage.style.display = "none";
    overlayImage.removeAttribute("src");
    overlayVideo.style.display = "none";
    overlayVideo.pause?.();
    overlayVideo.removeAttribute("src");
    overlayVideo.load?.();
    const _audioEl = overlayMedia.querySelector(".assets-plus-overlay-audio");
    if (_audioEl) { _audioEl.pause?.(); _audioEl.removeAttribute("src"); _audioEl.style.display = "none"; }
    const _meshEl = overlayMedia.querySelector(".assets-plus-overlay-mesh");
    if (_meshEl) { _meshEl.removeAttribute("src"); _meshEl.style.display = "none"; }
    const _dlEl = overlayMedia.querySelector(".assets-plus-overlay-download");
    if (_dlEl) { _dlEl.style.display = "none"; }

    if (item.type === "video") {
      overlayVideo.style.display = "block";
      overlayVideo.src = viewUrl;
    } else if (item.type === "audio") {
      let audio = _audioEl;
      if (!audio) {
        audio = document.createElement("audio");
        audio.className = "assets-plus-overlay-audio";
        audio.controls = true;
        audio.style.maxWidth = "90%";
        audio.style.margin = "auto";
        overlayMedia.appendChild(audio);
      }
      audio.src = viewUrl;
      audio.style.display = "block";
    } else if (item.type === "mesh") {
      // Lazily load the locally-bundled <model-viewer> (works offline / in air-gapped installs).
      if (!customElements.get("model-viewer")) {
        if (!document.querySelector('script[data-model-viewer-loader]')) {
          const mvScript = document.createElement("script");
          mvScript.type = "module";
          mvScript.src = new URL("./vendor/model-viewer.min.js", import.meta.url).href;
          mvScript.dataset.modelViewerLoader = "true";
          document.head.appendChild(mvScript);
        }
      }
      let viewer = _meshEl;
      if (!viewer) {
        viewer = document.createElement("model-viewer");
        viewer.className = "assets-plus-overlay-mesh";
        viewer.setAttribute("camera-controls", "");
        viewer.setAttribute("auto-rotate", "");
        viewer.setAttribute("shadow-intensity", "1");
        viewer.setAttribute("environment-image", "neutral");
        viewer.style.width = "min(90vw, 90vh)";
        viewer.style.height = "min(90vw, 90vh)";
        viewer.style.background = "#1a1a20";
        overlayMedia.appendChild(viewer);
      }
      viewer.setAttribute("src", viewUrl);
      viewer.style.display = "block";
    } else if (item.type === "other") {
      let link = _dlEl;
      if (!link) {
        link = document.createElement("a");
        link.className = "assets-plus-overlay-download";
        link.target = "_blank";
        link.rel = "noopener";
        link.style.color = "#cdd";
        link.style.fontSize = "1.1em";
        link.style.textDecoration = "underline";
        link.style.padding = "1em";
        overlayMedia.appendChild(link);
      }
      link.href = viewUrl;
      link.textContent = `Open ${item.filename} ↗`;
      link.style.display = "inline-block";
    } else {
      this.showOverlayImage(viewUrl, item.relpath);
    }
    this.updateOverlayActions(item);
    this.updateOverlayHelpVisibility();
    this.applyOverlayTransform();
  },

  handleOverlayBackgroundClick(event) {
    if (!this.state.overlay.relpath) return;
    const target = event.target;
    if (
      target.closest(".assets-plus-overlay-top") ||
      target.closest(".assets-plus-overlay-nav") ||
      target.closest(".assets-plus-overlay-reset") ||
      target.closest(".assets-plus-overlay-hint")
    ) {
      return;
    }
    if (target.closest(".assets-plus-overlay-image") || target.closest(".assets-plus-overlay-video") || target.closest(".assets-plus-overlay-mesh") || target.closest(".assets-plus-overlay-audio") || target.closest(".assets-plus-overlay-download") || target.tagName === "MODEL-VIEWER") {
      return;
    }
    this.closeOverlay();
  },

  handleOverlayHintClick(event) {
    const button = event.target.closest(".assets-plus-hint-button");
    if (!button) return;
    const action = button.getAttribute("data-action");
    this.handleOverlayCommand(action);
  },

  handleOverlayCommand(action) {
    if (!this.state.overlay.relpath) return;
    if (action === "prev") {
      this.navigateOverlay(-1);
    } else if (action === "next") {
      this.navigateOverlay(1);
    } else if (action === "first") {
      this.navigateOverlay("first");
    } else if (action === "last") {
      this.navigateOverlay("last");
    } else if (action === "delete") {
      const item = this.getOverlayItem();
      if (item && this.canDeleteCurrentTab()) {
        this.handleDelete(item);
      }
    }
  },

  getCommandKeybinding(commandId) {
    const commands = this.app?.extensionManager?.command?.commands || [];
    const command = commands.find((entry) => entry.id === commandId);
    return command?.keybinding ?? null;
  },

  getKeybindingDisplay(commandId) {
    const keybinding = this.getCommandKeybinding(commandId);
    const combo = keybinding?.combo;
    if (!combo) {
      return { label: "", full: "" };
    }
    const sequences =
      typeof combo.getKeySequences === "function"
        ? combo.getKeySequences()
        : [combo.key].filter(Boolean);
    const full =
      typeof combo.toString === "function"
        ? combo.toString()
        : sequences.length
        ? sequences.join(" + ")
        : "";
    const keyOnly = sequences.length === 1 ? String(sequences[0]) : "";
    const label = keyOnly.length === 1 ? keyOnly.toUpperCase() : "";
    return { label, full };
  },

  updateOverlayShortcutHints() {
    const {
      hintUp,
      hintLeft,
      hintDown,
      hintRight,
      hintDelete,
      hintUpKey,
      hintLeftKey,
      hintDownKey,
      hintRightKey,
      hintDeleteKey,
    } = this.elements;
    const hintMap = [
      {
        button: hintUp,
        keyEl: hintUpKey,
        commandId: OVERLAY_COMMANDS.first,
        title: t("overlay.hint.first"),
      },
      {
        button: hintLeft,
        keyEl: hintLeftKey,
        commandId: OVERLAY_COMMANDS.prev,
        title: t("overlay.hint.previous"),
      },
      {
        button: hintDown,
        keyEl: hintDownKey,
        commandId: OVERLAY_COMMANDS.last,
        title: t("overlay.hint.last"),
      },
      {
        button: hintRight,
        keyEl: hintRightKey,
        commandId: OVERLAY_COMMANDS.next,
        title: t("overlay.hint.next"),
      },
      {
        button: hintDelete,
        keyEl: hintDeleteKey,
        commandId: OVERLAY_COMMANDS.delete,
        title: t("actions.delete"),
      },
    ];
    hintMap.forEach(({ button, keyEl, commandId, title }) => {
      if (!button || !keyEl) return;
      const { label, full } = this.getKeybindingDisplay(commandId);
      keyEl.textContent = label;
      keyEl.style.visibility = label ? "visible" : "hidden";
      const nextTitle = full ? `${title} (${full})` : title;
      button.setAttribute("title", nextTitle);
    });
  },

  updateOverlayHelpVisibility() {
    const { overlayHint, hintDelete } = this.elements;
    if (!overlayHint) return;
    const { showOverlayHelp } = this.getSettingsSnapshot();
    overlayHint.style.display = showOverlayHelp ? "grid" : "none";
    if (hintDelete) {
      hintDelete.disabled = !this.canDeleteCurrentTab();
    }
    this.updateOverlayShortcutHints();
  },

  updateOverlayActions(item) {
    const { overlayOpenWorkflow, overlayReplaceWorkflow, overlayPrint, overlayCopy } = this.elements;
    const hasWorkflow = item?.has_workflow && item?.type === "image";
    const isImage = item?.type === "image";
    overlayOpenWorkflow.disabled = !hasWorkflow;
    overlayReplaceWorkflow.disabled = !hasWorkflow;
    overlayPrint.disabled = !isImage;
    overlayCopy.disabled = !isImage;
  },

  updateOverlayMeta(item) {
    const {
      overlayFormatBadge,
      overlayDimensionsBadge,
      overlayZoomBadge,
    } = this.elements;
    if (!overlayFormatBadge || !overlayDimensionsBadge || !overlayZoomBadge) return;
    const extension = item?.filename?.split(".").pop()?.toUpperCase() || "";
    overlayFormatBadge.textContent = extension;
    overlayFormatBadge.style.display = extension ? "inline-flex" : "none";

    const hasImageSize =
      item?.type === "image" &&
      this.state.overlay.imageWidth > 0 &&
      this.state.overlay.imageHeight > 0;
    overlayDimensionsBadge.textContent = hasImageSize
      ? `${this.state.overlay.imageWidth}×${this.state.overlay.imageHeight}`
      : "";
    overlayDimensionsBadge.style.display = hasImageSize ? "inline-flex" : "none";

    const hasImageZoom = hasImageSize && this.state.overlay.zoom > 0;
    overlayZoomBadge.textContent = hasImageZoom
      ? `${Math.round(this.state.overlay.zoom * 100)}%`
      : "";
    overlayZoomBadge.style.display = hasImageZoom ? "inline-flex" : "none";
  },

  resetOverlayImageElement() {
    const { overlayImage } = this.elements;
    if (!overlayImage) return;
    overlayImage.onload = null;
    overlayImage.onerror = null;
    overlayImage.style.left = "50%";
    overlayImage.style.top = "50%";
    overlayImage.style.width = "";
    overlayImage.style.height = "";
    overlayImage.style.transform = "";
    overlayImage.style.visibility = "hidden";
    overlayImage.classList.remove("zoomable", "grabbing");
  },

  resetOverlayImageMetrics() {
    this.state.overlay.fitZoom = 1;
    this.state.overlay.imageWidth = 0;
    this.state.overlay.imageHeight = 0;
  },

  getOverlayMinZoom() {
    const fitZoom = Number(this.state.overlay.fitZoom);
    return Number.isFinite(fitZoom) && fitZoom > 0 ? fitZoom : 1;
  },

  getOverlayFitZoom(naturalWidth, naturalHeight) {
    const { overlayMedia } = this.elements;
    const rect = overlayMedia.getBoundingClientRect();
    const viewportWidth = Math.max(1, rect.width || window.innerWidth - 96);
    const viewportHeight = Math.max(1, rect.height || window.innerHeight - 96);
    const widthZoom = viewportWidth / Math.max(1, naturalWidth);
    const heightZoom = viewportHeight / Math.max(1, naturalHeight);
    return clamp(Math.min(1, widthZoom, heightZoom), 0.01, 1);
  },

  formatOverlayCenterOffset(offset) {
    const sign = offset < 0 ? "-" : "+";
    return `calc(50% ${sign} ${Math.abs(offset)}px)`;
  },

  showOverlayImage(viewUrl, relpath) {
    const { overlayImage } = this.elements;
    const loadId = ++this.overlayImageLoadId;
    const handleLoad = () => this.handleOverlayImageLoad(loadId, relpath);
    overlayImage.onload = handleLoad;
    overlayImage.onerror = () => {
      if (loadId !== this.overlayImageLoadId) return;
      this.resetOverlayZoom({ resetFit: true });
    };
    overlayImage.style.display = "block";
    overlayImage.src = viewUrl;
    if (overlayImage.complete && overlayImage.naturalWidth > 0) {
      handleLoad();
    }
  },

  handleOverlayImageLoad(loadId, relpath) {
    window.requestAnimationFrame(() => {
      if (loadId !== this.overlayImageLoadId || this.state.overlay.relpath !== relpath) return;
      const { overlayImage } = this.elements;
      const naturalWidth = overlayImage.naturalWidth;
      const naturalHeight = overlayImage.naturalHeight;
      if (!naturalWidth || !naturalHeight) return;
      const fitZoom = this.getOverlayFitZoom(naturalWidth, naturalHeight);
      this.state.overlay.fitZoom = fitZoom;
      this.state.overlay.imageWidth = naturalWidth;
      this.state.overlay.imageHeight = naturalHeight;
      this.state.overlay.zoom = fitZoom;
      this.state.overlay.offsetX = 0;
      this.state.overlay.offsetY = 0;
      overlayImage.style.width = `${naturalWidth}px`;
      overlayImage.style.height = `${naturalHeight}px`;
      this.applyOverlayTransform();
      overlayImage.style.visibility = "visible";
      this.updateOverlayMeta(this.getOverlayItem());
      this.updateOverlayResetButton();
    });
  },

  resetOverlayZoom({ resetFit = false } = {}) {
    if (resetFit) {
      this.resetOverlayImageMetrics();
    }
    this.state.overlay.zoom = this.getOverlayMinZoom();
    this.state.overlay.offsetX = 0;
    this.state.overlay.offsetY = 0;
    this.applyOverlayTransform();
    this.updateOverlayMeta(this.getOverlayItem());
    this.updateOverlayResetButton();
  },

  setOverlayActualSize() {
    const item = this.getOverlayItem();
    if (!item || item.type !== "image") return;
    this.state.overlay.zoom = 1;
    this.state.overlay.offsetX = 0;
    this.state.overlay.offsetY = 0;
    this.applyOverlayTransform();
    this.updateOverlayMeta(item);
    this.updateOverlayResetButton();
  },

  updateOverlayResetButton() {
    const item = this.getOverlayItem();
    const isActive = item?.type === "image" && Math.abs(this.state.overlay.zoom - 1) > 0.01;
    this.elements.overlayReset.classList.toggle("active", isActive);
  },

  applyOverlayTransform() {
    const { overlayImage } = this.elements;
    const item = this.getOverlayItem();
    if (!item || item.type !== "image") {
      overlayImage.style.transform = "";
      overlayImage.classList.remove("zoomable", "grabbing");
      return;
    }
    const { zoom, offsetX, offsetY } = this.state.overlay;
    overlayImage.style.left = this.formatOverlayCenterOffset(offsetX);
    overlayImage.style.top = this.formatOverlayCenterOffset(offsetY);
    overlayImage.style.transform = `translate(-50%, -50%) scale(${zoom})`;
    overlayImage.classList.toggle("zoomable", zoom > this.getOverlayMinZoom() + 0.01);
  },

  handleOverlayZoom(event) {
    const item = this.getOverlayItem();
    if (!item || item.type !== "image") return;
    event.preventDefault();
    const { overlayMedia } = this.elements;
    const rect = overlayMedia.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const cursorX = event.clientX - centerX;
    const cursorY = event.clientY - centerY;
    const direction = event.deltaY < 0 ? 1.1 : 0.9;
    const previousZoom = this.state.overlay.zoom;
    const minZoom = this.getOverlayMinZoom();
    const nextZoom = clamp(previousZoom * direction, minZoom, 6);
    const scaleChange = nextZoom / previousZoom;
    this.state.overlay.zoom = nextZoom;
    this.state.overlay.offsetX =
      (this.state.overlay.offsetX - cursorX) * scaleChange + cursorX;
    this.state.overlay.offsetY =
      (this.state.overlay.offsetY - cursorY) * scaleChange + cursorY;
    if (nextZoom === minZoom) {
      this.state.overlay.offsetX = 0;
      this.state.overlay.offsetY = 0;
    }
    this.applyOverlayTransform();
    this.updateOverlayMeta(item);
    this.updateOverlayResetButton();
  },

  startOverlayPan(event) {
    const item = this.getOverlayItem();
    if (!item || item.type !== "image") return;
    if (this.state.overlay.zoom <= this.getOverlayMinZoom() + 0.01) return;
    event.preventDefault();
    if (this.overlayPanHandler) {
      window.removeEventListener("pointermove", this.overlayPanHandler);
    }
    if (this.overlayPanEndHandler) {
      window.removeEventListener("pointerup", this.overlayPanEndHandler);
    }
    this.state.overlay.panning = true;
    this.state.overlay.panStartX = event.clientX;
    this.state.overlay.panStartY = event.clientY;
    this.state.overlay.panOriginX = this.state.overlay.offsetX;
    this.state.overlay.panOriginY = this.state.overlay.offsetY;
    this.elements.overlayImage.classList.add("grabbing");
    this.overlayPanHandler = (moveEvent) => {
      if (!this.state.overlay.panning) return;
      const dx = moveEvent.clientX - this.state.overlay.panStartX;
      const dy = moveEvent.clientY - this.state.overlay.panStartY;
      this.state.overlay.offsetX = this.state.overlay.panOriginX + dx;
      this.state.overlay.offsetY = this.state.overlay.panOriginY + dy;
      this.applyOverlayTransform();
    };
    this.overlayPanEndHandler = () => this.stopOverlayPan();
    window.addEventListener("pointermove", this.overlayPanHandler);
    window.addEventListener("pointerup", this.overlayPanEndHandler);
  },

  stopOverlayPan() {
    if (this.overlayPanHandler) {
      window.removeEventListener("pointermove", this.overlayPanHandler);
      this.overlayPanHandler = null;
    }
    if (this.overlayPanEndHandler) {
      window.removeEventListener("pointerup", this.overlayPanEndHandler);
      this.overlayPanEndHandler = null;
    }
    this.state.overlay.panning = false;
    if (this.elements.overlayImage) {
      this.elements.overlayImage.classList.remove("grabbing");
    }
  },

  detachOverlayHandlers() {
    this.stopOverlayPan();
  },

  async handleCopyOriginalToClipboard() {
    const item = this.getOverlayItem();
    if (!item || item.type !== "image") return;
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
      this.toast({
        severity: "error",
        summary: t("toast.summary"),
        detail: t("toast.copy_failed", { filename: item.filename }),
        life: 3000,
      });
      return;
    }
    const url = buildViewUrl(item.relpath, this.state.tab);
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Request failed: ${response.status}`);
      }
      const blob = await response.blob();
      await this.writeImageBlobToClipboard(blob, url, item.filename);
      this.toast({
        severity: "success",
        summary: t("toast.summary"),
        detail: t("toast.copy_success", { filename: item.filename }),
        life: 1800,
      });
    } catch (error) {
      warn(t("log.copy_failed"), error);
      this.toast({
        severity: "error",
        summary: t("toast.summary"),
        detail: t("toast.copy_failed", { filename: item.filename }),
        life: 3000,
      });
    }
  },

  getImageMimeType(blob, filename) {
    if (blob.type?.startsWith("image/")) {
      return blob.type;
    }
    const extension = getFileExtension(filename);
    const mimeByExtension = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      webp: "image/webp",
      gif: "image/gif",
      bmp: "image/bmp",
      tiff: "image/tiff",
      tif: "image/tiff",
    };
    return mimeByExtension[extension] || null;
  },

  async writeImageBlobToClipboard(blob, sourceUrl, filename) {
    const mimeType = this.getImageMimeType(blob, filename);
    if (mimeType) {
      try {
        await navigator.clipboard.write([
          new ClipboardItem({ [mimeType]: blob.slice(0, blob.size, mimeType) }),
        ]);
        return;
      } catch (error) {
        if (mimeType === "image/png") {
          throw error;
        }
      }
    }
    const pngBlob = await this.renderImageToPngBlob(sourceUrl);
    await navigator.clipboard.write([new ClipboardItem({ "image/png": pngBlob })]);
  },

  renderImageToPngBlob(sourceUrl) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          const ctx = canvas.getContext("2d");
          if (!ctx) {
            reject(new Error("Canvas unavailable"));
            return;
          }
          ctx.drawImage(image, 0, 0);
          canvas.toBlob((pngBlob) => {
            if (pngBlob) {
              resolve(pngBlob);
            } else {
              reject(new Error("PNG conversion failed"));
            }
          }, "image/png");
        } catch (error) {
          reject(error);
        }
      };
      image.onerror = () => reject(new Error("Image load failed"));
      image.src = sourceUrl;
    });
  },

  handlePrintOverlayImage() {
    const item = this.getOverlayItem();
    if (!item || item.type !== "image") return;
    const url = buildViewUrl(item.relpath, this.state.tab);
    const frame = document.createElement("iframe");
    frame.className = "assets-plus-print-frame";
    document.body.appendChild(frame);
    const frameWindow = frame.contentWindow;
    const frameDocument = frame.contentDocument;
    if (!frameWindow || !frameDocument) {
      frame.remove();
      this.toast({
        severity: "error",
        summary: t("toast.summary"),
        detail: t("toast.print_failed", { filename: item.filename }),
        life: 3000,
      });
      return;
    }

    let cleanupTimer = null;
    const cleanup = () => {
      if (cleanupTimer) {
        window.clearTimeout(cleanupTimer);
        cleanupTimer = null;
      }
      frameWindow.removeEventListener("afterprint", cleanup);
      frame.remove();
    };

    frameWindow.addEventListener("afterprint", cleanup);
    cleanupTimer = window.setTimeout(cleanup, 60000);
    frameDocument.open();
    frameDocument.write(
      "<!doctype html><html><head><title></title><style>" +
        "@page{margin:0}html,body{margin:0;width:100%;height:100%;background:#111}" +
        "body{display:flex;align-items:center;justify-content:center}" +
        "img{max-width:100vw;max-height:100vh;object-fit:contain}" +
      "</style></head><body></body></html>"
    );
    frameDocument.close();
    frameDocument.title = item.filename;
    const image = frameDocument.createElement("img");
    image.alt = item.filename;
    image.onload = () => {
      window.setTimeout(() => {
        frameWindow.focus();
        frameWindow.print();
      }, 50);
    };
    image.onerror = () => {
      cleanup();
      this.toast({
        severity: "error",
        summary: t("toast.summary"),
        detail: t("toast.print_failed", { filename: item.filename }),
        life: 3000,
      });
    };
    image.src = url;
    frameDocument.body.appendChild(image);
  },

  maybeCloseOverlayAfterWorkflow(options = {}) {
    if (!options.fromOverlay) return;
    const { keepOverlayOpenOnWorkflow } = this.getSettingsSnapshot();
    if (!keepOverlayOpenOnWorkflow) {
      this.closeOverlay();
    }
  },
};
