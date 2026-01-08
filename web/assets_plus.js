import { app as importedApp } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const EXTENSION_NAME = "digidwarf.AssetsPlus";
const SIDEBAR_TAB_ID = "assets-plus-explorer";
const OUTPUT_TAB = "output";
const INPUT_TAB = "input";

const DEFAULT_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "mp4", "webm"];
const DEFAULT_LIST_LIMIT = 200;
const DEFAULT_THUMB_QUALITY = "low";
const THUMB_QUALITY_SIZES = {
  low: 256,
  high: 512,
};
const DEFAULT_DELETE_MODE = "trash";
const DEFAULT_CONFIRM_DELETE = true;
const DEFAULT_SHOW_OVERLAY_HELP = true;
const DEFAULT_KEEP_OVERLAY_OPEN_ON_WORKFLOW = false;
const DEFAULT_LANGUAGE = "en";
const SETTINGS_CATEGORY = "Assets+";
const ASSETS_PLUS_SHORTCUTS_CATEGORY = "assets-plus";
const ASSETS_PLUS_SHORTCUTS_TAB_ID = "shortcuts-assets-plus";
const ASSETS_PLUS_SHORTCUTS_TAB_CLASS = "assets-plus";
const ASSETS_PLUS_SHORTCUTS_SUBCATEGORY = "overlay";
const OVERLAY_COMMANDS = {
  first: "AssetsPlus.OverlayNavigateFirst",
  prev: "AssetsPlus.OverlayNavigatePrevious",
  last: "AssetsPlus.OverlayNavigateLast",
  next: "AssetsPlus.OverlayNavigateNext",
  delete: "AssetsPlus.OverlayDelete",
};
const OVERLAY_KEYBINDINGS = [
  {
    commandId: OVERLAY_COMMANDS.prev,
    combo: { key: "a" },
  },
  {
    commandId: OVERLAY_COMMANDS.next,
    combo: { key: "d" },
  },
  {
    commandId: OVERLAY_COMMANDS.last,
    combo: { key: "s" },
  },
  {
    commandId: OVERLAY_COMMANDS.delete,
    combo: { key: "x" },
  },
];

const SETTINGS = {
  listLimit: "AssetsPlus.ListLimit",
  recursive: "AssetsPlus.RecursiveScan",
  scanDepth: "AssetsPlus.ScanDepth",
  deleteMode: "AssetsPlus.DeleteMode",
  thumbnailQuality: "AssetsPlus.ThumbnailQuality",
  clearThumbnails: "AssetsPlus.ClearThumbnails",
  confirmDelete: "AssetsPlus.ConfirmDelete",
  showOverlayHelp: "AssetsPlus.ShowOverlayHelp",
  keepOverlayOpenOnWorkflow: "AssetsPlus.KeepOverlayOpenOnWorkflow",
  language: "AssetsPlus.Language",
};

const applySettingsCategory = (setting, groupLabel) => ({
  ...setting,
  category: [SETTINGS_CATEGORY, groupLabel, setting.id],
});

const log = (...args) => console.log("[Assets+ Explorer]", ...args);
const warn = (...args) => console.warn("[Assets+ Explorer]", ...args);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const resolveApp = () => window.app || window.comfyApp || window.comfy?.app || importedApp;

const normalizeThumbnailQuality = (value) => {
  if (typeof value !== "string") return null;
  const normalized = value.toLowerCase().trim();
  return Object.prototype.hasOwnProperty.call(THUMB_QUALITY_SIZES, normalized)
    ? normalized
    : null;
};

const inferThumbnailQualityFromSize = (value) => {
  const size = Number(value);
  if (!Number.isFinite(size)) return null;
  return size >= THUMB_QUALITY_SIZES.high ? "high" : "low";
};

const resolveThumbnailQuality = (qualityValue, sizeFallback) => {
  return (
    normalizeThumbnailQuality(qualityValue) ||
    inferThumbnailQualityFromSize(sizeFallback) ||
    DEFAULT_THUMB_QUALITY
  );
};

const resolveThumbnailSize = (qualityValue, sizeFallback) => {
  const quality = resolveThumbnailQuality(qualityValue, sizeFallback);
  return THUMB_QUALITY_SIZES[quality] || THUMB_QUALITY_SIZES[DEFAULT_THUMB_QUALITY];
};

const createSettingsButtonRenderer = (label, onClick) => {
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

const SHORTCUT_KEY_LABELS = {
  Control: "Ctrl",
  Meta: "Cmd",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Backspace: "⌫",
  Delete: "⌦",
  Enter: "↵",
  Escape: "Esc",
  Tab: "⇥",
  " ": "Space",
};

const formatShortcutKey = (key) => SHORTCUT_KEY_LABELS[key] || key;

const getKeySequences = (keybinding) => {
  if (!keybinding?.combo) return [];
  if (typeof keybinding.combo.getKeySequences === "function") {
    return keybinding.combo.getKeySequences();
  }
  return keybinding.combo.key ? [keybinding.combo.key] : [];
};

let activeTranslations = {};
let fallbackTranslations = {};
let activeLanguage = DEFAULT_LANGUAGE;
let explorerInstance = null;
let shortcutsPanelInstance = null;

const t = (key, vars = {}) => {
  const template = activeTranslations?.[key] ?? fallbackTranslations?.[key] ?? key;
  if (typeof template !== "string") return String(template);
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match
  );
};

