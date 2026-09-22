import { THUMB_QUALITY_SIZES, DEFAULT_THUMB_QUALITY, SETTINGS_CATEGORY } from './constants.js';
import { app as importedApp } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { t } from './i18n.js';

export const log = (...args) => console.log("[Assets+ Explorer]", ...args);
export const warn = (...args) => console.warn("[Assets+ Explorer]", ...args);

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export const resolveApp = () => window.app || window.comfyApp || window.comfy?.app || importedApp;

export const normalizeThumbnailQuality = (value) => {
  if (typeof value !== "string") return null;
  const normalized = value.toLowerCase().trim();
  return Object.prototype.hasOwnProperty.call(THUMB_QUALITY_SIZES, normalized)
    ? normalized
    : null;
};

export const inferThumbnailQualityFromSize = (value) => {
  const size = Number(value);
  if (!Number.isFinite(size)) return null;
  return size >= THUMB_QUALITY_SIZES.high ? "high" : "low";
};

export const resolveThumbnailQuality = (qualityValue, sizeFallback) => {
  return (
    normalizeThumbnailQuality(qualityValue) ||
    inferThumbnailQualityFromSize(sizeFallback) ||
    DEFAULT_THUMB_QUALITY
  );
};

export const resolveThumbnailSize = (qualityValue, sizeFallback) => {
  const quality = resolveThumbnailQuality(qualityValue, sizeFallback);
  return THUMB_QUALITY_SIZES[quality] || THUMB_QUALITY_SIZES[DEFAULT_THUMB_QUALITY];
};

export const createSettingsButtonRenderer = (label, onClick) => {
  return () => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "assets-plus-settings-button";
    button.textContent = label;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      onClick?.();
    });
    return button;
  };
};

export const waitForApp = async () => {
  const maxAttempts = 200;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const appInstance = resolveApp();
    if (appInstance?.registerExtension) {
      return appInstance;
    }
    await sleep(100);
  }
  return null;
};

export const fetchJson = async (path, options) => {
  const response = api?.fetchApi ? await api.fetchApi(path, options) : await fetch(path, options);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json();
};

export const getSettingValue = (appInstance, id, fallback) => {
  const sources = [
    appInstance?.settings?.get?.bind(appInstance?.settings),
    appInstance?.ui?.settings?.get?.bind(appInstance?.ui?.settings),
  ].filter(Boolean);
  for (const getter of sources) {
    const value = getter(id);
    if (value !== undefined && value !== null) {
      return value;
    }
  }
  return fallback;
};

export const buildViewUrl = (relpath, directory) => {
  const segments = relpath.split("/");
  const filename = segments.pop() ?? relpath;
  const subfolder = segments.join("/");
  const params = new URLSearchParams({ filename, type: directory });
  if (subfolder) {
    params.set("subfolder", subfolder);
  }
  return `/view?${params.toString()}`;
};

export const buildThumbUrl = (relpath, directory, size) => {
  const params = new URLSearchParams({
    relpath,
    w: String(size),
    h: String(size),
  });
  return `/assets_plus/${directory}/thumb?${params.toString()}`;
};

export const getFileExtension = (filename) => filename.split(".").pop()?.toLowerCase() || "";

export const normalizeWorkflow = (workflow) => {
  if (!workflow) return null;
  if (typeof workflow === "string") {
    try {
      return JSON.parse(workflow);
    } catch (error) {
      warn(t("log.workflow_parse_error"), error);
      return null;
    }
  }
  return workflow;
};

export const workflowFilenameForAsset = (filename) => filename.replace(/\.[^/.]+$/, ".json");

export const resolveWorkflowStore = (appInstance) => {
  const workflowRef = appInstance?.extensionManager?.workflow ?? null;
  if (!workflowRef) return null;
  return workflowRef.value ?? workflowRef;
};

export const resolveWorkflowActionsService = (appInstance) => {
  return (
    appInstance?.extensionManager?.workflowActionsService ||
    appInstance?.extensionManager?.workflowActions ||
    null
  );
};

export const createElement = (tag, { className, text, attrs } = {}) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  if (attrs) {
    Object.entries(attrs).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        node.setAttribute(key, String(value));
      }
    });
  }
  return node;
};

export const createStyleTag = () => {
  try {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = new URL("./assets_plus.css", import.meta.url).href;
    return link;
  } catch {
    const style = document.createElement("style");
    style.textContent = "";
    return style;
  }
};