const waitForApp = async () => {
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

const fetchJson = async (path, options) => {
  const response = api?.fetchApi ? await api.fetchApi(path, options) : await fetch(path, options);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json();
};

const getSettingValue = (appInstance, id, fallback) => {
  const sources = [
    appInstance?.settings?.get?.bind(appInstance?.settings),
    appInstance?.ui?.settings?.get?.bind(appInstance?.ui?.settings),
    appInstance?.extensionManager?.setting?.get?.bind(appInstance?.extensionManager?.setting),
  ].filter(Boolean);
  for (const getter of sources) {
    const value = getter(id);
    if (value !== undefined && value !== null) {
      return value;
    }
  }
  return fallback;
};

const loadTranslationsList = async () => {
  try {
    const payload = await fetchJson("/assets_plus/i18n");
    if (Array.isArray(payload?.translations)) {
      return payload.translations;
    }
  } catch (error) {
    warn(t("log.translations_list_failed"), error);
  }
  return [];
};

const loadTranslationData = async (language) => {
  try {
    return await fetchJson(`/assets_plus/i18n?lang=${encodeURIComponent(language)}`);
  } catch (error) {
    warn(t("log.translation_load_failed", { language }), error);
  }
  return {};
};

const buildLanguageOptions = (translations) => {
  if (!translations.length) {
    return [{ text: DEFAULT_LANGUAGE, value: DEFAULT_LANGUAGE }];
  }
  return translations.map((entry) => {
    const name = entry["translation-name"] || entry.code;
    const author = entry["translation-author"];
    const label = author ? `${name} — ${author}` : name;
    return { text: label, value: entry.code };
  });
};

const buildOverlayCommands = () => [
  {
    id: OVERLAY_COMMANDS.first,
    label: () => t("overlay.hint.first"),
    category: ASSETS_PLUS_SHORTCUTS_CATEGORY,
    function: () => explorerInstance?.handleOverlayCommand("first"),
  },
  {
    id: OVERLAY_COMMANDS.prev,
    label: () => t("overlay.hint.previous"),
    category: ASSETS_PLUS_SHORTCUTS_CATEGORY,
    function: () => explorerInstance?.handleOverlayCommand("prev"),
  },
  {
    id: OVERLAY_COMMANDS.last,
    label: () => t("overlay.hint.last"),
    category: ASSETS_PLUS_SHORTCUTS_CATEGORY,
    function: () => explorerInstance?.handleOverlayCommand("last"),
  },
  {
    id: OVERLAY_COMMANDS.next,
    label: () => t("overlay.hint.next"),
    category: ASSETS_PLUS_SHORTCUTS_CATEGORY,
    function: () => explorerInstance?.handleOverlayCommand("next"),
  },
  {
    id: OVERLAY_COMMANDS.delete,
    label: () => t("actions.delete"),
    category: ASSETS_PLUS_SHORTCUTS_CATEGORY,
    function: () => explorerInstance?.handleOverlayCommand("delete"),
  },
];

const applyLanguage = async (language, { force = false } = {}) => {
  const normalized = language || DEFAULT_LANGUAGE;
  if (!force && normalized === activeLanguage) {
    return;
  }
  fallbackTranslations = await loadTranslationData(DEFAULT_LANGUAGE);
  activeTranslations =
    normalized === DEFAULT_LANGUAGE
      ? fallbackTranslations
      : await loadTranslationData(normalized);
  activeLanguage = normalized;
  explorerInstance?.updateTranslations?.();
  shortcutsPanelInstance?.updateTranslations?.();
};

const buildSettingsSchema = (t, languageOptions, handleLanguageChange, handleClearThumbnails) => {
  const settingsGroup = t("settings.group");
  const withCategory = (setting) => applySettingsCategory(setting, settingsGroup);
  return [
    withCategory({
      id: SETTINGS.listLimit,
      name: t("settings.list_limit"),
      type: "number",
      defaultValue: DEFAULT_LIST_LIMIT,
      attrs: { min: 50, step: 50 },
    }),
    withCategory({
      id: SETTINGS.recursive,
      name: t("settings.recursive"),
      type: "boolean",
      defaultValue: true,
    }),
    withCategory({
      id: SETTINGS.scanDepth,
      name: t("settings.scan_depth"),
      type: "number",
      defaultValue: 0,
      attrs: { min: 0, step: 1 },
    }),
    withCategory({
      id: SETTINGS.deleteMode,
      name: t("settings.delete_mode"),
      type: "combo",
      defaultValue: DEFAULT_DELETE_MODE,
      options: [
        { text: t("settings.delete_mode.trash"), value: "trash" },
        { text: t("settings.delete_mode.delete"), value: "delete" },
        { text: t("settings.delete_mode.hide"), value: "hide" },
      ],
    }),
    withCategory({
      id: SETTINGS.confirmDelete,
      name: t("settings.confirm_delete"),
      type: "boolean",
      defaultValue: DEFAULT_CONFIRM_DELETE,
    }),
    withCategory({
      id: SETTINGS.showOverlayHelp,
      name: t("settings.show_overlay_help"),
      type: "boolean",
      defaultValue: DEFAULT_SHOW_OVERLAY_HELP,
    }),
    withCategory({
      id: SETTINGS.keepOverlayOpenOnWorkflow,
      name: t("settings.keep_overlay_open_on_workflow"),
      type: "boolean",
      defaultValue: DEFAULT_KEEP_OVERLAY_OPEN_ON_WORKFLOW,
    }),
    withCategory({
      id: SETTINGS.thumbnailQuality,
      name: t("settings.thumbnail_quality"),
      type: "combo",
      defaultValue: DEFAULT_THUMB_QUALITY,
      options: [
        { text: t("settings.thumbnail_quality.low"), value: "low" },
        { text: t("settings.thumbnail_quality.high"), value: "high" },
      ],
    }),
    withCategory({
      id: SETTINGS.clearThumbnails,
      name: t("settings.clear_thumbnails"),
      type: createSettingsButtonRenderer(t("settings.clear_thumbnails"), () => {
        if (typeof handleClearThumbnails === "function") {
          handleClearThumbnails();
        }
      }),
      defaultValue: "",
    }),
    withCategory({
      id: SETTINGS.language,
      name: t("settings.language"),
      type: "combo",
      defaultValue: DEFAULT_LANGUAGE,
      options: languageOptions,
      onChange: (newValue, oldValue) => {
        if (typeof handleLanguageChange === "function") {
          handleLanguageChange(newValue, oldValue);
        }
      },
    }),
  ];
};

class AssetsPlusShortcutsPanel {
  constructor(appInstance, container) {
    this.app = appInstance;
    this.container = container;
    this.render();
  }

  getCommands() {
    const commands = this.app?.extensionManager?.command?.commands || [];
    const commandsById = new Map(commands.map((command) => [command.id, command]));
    return Object.values(OVERLAY_COMMANDS)
      .map((id) => commandsById.get(id))
      .filter(Boolean);
  }

  buildShortcutItem(command) {
    const keybinding = command?.keybinding;
    if (!keybinding) return null;
    const sequences = getKeySequences(keybinding);
    if (!sequences.length) return null;

    const item = document.createElement("div");
    item.className =
      "shortcut-item flex items-center justify-between rounded py-2 transition-colors duration-200";

    const info = document.createElement("div");
    info.className = "shortcut-info grow pr-4";
    const name = document.createElement("div");
    name.className = "shortcut-name text-sm font-medium";
    name.textContent = command?.label || command?.id || "";
    info.append(name);

    const keybindingDisplay = document.createElement("div");
    keybindingDisplay.className = "keybinding-display shrink-0";
    const keybindingCombo = document.createElement("div");
    keybindingCombo.className = "keybinding-combo flex gap-1";
    keybindingCombo.setAttribute("aria-label", `Keyboard shortcut: ${sequences.join(" + ")}`);

    sequences.forEach((key) => {
      const badge = document.createElement("span");
      badge.className =
        "key-badge min-w-6 rounded bg-muted-background px-2 py-1 text-center font-mono text-xs";
      badge.textContent = formatShortcutKey(key);
      keybindingCombo.append(badge);
    });

    keybindingDisplay.append(keybindingCombo);
    item.append(info, keybindingDisplay);
    return item;
  }

  render() {
    this.container.innerHTML = "";

    const root = document.createElement("div");
    root.className = `flex h-full flex-col ${ASSETS_PLUS_SHORTCUTS_TAB_CLASS}`;

    const content = document.createElement("div");
    content.className = "flex h-full flex-col p-4";

    const scroll = document.createElement("div");
    scroll.className = "min-h-0 flex-1 overflow-auto";

    const shortcutsList = document.createElement("div");
    shortcutsList.className = `shortcuts-list flex justify-center ${ASSETS_PLUS_SHORTCUTS_TAB_CLASS}`;

    const grid = document.createElement("div");
    grid.className = "grid h-full w-[90%] grid-cols-1 gap-4 md:grid-cols-3 md:gap-24";

    const column = document.createElement("div");
    column.className = "flex flex-col";

    const title = document.createElement("h3");
    title.className =
      "subcategory-title mb-4 text-xs font-bold tracking-wide text-text-secondary uppercase";
    title.textContent = t(`shortcuts.assets_plus.${ASSETS_PLUS_SHORTCUTS_SUBCATEGORY}`);

    const list = document.createElement("div");
    list.className = "flex flex-col gap-1";

    this.getCommands()
      .map((command) => this.buildShortcutItem(command))
      .filter(Boolean)
      .forEach((item) => list.append(item));

    column.append(title, list);
    grid.append(column);
    shortcutsList.append(grid);
    scroll.append(shortcutsList);
    content.append(scroll);
    root.append(content);
    this.container.append(root);
  }

  updateTranslations() {
    this.render();
  }

  destroy() {
    this.container.innerHTML = "";
  }
}

const buildViewUrl = (relpath, directory) => {
  const segments = relpath.split("/");
  const filename = segments.pop() ?? relpath;
  const subfolder = segments.join("/");
  const params = new URLSearchParams({ filename, type: directory });
  if (subfolder) {
    params.set("subfolder", subfolder);
  }
  return `/view?${params.toString()}`;
};

const buildThumbUrl = (relpath, directory, size) => {
  const params = new URLSearchParams({
    relpath,
    w: String(size),
    h: String(size),
  });
  return `/assets_plus/${directory}/thumb?${params.toString()}`;
};

const normalizeWorkflow = (workflow) => {
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

const workflowFilenameForAsset = (filename) => filename.replace(/\.[^/.]+$/, ".json");

const resolveWorkflowStore = (appInstance) => {
  const workflowRef = appInstance?.extensionManager?.workflow ?? null;
  if (!workflowRef) return null;
  return workflowRef.value ?? workflowRef;
};

const resolveWorkflowActionsService = (appInstance) => {
  const fromApp =
    appInstance?.extensionManager?.workflowActionsService ||
    appInstance?.extensionManager?.workflowActions ||
    appInstance?.workflowActionsService ||
    appInstance?.workflowActions ||
    null;
  if (fromApp?.openWorkflowAction) {
    return fromApp;
  }
  return (
    window?.comfyWorkflowActionsService ||
    window?.workflowActionsService ||
    window?.useWorkflowActionsService?.() ||
    null
  );
};

const createElement = (tag, { className, text, attrs } = {}) => {
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

const createStyleTag = () => {
  const style = document.createElement("style");
  style.textContent = `
    .assets-plus-container {
      display: flex;
      flex-direction: column;
      height: 100%;
      overflow: hidden;
    }
    .assets-plus-root {
      display: flex;
      flex-direction: column;
      gap: 0;
      padding: 0;
      height: 100%;
      min-height: 0;
      overflow: hidden;
      color: var(--fg-color, #e5e7eb);
      font-family: var(--font-family, sans-serif);
      --assets-plus-border: var(--border-color, rgba(148, 163, 184, 0.35));
      --assets-plus-panel-bg: var(--comfy-menu-bg, var(--bg-color, #0f172a));
      --assets-plus-control-bg: var(--comfy-menu-secondary-bg, rgba(15, 23, 42, 0.6));
      --assets-plus-card-bg: var(--comfy-menu-secondary-bg, rgba(15, 23, 42, 0.5));
      --assets-plus-input-bg: var(--comfy-input-bg, var(--comfy-menu-secondary-bg, #0f172a));
      --assets-plus-accent: var(--p-primary-color, #2563eb);
      --assets-plus-accent-contrast: var(--p-primary-contrast-color, #ffffff);
      --assets-plus-thumb-bg: var(--comfy-menu-bg, var(--bg-color, #0f172a));
      background: var(--assets-plus-panel-bg);
    }
    .assets-plus-header {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 10px 12px 8px;
      background: var(--assets-plus-panel-bg);
      border-bottom: 1px solid var(--assets-plus-border);
      flex: 0 0 auto;
    }
    .assets-plus-body {
      flex: 1;
      min-height: 0;
      overflow: auto;
      overflow-x: hidden;
      padding: 0 12px 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .assets-plus-title-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .assets-plus-title {
      font-size: 16px;
      font-weight: 600;
    }
    .assets-plus-controls {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
    }
    .assets-plus-tab {
      border: 1px solid var(--assets-plus-border);
      background: var(--assets-plus-control-bg);
      color: inherit;
      padding: 4px 10px;
      border-radius: 6px;
      cursor: pointer;
    }
    .assets-plus-tab.active {
      background: var(--assets-plus-card-bg);
      border-color: var(--assets-plus-accent);
      color: inherit;
      box-shadow: 0 0 0 1px var(--assets-plus-accent) inset;
    }
    .assets-plus-button {
      border: 1px solid var(--assets-plus-border);
      background: var(--assets-plus-control-bg);
      color: inherit;
      padding: 6px 10px;
      border-radius: 6px;
      cursor: pointer;
    }
    .assets-plus-button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .assets-plus-settings-button {
      border: 1px solid var(--border-color, rgba(148, 163, 184, 0.35));
      background: var(--comfy-menu-secondary-bg, rgba(15, 23, 42, 0.6));
      color: var(--fg-color, #e5e7eb);
      padding: 6px 12px;
      border-radius: 6px;
      cursor: pointer;
    }
    .assets-plus-settings-button:hover {
      border-color: var(--p-primary-color, #2563eb);
    }
    .assets-plus-input {
      width: 100%;
      padding: 6px 8px;
      border-radius: 6px;
      border: 1px solid var(--assets-plus-border);
      background: var(--assets-plus-input-bg);
      color: inherit;
    }
    .assets-plus-search {
      display: none;
    }
    .assets-plus-search.visible {
      display: block;
    }
    .assets-plus-status {
      font-size: 12px;
      opacity: 0.8;
    }
    .assets-plus-grid {
      display: grid;
      gap: 10px;
      grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    }
    .assets-plus-card {
      border: 1px solid var(--assets-plus-border);
      background: var(--assets-plus-card-bg);
      border-radius: 8px;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      cursor: pointer;
      transition: border 0.15s ease, box-shadow 0.15s ease;
      position: relative;
    }
    .assets-plus-card.selected {
      border-color: var(--assets-plus-accent);
      box-shadow: 0 0 0 1px var(--assets-plus-accent);
    }
    .assets-plus-checkbox {
      position: absolute;
      top: 6px;
      left: 6px;
      width: 16px;
      height: 16px;
      accent-color: rgba(148, 163, 184, 0.9);
      z-index: 2;
      cursor: pointer;
    }
    .assets-plus-thumb {
      width: 100%;
      height: 120px;
      background: var(--assets-plus-thumb-bg);
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .assets-plus-thumb img,
    .assets-plus-thumb video {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    .assets-plus-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
    }
    .assets-plus-action-button {
      border: 1px solid rgba(148, 163, 184, 0.35);
      background: var(--assets-plus-control-bg);
      color: inherit;
      padding: 6px 8px;
      border-radius: 10px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 32px;
      min-height: 32px;
      box-shadow: 0 4px 10px rgba(15, 23, 42, 0.18);
      backdrop-filter: blur(8px);
    }
    .assets-plus-action-button:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
    .assets-plus-action-button .pi {
      font-size: 14px;
    }
    .assets-plus-card-menu {
      position: absolute;
      top: 6px;
      right: 6px;
      z-index: 3;
    }
    .assets-plus-card-menu-button {
      border: 1px solid rgba(148, 163, 184, 0.35);
      background: var(--assets-plus-control-bg);
      color: inherit;
      padding: 4px 6px;
      border-radius: 8px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      backdrop-filter: blur(8px);
    }
    .assets-plus-context-menu {
      position: fixed;
      z-index: 1001;
      display: none;
      min-width: 200px;
    }
    .assets-plus-context-menu.open {
      display: block;
    }
    .assets-plus-context-menu-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 6px;
      border-radius: 10px;
      border: 1px solid var(--assets-plus-border);
      background: var(--assets-plus-control-bg);
      box-shadow: 0 8px 18px rgba(0, 0, 0, 0.25);
      backdrop-filter: blur(8px);
    }
    .assets-plus-context-menu-item {
      border: 1px solid rgba(148, 163, 184, 0.25);
      background: var(--assets-plus-card-bg);
      color: inherit;
      padding: 6px 8px;
      border-radius: 8px;
      cursor: pointer;
      text-align: left;
    }
    .assets-plus-context-menu-item:hover {
      background: rgba(148, 163, 184, 0.2);
    }
    .assets-plus-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.85);
      display: flex;
      flex-direction: column;
      opacity: 0;
      visibility: hidden;
      transition: opacity 0.2s ease;
      z-index: 9999;
      color: #e5e7eb;
    }
    .assets-plus-overlay.active {
      opacity: 1;
      visibility: visible;
    }
    .assets-plus-overlay-top {
      display: flex;
      align-items: center;
      padding: 10px 18px;
      background: rgba(0, 0, 0, 0.65);
      backdrop-filter: blur(6px);
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      gap: 12px;
    }
    .assets-plus-overlay-info {
      font-size: 13px;
      opacity: 0.85;
      display: flex;
      gap: 12px;
      align-items: center;
      flex-wrap: wrap;
      flex: 1;
      min-width: 0;
    }
    .assets-plus-overlay-top-actions {
      display: flex;
      gap: 8px;
      align-items: center;
      margin-left: auto;
    }
    .assets-plus-icon-button {
      border: 1px solid rgba(255, 255, 255, 0.2);
      background: rgba(0, 0, 0, 0.4);
      color: inherit;
      padding: 6px 8px;
      border-radius: 8px;
      cursor: pointer;
    }
    .assets-plus-icon-button.workflow-open {
      border-color: rgba(140, 220, 170, 0.6);
      box-shadow: 0 0 0 1px rgba(140, 220, 170, 0.2) inset;
    }
    .assets-plus-icon-button.workflow-replace {
      border-color: rgba(235, 200, 120, 0.7);
      box-shadow: 0 0 0 1px rgba(235, 200, 120, 0.2) inset;
    }
    .assets-plus-icon-button:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
    .assets-plus-icon-button .pi {
      font-size: 14px;
    }
    .assets-plus-overlay-close {
      border: none;
      background: transparent;
      color: inherit;
      font-size: 24px;
      cursor: pointer;
      padding: 4px 10px;
    }
    .assets-plus-overlay-body {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 16px;
      padding: 18px;
    }
    .assets-plus-overlay-media {
      flex: 1;
      max-height: 100%;
      max-width: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
      position: relative;
    }
    .assets-plus-overlay-image,
    .assets-plus-overlay-video {
      max-width: 100%;
      max-height: 100%;
      transform-origin: center center;
      user-select: none;
    }
    .assets-plus-overlay-image.zoomable {
      cursor: grab;
    }
    .assets-plus-overlay-image.zoomable.grabbing {
      cursor: grabbing;
    }
    .assets-plus-overlay-nav {
      border: 1px solid rgba(255, 255, 255, 0.2);
      background: rgba(0, 0, 0, 0.4);
      color: inherit;
      font-size: 24px;
      padding: 6px 12px;
      border-radius: 8px;
      cursor: pointer;
    }
    .assets-plus-overlay-nav:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
    .assets-plus-overlay-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      padding: 12px 18px 18px;
      justify-content: center;
    }
    .assets-plus-overlay-actions .assets-plus-button {
      background: rgba(0, 0, 0, 0.4);
      border-color: rgba(255, 255, 255, 0.2);
    }
    .assets-plus-overlay-reset {
      position: absolute;
      right: 24px;
      bottom: 24px;
      border: 1px solid rgba(255, 255, 255, 0.3);
      background: rgba(0, 0, 0, 0.6);
      color: inherit;
      padding: 6px 10px;
      border-radius: 8px;
      cursor: pointer;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.2s ease;
    }
    .assets-plus-overlay-reset.active {
      opacity: 1;
      pointer-events: auto;
    }
    .assets-plus-overlay-hint {
      position: absolute;
      left: 20px;
      bottom: 20px;
      display: grid;
      grid-template-columns: repeat(3, auto);
      gap: 6px;
      padding: 10px;
      border-radius: 14px;
      background: rgba(8, 12, 20, 0.55);
      border: 1px solid rgba(255, 255, 255, 0.15);
      box-shadow: 0 10px 24px rgba(0, 0, 0, 0.35);
      backdrop-filter: blur(8px);
      opacity: 0.55;
      transition: opacity 0.2s ease;
      pointer-events: none;
      z-index: 10001;
    }
    .assets-plus-overlay-hint:has(.assets-plus-hint-button:hover) {
      opacity: 0.95;
    }
    .assets-plus-hint-button {
      pointer-events: auto;
      border: 1px solid rgba(255, 255, 255, 0.2);
      background: rgba(0, 0, 0, 0.35);
      color: inherit;
      padding: 6px 8px;
      border-radius: 10px;
      font-size: 12px;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      cursor: pointer;
      min-width: 44px;
      min-height: 34px;
      justify-content: center;
    }
    .assets-plus-hint-button:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
    .assets-plus-hint-button.danger {
      background: rgba(255, 140, 0, 0.25);
      border-color: rgba(255, 140, 0, 0.8);
    }
    .assets-plus-hint-key {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: 11px;
      padding: 2px 6px;
      border-radius: 6px;
      border: 1px solid rgba(255, 255, 255, 0.2);
      background: rgba(0, 0, 0, 0.4);
      min-width: 18px;
      height: 18px;
    }
  `;
  return style;
};

class AssetsPlusExplorer {
  constructor(appInstance, container) {
    this.app = appInstance;
    this.container = container;
    this.sidebarOverflowState = null;
    this.sidebarContent = null;
    this.state = {
      tab: OUTPUT_TAB,
      items: [],
      loading: false,
      loadingMore: false,
      error: null,
      search: "",
      searchVisible: false,
      selected: new Set(),
      config: null,
      cursor: "",
      hasMore: true,
      latestMtime: 0,
      searchDebounceId: null,
      scrollTicking: false,
      pendingRefresh: {
        [OUTPUT_TAB]: false,
        [INPUT_TAB]: false,
      },
      scrollPositions: {
        [OUTPUT_TAB]: 0,
        [INPUT_TAB]: 0,
      },
      contextMenu: {
        relpath: null,
        open: false,
      },
      overlay: {
        relpath: null,
        zoom: 1,
        offsetX: 0,
        offsetY: 0,
        panning: false,
        panStartX: 0,
        panStartY: 0,
        panOriginX: 0,
        panOriginY: 0,
      },
    };
    this.elements = {};
    this.overlayPanHandler = null;
    this.documentClickHandler = (event) => this.handleDocumentClick(event);
    this.thumbObserver = null;
    this.scrollHandler = null;
    this.apiEventHandlers = [];
    this.init();
  }

  init() {
    this.container.innerHTML = "";
    this.container.classList.add("assets-plus-container");
    this.sidebarContent = this.container.closest(".sidebar-content-container");
    if (this.sidebarContent) {
      this.sidebarOverflowState = {
        overflow: this.sidebarContent.style.overflow,
        overflowX: this.sidebarContent.style.overflowX,
        overflowY: this.sidebarContent.style.overflowY,
      };
      this.sidebarContent.style.overflow = "hidden";
      this.sidebarContent.style.overflowX = "hidden";
      this.sidebarContent.style.overflowY = "hidden";
    }
    const root = createElement("div", { className: "assets-plus-root" });
    const header = createElement("div", { className: "assets-plus-header" });

    const titleRow = createElement("div", { className: "assets-plus-title-row" });
    const title = createElement("div", { className: "assets-plus-title", text: t("app.title") });
    const refreshButton = createElement("button", {
      className: "assets-plus-action-button",
      attrs: { title: t("actions.refresh"), "aria-label": t("actions.refresh") },
    });
    refreshButton.innerHTML = '<i class="pi pi-refresh"></i>';
    titleRow.appendChild(title);
    titleRow.appendChild(refreshButton);

    const controls = createElement("div", { className: "assets-plus-controls" });
    const outputTab = createElement("button", {
      className: "assets-plus-tab active",
      text: t("tabs.output"),
    });
    const inputTab = createElement("button", {
      className: "assets-plus-tab",
      text: t("tabs.input"),
    });
    controls.appendChild(outputTab);
    controls.appendChild(inputTab);

    const actionsBar = createElement("div", { className: "assets-plus-actions" });
    const searchToggle = createElement("button", {
      className: "assets-plus-action-button",
      attrs: { title: t("actions.search"), "aria-label": t("actions.search") },
    });
    searchToggle.innerHTML = '<i class="pi pi-search"></i>';
    const selectAllButton = createElement("button", {
      className: "assets-plus-action-button",
      attrs: { title: t("actions.select_all"), "aria-label": t("actions.select_all") },
    });
    selectAllButton.innerHTML = '<i class="pi pi-check-square"></i>';
    const invertSelectionButton = createElement("button", {
      className: "assets-plus-action-button",
      attrs: { title: t("actions.invert_selection"), "aria-label": t("actions.invert_selection") },
    });
    invertSelectionButton.innerHTML = '<i class="pi pi-clone"></i>';
    const downloadButton = createElement("button", {
      className: "assets-plus-action-button",
      attrs: { title: t("actions.download"), "aria-label": t("actions.download") },
    });
    downloadButton.innerHTML = '<i class="pi pi-download"></i>';
    const deleteButton = createElement("button", {
      className: "assets-plus-action-button",
      attrs: { title: t("actions.delete"), "aria-label": t("actions.delete") },
    });
    deleteButton.innerHTML = '<i class="pi pi-trash"></i>';

    actionsBar.appendChild(searchToggle);
    actionsBar.appendChild(selectAllButton);
    actionsBar.appendChild(invertSelectionButton);
    actionsBar.appendChild(downloadButton);
    actionsBar.appendChild(deleteButton);

    const searchInput = createElement("input", {
      className: "assets-plus-input assets-plus-search",
      attrs: { placeholder: t("search.placeholder") },
    });

    header.appendChild(titleRow);
    header.appendChild(controls);
    header.appendChild(actionsBar);
    header.appendChild(searchInput);

    const status = createElement("div", { className: "assets-plus-status" });
    const grid = createElement("div", { className: "assets-plus-grid" });
    const body = createElement("div", { className: "assets-plus-body" });
    body.appendChild(status);
    body.appendChild(grid);

    root.appendChild(header);
    root.appendChild(body);

    const contextMenu = createElement("div", { className: "assets-plus-context-menu" });
    const contextMenuList = createElement("div", { className: "assets-plus-context-menu-list" });
    const contextMenuOpen = createElement("button", {
      className: "assets-plus-context-menu-item",
      text: t("actions.open_workflow_new_tab"),
    });
    const contextMenuReplace = createElement("button", {
      className: "assets-plus-context-menu-item",
      text: t("actions.replace_workflow"),
    });
    contextMenuList.appendChild(contextMenuOpen);
    contextMenuList.appendChild(contextMenuReplace);
    contextMenu.appendChild(contextMenuList);

    const overlay = createElement("div", { className: "assets-plus-overlay" });
    const overlayTop = createElement("div", { className: "assets-plus-overlay-top" });
    const overlayInfo = createElement("div", { className: "assets-plus-overlay-info" });
    const overlayTopActions = createElement("div", { className: "assets-plus-overlay-top-actions" });
    const overlayDownload = createElement("button", {
      className: "assets-plus-icon-button",
      attrs: { title: t("actions.download"), "aria-label": t("actions.download") },
    });
    overlayDownload.innerHTML = '<i class="pi pi-download"></i>';
    const overlayOpenWorkflow = createElement("button", {
      className: "assets-plus-icon-button workflow-open",
      attrs: {
        title: t("actions.open_workflow_new_tab"),
        "aria-label": t("actions.open_workflow_new_tab"),
      },
    });
    overlayOpenWorkflow.innerHTML = '<i class="pi pi-external-link"></i>';
    const overlayReplaceWorkflow = createElement("button", {
      className: "assets-plus-icon-button workflow-replace",
      attrs: {
        title: t("actions.replace_workflow"),
        "aria-label": t("actions.replace_workflow"),
      },
    });
    overlayReplaceWorkflow.innerHTML = '<i class="pi pi-arrow-right-arrow-left"></i>';
    const overlayClose = createElement("button", {
      className: "assets-plus-overlay-close",
      text: "×",
      attrs: { "aria-label": t("overlay.close") },
    });
    overlayTopActions.appendChild(overlayDownload);
    overlayTopActions.appendChild(overlayOpenWorkflow);
    overlayTopActions.appendChild(overlayReplaceWorkflow);
    overlayTop.appendChild(overlayInfo);
    overlayTop.appendChild(overlayTopActions);
    overlayTop.appendChild(overlayClose);

    const overlayBody = createElement("div", { className: "assets-plus-overlay-body" });
    const overlayPrev = createElement("button", {
      className: "assets-plus-overlay-nav",
      text: "‹",
      attrs: { "aria-label": t("overlay.previous") },
    });
    const overlayNext = createElement("button", {
      className: "assets-plus-overlay-nav",
      text: "›",
      attrs: { "aria-label": t("overlay.next") },
    });
    const overlayMedia = createElement("div", { className: "assets-plus-overlay-media" });
    const overlayImage = createElement("img", {
      className: "assets-plus-overlay-image",
      attrs: { draggable: "false" },
    });
    const overlayVideo = createElement("video", {
      className: "assets-plus-overlay-video",
      attrs: { controls: "true" },
    });
    overlayMedia.appendChild(overlayImage);
    overlayMedia.appendChild(overlayVideo);
    overlayBody.appendChild(overlayPrev);
    overlayBody.appendChild(overlayMedia);
    overlayBody.appendChild(overlayNext);

    const overlayReset = createElement("button", {
      className: "assets-plus-overlay-reset",
      text: t("overlay.reset_zoom"),
    });

    overlay.appendChild(overlayTop);
    overlay.appendChild(overlayBody);
    overlay.appendChild(overlayReset);

    const overlayHint = createElement("div", { className: "assets-plus-overlay-hint" });
    const hintUp = createElement("button", {
      className: "assets-plus-hint-button",
      attrs: { "data-action": "first", title: t("overlay.hint.first") },
    });
    const hintUpKey = createElement("span", { className: "assets-plus-hint-key" });
    const hintUpIcon = createElement("i", { className: "pi pi-angle-double-up" });
    hintUp.appendChild(hintUpKey);
    hintUp.appendChild(hintUpIcon);
    const hintLeft = createElement("button", {
      className: "assets-plus-hint-button",
      attrs: { "data-action": "prev", title: t("overlay.hint.previous") },
    });
    const hintLeftKey = createElement("span", { className: "assets-plus-hint-key" });
    const hintLeftIcon = createElement("i", { className: "pi pi-angle-left" });
    hintLeft.appendChild(hintLeftKey);
    hintLeft.appendChild(hintLeftIcon);
    const hintDown = createElement("button", {
      className: "assets-plus-hint-button",
      attrs: { "data-action": "last", title: t("overlay.hint.last") },
    });
    const hintDownKey = createElement("span", { className: "assets-plus-hint-key" });
    const hintDownIcon = createElement("i", { className: "pi pi-angle-double-down" });
    hintDown.appendChild(hintDownKey);
    hintDown.appendChild(hintDownIcon);
    const hintRight = createElement("button", {
      className: "assets-plus-hint-button",
      attrs: { "data-action": "next", title: t("overlay.hint.next") },
    });
    const hintRightKey = createElement("span", { className: "assets-plus-hint-key" });
    const hintRightIcon = createElement("i", { className: "pi pi-angle-right" });
    hintRight.appendChild(hintRightKey);
    hintRight.appendChild(hintRightIcon);
    const hintDelete = createElement("button", {
      className: "assets-plus-hint-button danger",
      attrs: { "data-action": "delete", title: t("actions.delete") },
    });
    const hintDeleteKey = createElement("span", { className: "assets-plus-hint-key" });
    const hintDeleteIcon = createElement("i", { className: "pi pi-trash" });
    hintDelete.appendChild(hintDeleteKey);
    hintDelete.appendChild(hintDeleteIcon);
    overlayHint.appendChild(createElement("span"));
    overlayHint.appendChild(hintUp);
    overlayHint.appendChild(createElement("span"));
    overlayHint.appendChild(hintLeft);
    overlayHint.appendChild(hintDown);
    overlayHint.appendChild(hintRight);
    overlayHint.appendChild(createElement("span"));
    overlayHint.appendChild(hintDelete);
    overlayHint.appendChild(createElement("span"));

    overlay.appendChild(overlayHint);

    this.container.appendChild(createStyleTag());
    this.container.appendChild(root);
    this.container.appendChild(overlay);
    document.body.appendChild(contextMenu);

    this.elements = {
      root,
      title,
      outputTab,
      inputTab,
      refreshButton,
      searchToggle,
      selectAllButton,
      invertSelectionButton,
      searchInput,
      status,
      grid,
      body,
      contextMenu,
      contextMenuOpen,
      contextMenuReplace,
      actionsBar,
      downloadButton,
      deleteButton,
      overlay,
      overlayInfo,
      overlayClose,
      overlayTopActions,
      overlayPrev,
      overlayNext,
      overlayMedia,
      overlayImage,
      overlayVideo,
      overlayDownload,
      overlayOpenWorkflow,
      overlayReplaceWorkflow,
      overlayReset,
      overlayHint,
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
    };

    this.scrollHandler = () => this.handleScroll();
    body.addEventListener("scroll", this.scrollHandler);
    this.setupThumbObserver();

    this.updateSearchVisibility();

    refreshButton.addEventListener("click", () => this.refreshList());
    outputTab.addEventListener("click", () => this.setTab(OUTPUT_TAB));
    inputTab.addEventListener("click", () => this.setTab(INPUT_TAB));
    searchToggle.addEventListener("click", () => this.toggleSearchVisibility());
    selectAllButton.addEventListener("click", () => this.selectAllFiltered());
    invertSelectionButton.addEventListener("click", () => this.invertSelection());
    searchInput.addEventListener("input", (event) => {
      this.handleSearchInput(event.target.value);
    });

    downloadButton.addEventListener("click", () => this.handleDownload());
    deleteButton.addEventListener("click", () => this.handleDelete());
    document.addEventListener("click", this.documentClickHandler);
    contextMenuOpen.addEventListener("click", (event) => {
      event.stopPropagation();
      this.handleContextMenuAction("open");
    });
    contextMenuReplace.addEventListener("click", (event) => {
      event.stopPropagation();
      this.handleContextMenuAction("replace");
    });

    overlayClose.addEventListener("click", () => this.closeOverlay());
    overlayPrev.addEventListener("click", () => this.navigateOverlay(-1));
    overlayNext.addEventListener("click", () => this.navigateOverlay(1));
    overlayDownload.addEventListener("click", () => this.handleDownload(this.getOverlayItem()));
    overlayOpenWorkflow.addEventListener("click", () =>
      this.openWorkflow(false, this.getOverlayItem(), { fromOverlay: true })
    );
    overlayReplaceWorkflow.addEventListener("click", () =>
      this.openWorkflow(true, this.getOverlayItem(), { fromOverlay: true })
    );
    overlayReset.addEventListener("click", () => this.resetOverlayZoom());
    overlayHint.addEventListener("click", (event) => this.handleOverlayHintClick(event));

    overlayMedia.addEventListener("wheel", (event) => this.handleOverlayZoom(event), {
      passive: false,
    });
    overlayMedia.addEventListener("dblclick", () => this.resetOverlayZoom());
    overlayImage.addEventListener("pointerdown", (event) => this.startOverlayPan(event));
    overlayImage.addEventListener("pointerup", () => this.stopOverlayPan());
    overlayImage.addEventListener("pointerleave", () => this.stopOverlayPan());
    overlay.addEventListener("click", (event) => this.handleOverlayBackgroundClick(event));

    this.loadConfig()
      .then(() => this.refreshList())
      .catch(() => this.refreshList());

    this.registerApiEvents();
  }

  updateTranslations() {
    const {
      title,
      outputTab,
      inputTab,
      refreshButton,
      searchToggle,
      selectAllButton,
      invertSelectionButton,
      searchInput,
      downloadButton,
      deleteButton,
      contextMenuOpen,
      contextMenuReplace,
      overlayClose,
      overlayPrev,
      overlayNext,
      overlayDownload,
      overlayOpenWorkflow,
      overlayReplaceWorkflow,
      overlayReset,
    } = this.elements;
    if (title) title.textContent = t("app.title");
    if (outputTab) outputTab.textContent = t("tabs.output");
    if (inputTab) inputTab.textContent = t("tabs.input");
    if (refreshButton) {
      refreshButton.setAttribute("title", t("actions.refresh"));
      refreshButton.setAttribute("aria-label", t("actions.refresh"));
    }
    if (searchToggle) {
      searchToggle.setAttribute("title", t("actions.search"));
      searchToggle.setAttribute("aria-label", t("actions.search"));
    }
    if (selectAllButton) {
      selectAllButton.setAttribute("title", t("actions.select_all"));
      selectAllButton.setAttribute("aria-label", t("actions.select_all"));
    }
    if (invertSelectionButton) {
      invertSelectionButton.setAttribute("title", t("actions.invert_selection"));
      invertSelectionButton.setAttribute("aria-label", t("actions.invert_selection"));
    }
    if (searchInput) searchInput.setAttribute("placeholder", t("search.placeholder"));
    if (downloadButton) {
      downloadButton.setAttribute("title", t("actions.download"));
      downloadButton.setAttribute("aria-label", t("actions.download"));
    }
    if (deleteButton) {
      deleteButton.setAttribute("title", t("actions.delete"));
      deleteButton.setAttribute("aria-label", t("actions.delete"));
    }
    if (contextMenuOpen) contextMenuOpen.textContent = t("actions.open_workflow_new_tab");
    if (contextMenuReplace) contextMenuReplace.textContent = t("actions.replace_workflow");
    if (overlayClose) overlayClose.setAttribute("aria-label", t("overlay.close"));
    if (overlayPrev) overlayPrev.setAttribute("aria-label", t("overlay.previous"));
    if (overlayNext) overlayNext.setAttribute("aria-label", t("overlay.next"));
    if (overlayDownload) {
      overlayDownload.setAttribute("title", t("actions.download"));
      overlayDownload.setAttribute("aria-label", t("actions.download"));
    }
    if (overlayOpenWorkflow) {
      overlayOpenWorkflow.setAttribute("title", t("actions.open_workflow_new_tab"));
      overlayOpenWorkflow.setAttribute("aria-label", t("actions.open_workflow_new_tab"));
    }
    if (overlayReplaceWorkflow) {
      overlayReplaceWorkflow.setAttribute("title", t("actions.replace_workflow"));
      overlayReplaceWorkflow.setAttribute("aria-label", t("actions.replace_workflow"));
    }
    if (overlayReset) overlayReset.textContent = t("overlay.reset_zoom");
    this.updateActionsBar();
    this.updateOverlayShortcutHints();
    this.updateOverlayHelpVisibility();
    this.renderGrid({ reset: true });
  }

  detachOverlayHandlers() {
    this.stopOverlayPan();
  }

  destroy() {
    this.unregisterApiEvents();
    this.disconnectThumbObserver();
    if (this.state.searchDebounceId) {
      window.clearTimeout(this.state.searchDebounceId);
      this.state.searchDebounceId = null;
    }
    if (this.scrollHandler && this.elements?.body) {
      this.elements.body.removeEventListener("scroll", this.scrollHandler);
    }
    this.detachOverlayHandlers();
    document.removeEventListener("click", this.documentClickHandler);
    if (this.elements?.contextMenu?.parentNode) {
      this.elements.contextMenu.parentNode.removeChild(this.elements.contextMenu);
    }
    if (this.container) {
      this.container.classList.remove("assets-plus-container");
    }
    if (this.sidebarContent && this.sidebarOverflowState) {
      this.sidebarContent.style.overflow = this.sidebarOverflowState.overflow;
      this.sidebarContent.style.overflowX = this.sidebarOverflowState.overflowX;
      this.sidebarContent.style.overflowY = this.sidebarOverflowState.overflowY;
    }
    this.container.innerHTML = "";
  }

  toast(options) {
    this.app?.extensionManager?.toast?.add?.(options);
  }

  getSetting(id, fallback) {
    const sources = [
      this.app?.settings?.get?.bind(this.app?.settings),
      this.app?.ui?.settings?.get?.bind(this.app?.ui?.settings),
      this.app?.extensionManager?.setting?.get?.bind(this.app?.extensionManager?.setting),
    ].filter(Boolean);
    for (const getter of sources) {
      const value = getter(id);
      if (value !== undefined && value !== null) {
        return value;
      }
    }
    return fallback;
  }

  getSettingsSnapshot() {
    const config = this.state.config || {};
    const scanDepthSetting = this.getSetting(SETTINGS.scanDepth, config.scan_depth ?? 0);
    const scanDepth = Number(scanDepthSetting) > 0 ? Number(scanDepthSetting) : null;
    const configThumbnailSize = Array.isArray(config.thumbnail_size)
      ? config.thumbnail_size[0]
      : config.thumbnail_size;
    const fallbackQuality = resolveThumbnailQuality(
      config.thumbnail_quality,
      configThumbnailSize
    );
    const thumbnailQuality = String(
      this.getSetting(SETTINGS.thumbnailQuality, fallbackQuality)
    );
    const thumbnailSize = resolveThumbnailSize(thumbnailQuality, configThumbnailSize);
    const listLimitRaw = Number(
      this.getSetting(SETTINGS.listLimit, config.list_limit ?? DEFAULT_LIST_LIMIT)
    );
    const listLimit =
      Number.isFinite(listLimitRaw) && listLimitRaw > 0 ? listLimitRaw : DEFAULT_LIST_LIMIT;
    return {
      listLimit,
      recursive: Boolean(this.getSetting(SETTINGS.recursive, config.recursive ?? true)),
      scanDepth,
      deleteMode: String(this.getSetting(SETTINGS.deleteMode, config.default_delete_mode ?? DEFAULT_DELETE_MODE)),
      confirmDelete: Boolean(
        this.getSetting(SETTINGS.confirmDelete, config.confirm_delete ?? DEFAULT_CONFIRM_DELETE)
      ),
      showOverlayHelp: Boolean(
        this.getSetting(SETTINGS.showOverlayHelp, DEFAULT_SHOW_OVERLAY_HELP)
      ),
      keepOverlayOpenOnWorkflow: Boolean(
        this.getSetting(
          SETTINGS.keepOverlayOpenOnWorkflow,
          DEFAULT_KEEP_OVERLAY_OPEN_ON_WORKFLOW
        )
      ),
      thumbnailSize,
      thumbnailQuality: resolveThumbnailQuality(thumbnailQuality, configThumbnailSize),
      extensions: (config.allowed_extensions || DEFAULT_EXTENSIONS).map((ext) =>
        ext.startsWith(".") ? ext.slice(1) : ext
      ),
    };
  }

  setStatus(message) {
    this.elements.status.textContent = message || "";
  }

  setTab(tab) {
    if (this.state.tab === tab) return;
    this.rememberScrollPosition();
    this.state.tab = tab;
    this.state.selected = new Set();
    this.state.scrollPositions[tab] = 0;
    this.closeOverlay();
    this.updateTabs();
    this.refreshList();
  }

  updateTabs() {
    const { outputTab, inputTab } = this.elements;
    outputTab.classList.toggle("active", this.state.tab === OUTPUT_TAB);
    inputTab.classList.toggle("active", this.state.tab === INPUT_TAB);
    this.updateActionsBar();
  }

  toggleSearchVisibility() {
    this.state.searchVisible = !this.state.searchVisible;
    this.updateSearchVisibility();
  }

  updateSearchVisibility() {
    const { searchInput } = this.elements;
    if (!searchInput) return;
    searchInput.classList.toggle("visible", this.state.searchVisible);
    if (this.state.searchVisible) {
      searchInput.focus();
    }
  }

  handleSearchInput(value) {
    this.state.search = value;
    if (this.state.searchDebounceId) {
      window.clearTimeout(this.state.searchDebounceId);
    }
    this.state.searchDebounceId = window.setTimeout(() => {
      this.state.searchDebounceId = null;
      this.refreshList();
    }, 250);
  }

  registerApiEvents() {
    this.unregisterApiEvents();
    if (!api?.addEventListener) return;
    const handleOutput = () => this.handlePossibleMutation(OUTPUT_TAB);
    const handleInput = () => this.handlePossibleMutation(INPUT_TAB);
    const outputEvents = [
      "executed",
      "execution_success",
      "execution_error",
      "execution_interrupted",
    ];
    outputEvents.forEach((eventName) => {
      api.addEventListener(eventName, handleOutput);
      this.apiEventHandlers.push({ eventName, handler: handleOutput });
    });
    const inputEvents = ["upload", "uploaded", "upload_complete"];
    inputEvents.forEach((eventName) => {
      api.addEventListener(eventName, handleInput);
      this.apiEventHandlers.push({ eventName, handler: handleInput });
    });
  }

  unregisterApiEvents() {
    if (!api?.removeEventListener) {
      this.apiEventHandlers = [];
      return;
    }
    this.apiEventHandlers.forEach(({ eventName, handler }) => {
      api.removeEventListener(eventName, handler);
    });
    this.apiEventHandlers = [];
  }

  handlePossibleMutation(tab) {
    if (!this.elements.root?.offsetParent) {
      this.state.pendingRefresh[tab] = true;
      return;
    }
    if (this.state.tab !== tab) {
      this.state.pendingRefresh[tab] = true;
      return;
    }
    this.refreshNewItems();
  }

  clearSelection() {
    this.state.selected = new Set();
  }

  getSelectedItems() {
    return this.state.items.filter((item) => this.state.selected.has(item.relpath));
  }

  getFilteredItems() {
    return this.state.items;
  }

  rememberScrollPosition() {
    const body = this.elements.body;
    if (!body) return;
    this.state.scrollPositions[this.state.tab] = body.scrollTop;
  }

  restoreScrollPosition() {
    const body = this.elements.body;
    if (!body) return;
    const target = this.state.scrollPositions[this.state.tab] ?? 0;
    const maxScroll = Math.max(0, body.scrollHeight - body.clientHeight);
    body.scrollTop = Math.min(target, maxScroll);
  }

  handleScroll() {
    if (this.state.scrollTicking) return;
    this.state.scrollTicking = true;
    window.requestAnimationFrame(() => {
      this.state.scrollTicking = false;
      this.maybeLoadNextPage();
    });
  }

  maybeLoadNextPage() {
    if (this.state.loading || this.state.loadingMore) return;
    if (!this.state.hasMore) return;
    const body = this.elements.body;
    if (!body) return;
    const threshold = 480;
    if (body.scrollTop + body.clientHeight >= body.scrollHeight - threshold) {
      this.loadNextPage();
    }
  }

  selectAllFiltered() {
    const filtered = this.getFilteredItems();
    if (!filtered.length) return;
    filtered.forEach((item) => this.state.selected.add(item.relpath));
    this.applySelectionStyles();
    this.updateActionsBar();
    if (this.state.overlay.relpath) {
      this.updateOverlayView();
    }
  }

  invertSelection() {
    const filtered = this.getFilteredItems();
    if (!filtered.length) return;
    filtered.forEach((item) => {
      if (this.state.selected.has(item.relpath)) {
        this.state.selected.delete(item.relpath);
      } else {
        this.state.selected.add(item.relpath);
      }
    });
    this.applySelectionStyles();
    this.updateActionsBar();
    if (this.state.overlay.relpath) {
      this.updateOverlayView();
    }
  }

  setSelected(relpath, isSelected) {
    if (isSelected) {
      this.state.selected.add(relpath);
    } else {
      this.state.selected.delete(relpath);
    }
    this.applySelectionStyles();
    this.updateActionsBar();
    if (this.state.overlay.relpath) {
      this.updateOverlayView();
    }
  }

  canDeleteCurrentTab() {
    return this.state.tab === OUTPUT_TAB || this.state.tab === INPUT_TAB;
  }

  getDeleteEndpoint() {
    if (!this.canDeleteCurrentTab()) {
      return null;
    }
    return `/assets_plus/${this.state.tab}/delete`;
  }

  updateActionsBar() {
    const selectionCount = this.state.selected.size;
    const { downloadButton, deleteButton, selectAllButton } = this.elements;
    const hasSelection = selectionCount > 0;
    const filteredCount = this.getFilteredItems().length;
    const allSelected = filteredCount > 0 && selectionCount >= filteredCount;
    if (selectAllButton) {
      selectAllButton.style.display = allSelected ? "none" : "inline-flex";
    }
    if (downloadButton) {
      downloadButton.style.display = hasSelection ? "inline-flex" : "none";
    }
    if (deleteButton) {
      deleteButton.style.display =
        hasSelection && this.canDeleteCurrentTab() ? "inline-flex" : "none";
    }
    this.updateSearchVisibility();
  }

  applySelectionStyles() {
    this.elements.grid.querySelectorAll(".assets-plus-card").forEach((card) => {
      const relpath = card.getAttribute("data-relpath");
      const isSelected = this.state.selected.has(relpath);
      card.classList.toggle("selected", isSelected);
      const checkbox = card.querySelector(".assets-plus-checkbox");
      if (checkbox) checkbox.checked = isSelected;
    });
  }

  handleDocumentClick(event) {
    if (event.target.closest(".assets-plus-context-menu")) return;
    if (event.target.closest(".assets-plus-card-menu-button")) return;
    this.closeContextMenu();
  }

  closeContextMenu() {
    const { contextMenu } = this.elements;
    if (!contextMenu) return;
    contextMenu.classList.remove("open");
    this.state.contextMenu.open = false;
    this.state.contextMenu.relpath = null;
  }

  positionContextMenu(button) {
    const { contextMenu } = this.elements;
    if (!contextMenu || !button) return;
    contextMenu.style.visibility = "hidden";
    contextMenu.classList.add("open");
    contextMenu.style.left = "0px";
    contextMenu.style.top = "0px";
    const menuRect = contextMenu.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    const padding = 8;
    let left = buttonRect.right + 6;
    let top = buttonRect.bottom + 6;
    if (left + menuRect.width > window.innerWidth - padding) {
      left = Math.max(padding, buttonRect.left - menuRect.width - 6);
    }
    if (top + menuRect.height > window.innerHeight - padding) {
      top = Math.max(padding, buttonRect.top - menuRect.height - 6);
    }
    contextMenu.style.left = `${left}px`;
    contextMenu.style.top = `${top}px`;
    contextMenu.style.visibility = "";
  }

  toggleContextMenu(item, button) {
    if (!item || !button) return;
    const { relpath, open } = this.state.contextMenu;
    if (open && relpath === item.relpath) {
      this.closeContextMenu();
      return;
    }
    this.state.contextMenu.relpath = item.relpath;
    this.state.contextMenu.open = true;
    this.positionContextMenu(button);
  }

  handleContextMenuAction(action) {
    const targetRelpath = this.state.contextMenu.relpath;
    if (!targetRelpath) return;
    const item = this.state.items.find((entry) => entry.relpath === targetRelpath);
    if (!item) {
      this.closeContextMenu();
      return;
    }
    this.closeContextMenu();
    if (action === "replace") {
      this.openWorkflow(true, item);
      return;
    }
    this.openWorkflow(false, item);
  }

  restoreContextMenu() {
    if (!this.state.contextMenu.open || !this.state.contextMenu.relpath) return;
    const relpath = this.state.contextMenu.relpath;
    const safeRelpath =
      typeof CSS !== "undefined" && CSS.escape
        ? CSS.escape(relpath)
        : relpath.replace(/["\\]/g, "\\$&");
    const card = this.elements.grid?.querySelector(`[data-relpath="${safeRelpath}"]`);
    const button = card?.querySelector(".assets-plus-card-menu-button");
    if (!button) {
      this.closeContextMenu();
      return;
    }
    this.positionContextMenu(button);
  }

  setupThumbObserver() {
    if (this.thumbObserver) {
      this.thumbObserver.disconnect();
    }
    if (typeof IntersectionObserver === "undefined") {
      this.thumbObserver = null;
      return;
    }
    const root = this.elements.body || null;
    this.thumbObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          const media = entry.target;
          const src = media.dataset.src;
          if (src) {
            media.src = src;
            if (media.tagName === "VIDEO") {
              media.load?.();
            }
          }
          this.thumbObserver?.unobserve(media);
        });
      },
      {
        root,
        rootMargin: "300px 0px",
        threshold: 0.01,
      }
    );
  }

  disconnectThumbObserver() {
    if (!this.thumbObserver) return;
    this.thumbObserver.disconnect();
    this.thumbObserver = null;
  }

  observeMedia(media, src) {
    if (!media || !src) return;
    if (!this.thumbObserver) {
      media.src = src;
      if (media.tagName === "VIDEO") {
        media.load?.();
      }
      return;
    }
    media.dataset.src = src;
    this.thumbObserver.observe(media);
  }

  buildCard(item, thumbnailSize) {
    const card = createElement("div", { className: "assets-plus-card" });
    card.setAttribute("data-relpath", item.relpath);

    const checkbox = createElement("input", {
      className: "assets-plus-checkbox",
      attrs: { type: "checkbox", "aria-label": t("selection.checkbox_label") },
    });
    const isSelected = this.state.selected.has(item.relpath);
    checkbox.checked = isSelected;
    card.classList.toggle("selected", isSelected);

    const thumb = createElement("div", { className: "assets-plus-thumb" });
    const thumbUrl = buildThumbUrl(item.relpath, this.state.tab, thumbnailSize);
    if (item.type === "video") {
      const video = document.createElement("video");
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      video.preload = "none";
      this.observeMedia(video, thumbUrl);
      thumb.appendChild(video);
    } else {
      const image = document.createElement("img");
      image.alt = item.filename;
      image.loading = "lazy";
      image.decoding = "async";
      this.observeMedia(image, thumbUrl);
      thumb.appendChild(image);
    }

    card.appendChild(checkbox);
    card.appendChild(thumb);
    const hasWorkflow = item.has_workflow && item.type === "image";
    if (hasWorkflow) {
      const menu = createElement("div", { className: "assets-plus-card-menu" });
      const menuButton = createElement("button", {
        className: "assets-plus-card-menu-button",
        attrs: { title: t("actions.workflow_menu"), "aria-label": t("actions.workflow_menu") },
      });
      menuButton.innerHTML = '<i class="pi pi-bars"></i>';
      menu.appendChild(menuButton);
      card.appendChild(menu);

      menuButton.addEventListener("click", (event) => {
        event.stopPropagation();
        this.toggleContextMenu(item, menuButton);
      });
    }

    checkbox.addEventListener("change", (event) => {
      this.setSelected(item.relpath, event.target.checked);
    });

    card.addEventListener("click", (event) => {
      if (event.target.closest(".assets-plus-checkbox")) {
        return;
      }
      if (event.target.closest(".assets-plus-card-menu")) {
        return;
      }
      this.closeContextMenu();
      this.openOverlay(item.relpath);
    });

    return card;
  }

  appendItemsToGrid(items) {
    if (!items.length) return;
    const { thumbnailSize } = this.getSettingsSnapshot();
    const fragment = document.createDocumentFragment();
    items.forEach((item) => {
      fragment.appendChild(this.buildCard(item, thumbnailSize));
    });
    this.elements.grid.appendChild(fragment);
    this.updateActionsBar();
    this.restoreContextMenu();
  }

  renderGrid({ reset = false } = {}) {
    const grid = this.elements.grid;
    const filtered = this.getFilteredItems();
    if (reset) {
      this.rememberScrollPosition();
      grid.innerHTML = "";
      this.setupThumbObserver();
    }

    if (this.state.loading && !filtered.length) {
      this.setStatus(t("status.loading"));
    } else if (this.state.error) {
      this.setStatus(this.state.error);
    } else if (!filtered.length) {
      this.setStatus(t("status.empty"));
    } else if (this.state.loadingMore) {
      this.setStatus(t("status.loading_more"));
    } else {
      this.setStatus("");
    }

    if (reset) {
      this.appendItemsToGrid(filtered);
      this.applySelectionStyles();
      this.updateActionsBar();
      this.restoreContextMenu();
      this.restoreScrollPosition();
    }
  }

  async loadConfig() {
    try {
      this.state.config = await fetchJson("/assets_plus/config");
    } catch (error) {
      warn(t("log.config_load_failed"), error);
    }
  }

  buildListParams({ cursor = "", since = null } = {}) {
    const settings = this.getSettingsSnapshot();
    const params = new URLSearchParams();
    params.set("limit", String(settings.listLimit));
    if (settings.extensions?.length) params.set("extensions", settings.extensions.join(","));
    if (settings.scanDepth !== null && settings.scanDepth !== undefined) {
      params.set("scan_depth", String(settings.scanDepth));
    } else if (settings.recursive === false) {
      params.set("recursive", "0");
    }
    const query = this.state.search.trim();
    if (query) {
      params.set("query", query);
    }
    if (cursor) {
      params.set("cursor", cursor);
    }
    if (since !== null && since !== undefined) {
      params.set("since", String(since));
    }
    return params;
  }

  updateLatestMtime(value) {
    if (!Number.isFinite(value)) return;
    this.state.latestMtime = Math.max(this.state.latestMtime || 0, value);
  }

  mergeNewItems(items) {
    if (!items.length) return;
    const map = new Map(this.state.items.map((item) => [item.relpath, item]));
    items.forEach((item) => map.set(item.relpath, item));
    const merged = Array.from(map.values());
    merged.sort((a, b) => (b.mtime - a.mtime) || a.relpath.localeCompare(b.relpath));
    this.state.items = merged;
    const available = new Set(merged.map((item) => item.relpath));
    this.state.selected = new Set(
      Array.from(this.state.selected).filter((relpath) => available.has(relpath))
    );
    this.renderGrid({ reset: true });
  }

  async loadPage({ reset = false } = {}) {
    const params = this.buildListParams({ cursor: reset ? "" : this.state.cursor });
    const payload = await fetchJson(`/assets_plus/${this.state.tab}/list?${params.toString()}`);
    const items = payload.items || [];
    if (reset) {
      this.state.items = items;
    } else {
      this.state.items = this.state.items.concat(items);
    }
    this.state.cursor = payload.cursor || this.state.cursor;
    this.state.hasMore = Boolean(payload.has_more);
    this.updateLatestMtime(payload.latest_mtime);
    if (reset) {
      this.renderGrid({ reset: true });
    } else {
      this.appendItemsToGrid(items);
      if (!items.length && !this.state.items.length) {
        this.renderGrid({ reset: true });
      } else if (this.state.loadingMore) {
        this.setStatus(t("status.loading_more"));
      } else {
        this.setStatus("");
      }
    }
  }

  async refreshList() {
    this.state.loading = true;
    this.state.loadingMore = false;
    this.state.error = null;
    this.state.cursor = "";
    this.state.hasMore = true;
    this.state.latestMtime = 0;
    this.state.items = [];
    this.state.pendingRefresh[this.state.tab] = false;
    this.clearSelection();
    this.renderGrid({ reset: true });
    try {
      await this.loadPage({ reset: true });
    } catch (error) {
      this.state.error = t("status.load_error");
      this.renderGrid({ reset: true });
    } finally {
      this.state.loading = false;
      this.renderGrid({ reset: true });
    }
  }

  async loadNextPage() {
    if (!this.state.hasMore || this.state.loadingMore || this.state.loading) return;
    this.state.loadingMore = true;
    this.renderGrid();
    try {
      await this.loadPage();
    } catch (error) {
      this.state.error = t("status.load_error");
    } finally {
      this.state.loadingMore = false;
      this.renderGrid();
    }
  }

  async refreshNewItems() {
    if (this.state.loading) return;
    const since = this.state.latestMtime || null;
    const params = this.buildListParams({ since });
    try {
      const payload = await fetchJson(`/assets_plus/${this.state.tab}/list?${params.toString()}`);
      const items = payload.items || [];
      if (items.length) {
        this.mergeNewItems(items);
      }
      this.updateLatestMtime(payload.latest_mtime);
    } catch (error) {
      warn(t("log.refresh_failed"), error);
    }
  }

  handleDownload(targetItem) {
    const items = targetItem ? [targetItem] : this.getSelectedItems();
    if (!items.length) return;
    items.forEach((item) => {
      const url = buildViewUrl(item.relpath, this.state.tab);
      const link = document.createElement("a");
      link.href = url;
      link.download = item.filename;
      link.rel = "noopener";
      link.target = "_blank";
      document.body.appendChild(link);
      link.click();
      link.remove();
    });
  }

  async handleDelete(targetItem) {
    const items = targetItem ? [targetItem] : this.getSelectedItems();
    if (!items.length) return;
    const settings = this.getSettingsSnapshot();
    const mode = settings.deleteMode;
    const message =
      mode === "hide"
        ? t("confirm.delete.hide_message")
        : t("confirm.delete.delete_message");
    if (settings.confirmDelete) {
      const dialogService = this.app?.extensionManager?.dialog;
      let confirmed = false;
      if (dialogService?.confirm) {
        confirmed =
          (await dialogService.confirm({
            title: t("confirm.delete.title"),
            message,
            type: mode === "hide" ? "default" : "delete",
            itemList: items.map((asset) => asset.filename),
          })) === true;
      } else {
        confirmed = window.confirm(message);
      }
      if (!confirmed) return;
    }

    const overlayRelpath = this.state.overlay.relpath;
    const deleteRelpaths = items.map((item) => item.relpath);
    const deleteEndpoint = this.getDeleteEndpoint();
    if (!deleteEndpoint) return;
    let nextOverlayRelpath = null;
    if (overlayRelpath && deleteRelpaths.includes(overlayRelpath)) {
      const filtered = this.getFilteredItems();
      const index = filtered.findIndex((entry) => entry.relpath === overlayRelpath);
      if (index !== -1) {
        for (let i = index + 1; i < filtered.length; i += 1) {
          if (!deleteRelpaths.includes(filtered[i].relpath)) {
            nextOverlayRelpath = filtered[i].relpath;
            break;
          }
        }
        if (!nextOverlayRelpath) {
          for (let i = index - 1; i >= 0; i -= 1) {
            if (!deleteRelpaths.includes(filtered[i].relpath)) {
              nextOverlayRelpath = filtered[i].relpath;
              break;
            }
          }
        }
      }
    }

    try {
      await fetchJson(deleteEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ relpaths: deleteRelpaths, mode }),
      });
      const deleteSet = new Set(deleteRelpaths);
      this.state.items = this.state.items.filter((item) => !deleteSet.has(item.relpath));
      deleteRelpaths.forEach((relpath) => this.state.selected.delete(relpath));
      this.state.latestMtime = this.state.items[0]?.mtime ?? 0;
      if (overlayRelpath && deleteRelpaths.includes(overlayRelpath)) {
        this.state.overlay.relpath = nextOverlayRelpath;
        if (!nextOverlayRelpath) {
          this.closeOverlay();
        }
      }
      this.renderGrid({ reset: true });
      if (
        nextOverlayRelpath &&
        this.state.items.some((item) => item.relpath === nextOverlayRelpath)
      ) {
        this.state.overlay.relpath = nextOverlayRelpath;
        this.updateOverlayView();
      }
    } catch (error) {
      this.toast({
        severity: "error",
        summary: t("toast.summary"),
        detail: t("toast.delete_failed"),
        life: 3000,
      });
    }
  }

  async extractWorkflow(asset) {
    const payload = await fetchJson(
      `/assets_plus/${this.state.tab}/meta?relpath=${encodeURIComponent(asset.relpath)}`
    );
    const metadata = payload?.metadata ?? {};
    const workflowRaw = metadata.workflow ?? null;
    const workflow = normalizeWorkflow(workflowRaw);
    return {
      workflow,
      workflowRaw,
      filename: workflowFilenameForAsset(asset.filename),
    };
  }

  async openWorkflow(replaceCurrent, targetItem = null, options = {}) {
    const items = targetItem ? [targetItem] : this.getSelectedItems();
    if (items.length !== 1) return;
    try {
      const { workflow, workflowRaw, filename } = await this.extractWorkflow(items[0]);
      if (!workflow) {
        this.toast({
          severity: "warn",
          summary: t("toast.summary"),
          detail: t("toast.workflow_missing"),
          life: 2500,
        });
        return;
      }
      if (replaceCurrent) {
        const workflowStore = resolveWorkflowStore(this.app);
        const activeWorkflow = workflowStore?.activeWorkflow ?? null;
        await this.app?.loadGraphData?.(workflow, true, true, activeWorkflow);
        this.toast({
          severity: "success",
          summary: t("toast.summary"),
          detail: t("toast.workflow_replaced"),
          life: 2000,
        });
        this.maybeCloseOverlayAfterWorkflow(options);
        return;
      }
      const workflowStore = resolveWorkflowStore(this.app);
      if (workflowStore?.createTemporary && workflowStore?.openWorkflow) {
        const temp = workflowStore.createTemporary(filename);
        await workflowStore.openWorkflow(temp);
        if (this.app?.loadGraphData) {
          await this.app.loadGraphData(workflow, true, true, temp);
        }
        this.toast({
          severity: "success",
          summary: t("toast.summary"),
          detail: t("toast.workflow_opened"),
          life: 2000,
        });
        this.maybeCloseOverlayAfterWorkflow(options);
        return;
      }
      const workflowActions = resolveWorkflowActionsService(this.app);
      if (workflowActions?.openWorkflowAction) {
        const workflowPayload = workflowRaw ?? workflow;
        const result = await workflowActions.openWorkflowAction(workflowPayload, filename);
        if (!result?.success) {
          throw new Error(result?.error || "Failed to open workflow");
        }
        this.toast({
          severity: "success",
          summary: t("toast.summary"),
          detail: t("toast.workflow_opened"),
          life: 2000,
        });
        this.maybeCloseOverlayAfterWorkflow(options);
        return;
      }
      warn(t("log.workflow_actions_unavailable"));
    } catch (error) {
      warn(t("log.workflow_open_failed"), error);
      this.toast({
        severity: "error",
        summary: t("toast.summary"),
        detail: t("toast.workflow_open_failed"),
        life: 2500,
      });
    }
  }

  maybeCloseOverlayAfterWorkflow(options = {}) {
    if (!options.fromOverlay) return;
    const { keepOverlayOpenOnWorkflow } = this.getSettingsSnapshot();
    if (!keepOverlayOpenOnWorkflow) {
      this.closeOverlay();
    }
  }

  getOverlayItem() {
    if (!this.state.overlay.relpath) return null;
    return this.state.items.find((item) => item.relpath === this.state.overlay.relpath) || null;
  }

  openOverlay(relpath) {
    if (!relpath) return;
    const item = this.state.items.find((entry) => entry.relpath === relpath);
    if (!item) return;
    this.state.overlay.relpath = relpath;
    this.resetOverlayZoom();
    this.elements.overlay.classList.add("active");
    this.updateOverlayShortcutHints();
    this.updateOverlayView();
  }

  closeOverlay() {
    this.elements.overlay.classList.remove("active");
    this.state.overlay.relpath = null;
    this.resetOverlayZoom();
    this.stopOverlayPan();
    const { overlayVideo } = this.elements;
    overlayVideo.pause?.();
    overlayVideo.removeAttribute("src");
    overlayVideo.load?.();
  }

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
    this.resetOverlayZoom();
    this.updateOverlayView();
  }

  updateOverlayView() {
    const item = this.getOverlayItem();
    if (!item) {
      this.closeOverlay();
      return;
    }
    const { overlayInfo, overlayPrev, overlayNext, overlayImage, overlayVideo } = this.elements;
    const items = this.getFilteredItems();
    const index = items.findIndex((entry) => entry.relpath === item.relpath);
    overlayPrev.disabled = index <= 0;
    overlayNext.disabled = index === -1 || index >= items.length - 1;

    const extension = item.filename.split(".").pop()?.toUpperCase() || "";
    const dateLabel = new Date(item.mtime * 1000).toLocaleString();
    overlayInfo.textContent = `${item.filename} • ${extension} • ${dateLabel}`;

    const viewUrl = buildViewUrl(item.relpath, this.state.tab);
    if (item.type === "video") {
      overlayImage.style.display = "none";
      overlayVideo.style.display = "block";
      overlayVideo.src = viewUrl;
    } else {
      overlayVideo.style.display = "none";
      overlayVideo.pause?.();
      overlayVideo.removeAttribute("src");
      overlayVideo.load?.();
      overlayImage.style.display = "block";
      overlayImage.src = viewUrl;
    }
    this.updateOverlayActions(item);
    this.updateOverlayHelpVisibility();
    this.applyOverlayTransform();
  }

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
    if (target.closest(".assets-plus-overlay-image") || target.closest(".assets-plus-overlay-video")) {
      return;
    }
    this.closeOverlay();
  }

  handleOverlayHintClick(event) {
    const button = event.target.closest(".assets-plus-hint-button");
    if (!button) return;
    const action = button.getAttribute("data-action");
    this.handleOverlayCommand(action);
  }

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
  }

  getCommandKeybinding(commandId) {
    const commands = this.app?.extensionManager?.command?.commands || [];
    const command = commands.find((entry) => entry.id === commandId);
    return command?.keybinding ?? null;
  }

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
  }

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
  }

  updateOverlayHelpVisibility() {
    const { overlayHint, hintDelete } = this.elements;
    if (!overlayHint) return;
    const { showOverlayHelp } = this.getSettingsSnapshot();
    overlayHint.style.display = showOverlayHelp ? "grid" : "none";
    if (hintDelete) {
      hintDelete.disabled = !this.canDeleteCurrentTab();
    }
    this.updateOverlayShortcutHints();
  }

  updateOverlayActions(item) {
    const { overlayOpenWorkflow, overlayReplaceWorkflow } = this.elements;
    const hasWorkflow = item?.has_workflow && item?.type === "image";
    overlayOpenWorkflow.disabled = !hasWorkflow;
    overlayReplaceWorkflow.disabled = !hasWorkflow;
  }

  resetOverlayZoom() {
    this.state.overlay.zoom = 1;
    this.state.overlay.offsetX = 0;
    this.state.overlay.offsetY = 0;
    this.applyOverlayTransform();
    this.updateOverlayResetButton();
  }

  updateOverlayResetButton() {
    const isActive = Math.abs(this.state.overlay.zoom - 1) > 0.01;
    this.elements.overlayReset.classList.toggle("active", isActive);
  }

  applyOverlayTransform() {
    const { overlayImage } = this.elements;
    const item = this.getOverlayItem();
    if (!item || item.type !== "image") {
      overlayImage.style.transform = "";
      overlayImage.classList.remove("zoomable", "grabbing");
      return;
    }
    const { zoom, offsetX, offsetY } = this.state.overlay;
    overlayImage.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${zoom})`;
    overlayImage.classList.toggle("zoomable", zoom > 1);
  }

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
    const nextZoom = clamp(previousZoom * direction, 1, 6);
    const scaleChange = nextZoom / previousZoom;
    this.state.overlay.zoom = nextZoom;
    this.state.overlay.offsetX =
      (this.state.overlay.offsetX - cursorX) * scaleChange + cursorX;
    this.state.overlay.offsetY =
      (this.state.overlay.offsetY - cursorY) * scaleChange + cursorY;
    if (nextZoom === 1) {
      this.state.overlay.offsetX = 0;
      this.state.overlay.offsetY = 0;
    }
    this.applyOverlayTransform();
    this.updateOverlayResetButton();
  }

  startOverlayPan(event) {
    const item = this.getOverlayItem();
    if (!item || item.type !== "image") return;
    if (this.state.overlay.zoom <= 1) return;
    event.preventDefault();
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
    window.addEventListener("pointermove", this.overlayPanHandler);
    window.addEventListener("pointerup", () => this.stopOverlayPan(), { once: true });
  }

  stopOverlayPan() {
    if (this.overlayPanHandler) {
      window.removeEventListener("pointermove", this.overlayPanHandler);
      this.overlayPanHandler = null;
    }
    this.state.overlay.panning = false;
    if (this.elements.overlayImage) {
      this.elements.overlayImage.classList.remove("grabbing");
    }
  }
}

const registerSidebarTab = (appInstance) => {
  if (!appInstance?.extensionManager?.registerSidebarTab) {
    warn(t("log.register_sidebar_unavailable"));
    return;
  }

  appInstance.extensionManager.registerSidebarTab({
    id: SIDEBAR_TAB_ID,
    icon: "pi pi-folder-open",
    title: t("app.title"),
    tooltip: t("app.tooltip"),
    label: t("app.label"),
    type: "custom",
    render: (container) => {
      log(t("log.render_sidebar"));
      explorerInstance?.destroy?.();
      explorerInstance = new AssetsPlusExplorer(appInstance, container);
    },
    destroy: () => {
      explorerInstance?.destroy?.();
      explorerInstance = null;
    },
  });
};

const buildShortcutsPanelTab = (appInstance) => ({
  id: ASSETS_PLUS_SHORTCUTS_TAB_ID,
  title: t("shortcuts.assets_plus"),
  type: "custom",
  targetPanel: "shortcuts",
  render: (container) => {
    shortcutsPanelInstance?.destroy?.();
    shortcutsPanelInstance = new AssetsPlusShortcutsPanel(appInstance, container);
  },
  destroy: () => {
    shortcutsPanelInstance?.destroy?.();
    shortcutsPanelInstance = null;
  },
});

const boot = async () => {
  const appInstance = await waitForApp();
  if (!appInstance) {
    warn(t("log.app_wait_failed"));
    return;
  }

  const translationsList = await loadTranslationsList();
  const languageSetting = String(getSettingValue(appInstance, SETTINGS.language, DEFAULT_LANGUAGE));
  const selectedLanguage = languageSetting || DEFAULT_LANGUAGE;
  await applyLanguage(selectedLanguage, { force: true });
  const languageOptions = buildLanguageOptions(translationsList);
  const toast = (detail, severity = "info") => {
    appInstance?.extensionManager?.toast?.add?.({
      summary: t("toast.summary"),
      detail,
      severity,
    });
  };
  const handleClearThumbnails = async () => {
    try {
      await fetchJson("/assets_plus/thumb/clear", { method: "POST" });
      toast(t("toast.thumbnails_cleared"));
    } catch (error) {
      warn(t("log.clear_thumbnails_failed"), error);
      toast(t("toast.thumbnails_clear_failed"), "error");
    }
  };

  appInstance.registerExtension({
    name: EXTENSION_NAME,
    commands: buildOverlayCommands(),
    keybindings: OVERLAY_KEYBINDINGS,
    bottomPanelTabs: [buildShortcutsPanelTab(appInstance)],
    settings: buildSettingsSchema(t, languageOptions, (newValue) => {
      const nextLanguage = String(newValue || DEFAULT_LANGUAGE);
      if (nextLanguage === activeLanguage) return;
      applyLanguage(nextLanguage).catch((error) => {
        warn(t("log.translation_load_failed", { language: nextLanguage }), error);
      });
    }, handleClearThumbnails),
    setup(app) {
      registerSidebarTab(app);
    },
  });
};

boot();
