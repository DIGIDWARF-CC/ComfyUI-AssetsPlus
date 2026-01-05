import { app as importedApp } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const EXTENSION_NAME = "digidwarf.AssetsPlus";
const SIDEBAR_TAB_ID = "assets-plus-explorer";
const OUTPUT_TAB = "output";
const INPUT_TAB = "input";

const DEFAULT_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "mp4", "webm"];
const DEFAULT_POLL_SECONDS = 5;
const DEFAULT_LIST_LIMIT = 200;
const DEFAULT_THUMB_SIZE = 256;
const DEFAULT_DELETE_MODE = "trash";
const DEFAULT_LANGUAGE = "en";
const SETTINGS_CATEGORY = "Assets+";

const SETTINGS = {
  pollSeconds: "AssetsPlus.PollSeconds",
  listLimit: "AssetsPlus.ListLimit",
  recursive: "AssetsPlus.RecursiveScan",
  scanDepth: "AssetsPlus.ScanDepth",
  deleteMode: "AssetsPlus.DeleteMode",
  thumbnailSize: "AssetsPlus.ThumbnailSize",
  language: "AssetsPlus.Language",
};

const applySettingsCategory = (setting, groupLabel) => ({
  ...setting,
  category: [SETTINGS_CATEGORY, groupLabel, setting.id],
});

const log = (...args) => console.log("[Assets+ Explorer]", ...args);
const warn = (...args) => console.warn("[Assets+ Explorer]", ...args);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const resolveApp = () => window.app || window.comfyApp || window.comfy?.app || importedApp;

let activeTranslations = {};
let fallbackTranslations = {};
let activeLanguage = DEFAULT_LANGUAGE;
let explorerInstance = null;

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
};

const buildSettingsSchema = (t, languageOptions, handleLanguageChange) => {
  const settingsGroup = t("settings.group");
  const withCategory = (setting) => applySettingsCategory(setting, settingsGroup);
  return [
    withCategory({
      id: SETTINGS.pollSeconds,
      name: t("settings.poll_seconds"),
      type: "number",
      defaultValue: DEFAULT_POLL_SECONDS,
      attrs: { min: 1, step: 1 },
    }),
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
      id: SETTINGS.thumbnailSize,
      name: t("settings.thumbnail_size"),
      type: "number",
      defaultValue: DEFAULT_THUMB_SIZE,
      attrs: { min: 64, step: 16 },
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
    .assets-plus-root {
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 12px;
      color: var(--fg-color, #e5e7eb);
      font-family: var(--font-family, sans-serif);
      --assets-plus-border: var(--border-color, #374151);
      --assets-plus-control-bg: var(--comfy-menu-secondary-bg, var(--comfy-menu-bg, #111827));
      --assets-plus-card-bg: var(--comfy-menu-bg, var(--bg-color, #0f172a));
      --assets-plus-input-bg: var(--comfy-input-bg, var(--comfy-menu-bg, #0f172a));
      --assets-plus-accent: var(--p-primary-color, #2563eb);
      --assets-plus-accent-contrast: var(--p-primary-contrast-color, #ffffff);
      --assets-plus-thumb-bg: var(--bg-color, #030712);
    }
    .assets-plus-header {
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
      background: var(--assets-plus-accent);
      border-color: var(--assets-plus-accent);
      color: var(--assets-plus-accent-contrast);
    }
    .assets-plus-button {
      border: 1px solid var(--assets-plus-border);
      background: var(--assets-plus-control-bg);
      color: inherit;
      padding: 6px 10px;
      border-radius: 6px;
      cursor: pointer;
    }
    .assets-plus-input {
      width: 100%;
      padding: 6px 8px;
      border-radius: 6px;
      border: 1px solid var(--assets-plus-border);
      background: var(--assets-plus-input-bg);
      color: inherit;
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
    }
    .assets-plus-card.selected {
      border-color: var(--assets-plus-accent);
      box-shadow: 0 0 0 1px var(--assets-plus-accent);
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
    .assets-plus-card-body {
      padding: 8px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .assets-plus-filename {
      font-size: 12px;
      font-weight: 600;
      word-break: break-all;
    }
    .assets-plus-subtitle {
      font-size: 11px;
      opacity: 0.7;
      word-break: break-all;
    }
    .assets-plus-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 999px;
      border: 1px solid var(--assets-plus-accent);
      color: var(--assets-plus-accent-contrast);
      background: var(--assets-plus-accent);
      width: fit-content;
    }
    .assets-plus-actions {
      border-top: 1px solid var(--assets-plus-border);
      padding-top: 8px;
      display: none;
      gap: 8px;
      flex-wrap: wrap;
      align-items: center;
    }
    .assets-plus-actions.active {
      display: flex;
    }
  `;
  return style;
};

class AssetsPlusExplorer {
  constructor(appInstance, container) {
    this.app = appInstance;
    this.container = container;
    this.state = {
      tab: OUTPUT_TAB,
      items: [],
      loading: false,
      error: null,
      search: "",
      selected: new Set(),
      config: null,
      pollId: null,
    };
    this.elements = {};
    this.init();
  }

  init() {
    this.container.innerHTML = "";
    const root = createElement("div", { className: "assets-plus-root" });
    const header = createElement("div", { className: "assets-plus-header" });

    const titleRow = createElement("div", { className: "assets-plus-title-row" });
    const title = createElement("div", { className: "assets-plus-title", text: t("app.title") });
    const refreshButton = createElement("button", {
      className: "assets-plus-button",
      text: t("actions.refresh"),
    });
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

    const searchInput = createElement("input", {
      className: "assets-plus-input",
      attrs: { placeholder: t("search.placeholder") },
    });

    header.appendChild(titleRow);
    header.appendChild(controls);
    header.appendChild(searchInput);

    const status = createElement("div", { className: "assets-plus-status" });
    const grid = createElement("div", { className: "assets-plus-grid" });

    const actionsBar = createElement("div", { className: "assets-plus-actions" });
    const selectionLabel = createElement("div", { className: "assets-plus-subtitle" });
    const downloadButton = createElement("button", {
      className: "assets-plus-button",
      text: t("actions.download"),
    });
    const deleteButton = createElement("button", {
      className: "assets-plus-button",
      text: t("actions.delete"),
    });
    const openWorkflowButton = createElement("button", {
      className: "assets-plus-button",
      text: t("actions.open_workflow_new_tab"),
    });
    const replaceWorkflowButton = createElement("button", {
      className: "assets-plus-button",
      text: t("actions.replace_workflow"),
    });

    actionsBar.appendChild(selectionLabel);
    actionsBar.appendChild(downloadButton);
    actionsBar.appendChild(deleteButton);
    actionsBar.appendChild(openWorkflowButton);
    actionsBar.appendChild(replaceWorkflowButton);

    root.appendChild(header);
    root.appendChild(status);
    root.appendChild(grid);
    root.appendChild(actionsBar);

    this.container.appendChild(createStyleTag());
    this.container.appendChild(root);

    this.elements = {
      root,
      title,
      outputTab,
      inputTab,
      refreshButton,
      searchInput,
      status,
      grid,
      actionsBar,
      selectionLabel,
      downloadButton,
      deleteButton,
      openWorkflowButton,
      replaceWorkflowButton,
    };

    refreshButton.addEventListener("click", () => this.refreshList());
    outputTab.addEventListener("click", () => this.setTab(OUTPUT_TAB));
    inputTab.addEventListener("click", () => this.setTab(INPUT_TAB));
    searchInput.addEventListener("input", (event) => {
      this.state.search = event.target.value;
      this.renderGrid();
    });

    downloadButton.addEventListener("click", () => this.handleDownload());
    deleteButton.addEventListener("click", () => this.handleDelete());
    openWorkflowButton.addEventListener("click", () => this.openWorkflow(false));
    replaceWorkflowButton.addEventListener("click", () => this.openWorkflow(true));

    this.loadConfig()
      .then(() => this.refreshList())
      .catch(() => this.refreshList());

    this.startPolling();
  }

  updateTranslations() {
    const {
      title,
      outputTab,
      inputTab,
      refreshButton,
      searchInput,
      downloadButton,
      deleteButton,
      openWorkflowButton,
      replaceWorkflowButton,
    } = this.elements;
    if (title) title.textContent = t("app.title");
    if (outputTab) outputTab.textContent = t("tabs.output");
    if (inputTab) inputTab.textContent = t("tabs.input");
    if (refreshButton) refreshButton.textContent = t("actions.refresh");
    if (searchInput) searchInput.setAttribute("placeholder", t("search.placeholder"));
    if (downloadButton) downloadButton.textContent = t("actions.download");
    if (deleteButton) deleteButton.textContent = t("actions.delete");
    if (openWorkflowButton) openWorkflowButton.textContent = t("actions.open_workflow_new_tab");
    if (replaceWorkflowButton) replaceWorkflowButton.textContent = t("actions.replace_workflow");
    this.updateActionsBar();
    this.renderGrid();
  }

  destroy() {
    this.stopPolling();
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
    const thumbnailSize = Number(
      this.getSetting(SETTINGS.thumbnailSize, (config.thumbnail_size || [DEFAULT_THUMB_SIZE])[0])
    );
    return {
      pollSeconds: Number(this.getSetting(SETTINGS.pollSeconds, config.poll_seconds ?? DEFAULT_POLL_SECONDS)),
      listLimit: Number(this.getSetting(SETTINGS.listLimit, config.list_limit ?? DEFAULT_LIST_LIMIT)),
      recursive: Boolean(this.getSetting(SETTINGS.recursive, config.recursive ?? true)),
      scanDepth,
      deleteMode: String(this.getSetting(SETTINGS.deleteMode, config.default_delete_mode ?? DEFAULT_DELETE_MODE)),
      thumbnailSize: Number.isFinite(thumbnailSize) ? thumbnailSize : DEFAULT_THUMB_SIZE,
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
    this.state.tab = tab;
    this.state.selected = new Set();
    this.updateTabs();
    this.refreshList();
    this.startPolling();
  }

  updateTabs() {
    const { outputTab, inputTab } = this.elements;
    outputTab.classList.toggle("active", this.state.tab === OUTPUT_TAB);
    inputTab.classList.toggle("active", this.state.tab === INPUT_TAB);
    this.updateActionsBar();
  }

  clearSelection() {
    this.state.selected = new Set();
  }

  getSelectedItems() {
    return this.state.items.filter((item) => this.state.selected.has(item.relpath));
  }

  updateActionsBar() {
    const selectionCount = this.state.selected.size;
    const { actionsBar, selectionLabel, deleteButton, openWorkflowButton, replaceWorkflowButton } =
      this.elements;
    actionsBar.classList.toggle("active", selectionCount > 0);
    selectionLabel.textContent = t("selection.label", { count: selectionCount });
    deleteButton.style.display = this.state.tab === OUTPUT_TAB ? "inline-flex" : "none";
    const singleSelection = selectionCount === 1;
    openWorkflowButton.style.display = singleSelection ? "inline-flex" : "none";
    replaceWorkflowButton.style.display = singleSelection ? "inline-flex" : "none";
  }

  applySelectionStyles() {
    this.elements.grid.querySelectorAll(".assets-plus-card").forEach((card) => {
      const relpath = card.getAttribute("data-relpath");
      card.classList.toggle("selected", this.state.selected.has(relpath));
    });
  }

  renderGrid() {
    const grid = this.elements.grid;
    grid.innerHTML = "";
    const filtered = this.state.items.filter((item) => {
      if (!this.state.search) return true;
      const haystack = `${item.filename} ${item.relpath}`.toLowerCase();
      return haystack.includes(this.state.search.toLowerCase());
    });

    if (this.state.loading) {
      this.setStatus(t("status.loading"));
    } else if (this.state.error) {
      this.setStatus(this.state.error);
    } else if (!filtered.length) {
      this.setStatus(t("status.empty"));
    } else {
      this.setStatus("");
    }

    if (!filtered.length) {
      this.updateActionsBar();
      return;
    }

    const { thumbnailSize } = this.getSettingsSnapshot();

    filtered.forEach((item) => {
      const card = createElement("div", { className: "assets-plus-card" });
      card.setAttribute("data-relpath", item.relpath);

      const thumb = createElement("div", { className: "assets-plus-thumb" });
      const thumbUrl = buildThumbUrl(item.relpath, this.state.tab, thumbnailSize);
      if (item.type === "video") {
        const video = document.createElement("video");
        video.src = thumbUrl;
        video.muted = true;
        video.loop = true;
        video.playsInline = true;
        video.preload = "metadata";
        thumb.appendChild(video);
      } else {
        const image = document.createElement("img");
        image.src = thumbUrl;
        image.alt = item.filename;
        thumb.appendChild(image);
      }

      const cardBody = createElement("div", { className: "assets-plus-card-body" });
      cardBody.appendChild(
        createElement("div", { className: "assets-plus-filename", text: item.filename })
      );
      cardBody.appendChild(
        createElement("div", { className: "assets-plus-subtitle", text: item.relpath })
      );
      if (item.has_workflow) {
        cardBody.appendChild(
          createElement("div", { className: "assets-plus-badge", text: t("badge.workflow") })
        );
      }

      card.appendChild(thumb);
      card.appendChild(cardBody);

      card.addEventListener("click", () => {
        if (this.state.selected.has(item.relpath)) {
          this.state.selected.delete(item.relpath);
        } else {
          this.state.selected.add(item.relpath);
        }
        this.applySelectionStyles();
        this.updateActionsBar();
      });

      grid.appendChild(card);
    });

    this.applySelectionStyles();
    this.updateActionsBar();
  }

  async loadConfig() {
    try {
      this.state.config = await fetchJson("/assets_plus/config");
    } catch (error) {
      warn(t("log.config_load_failed"), error);
    }
  }

  async refreshList() {
    this.state.loading = true;
    this.state.error = null;
    this.renderGrid();
    try {
      const settings = this.getSettingsSnapshot();
      const params = new URLSearchParams();
      params.set("limit", String(settings.listLimit));
      if (settings.extensions?.length) params.set("extensions", settings.extensions.join(","));
      if (settings.scanDepth !== null && settings.scanDepth !== undefined) {
        params.set("scan_depth", String(settings.scanDepth));
      } else if (settings.recursive === false) {
        params.set("recursive", "0");
      }
      const payload = await fetchJson(`/assets_plus/${this.state.tab}/list?${params.toString()}`);
      this.state.items = payload.items || [];
      this.clearSelection();
    } catch (error) {
      this.state.error = t("status.load_error");
    } finally {
      this.state.loading = false;
      this.renderGrid();
    }
  }

  async pollForUpdates() {
    if (this.state.tab !== OUTPUT_TAB) return;
    if (!this.elements.root?.offsetParent) return;
    try {
      const settings = this.getSettingsSnapshot();
      const params = new URLSearchParams();
      params.set("limit", String(settings.listLimit));
      if (settings.extensions?.length) params.set("extensions", settings.extensions.join(","));
      if (settings.scanDepth !== null && settings.scanDepth !== undefined) {
        params.set("scan_depth", String(settings.scanDepth));
      } else if (settings.recursive === false) {
        params.set("recursive", "0");
      }
      const payload = await fetchJson(`/assets_plus/${this.state.tab}/list?${params.toString()}`);
      this.state.items = payload.items || [];
      this.renderGrid();
    } catch (error) {
      warn(t("log.poll_failed"), error);
    }
  }

  startPolling() {
    this.stopPolling();
    if (this.state.tab !== OUTPUT_TAB) return;
    const { pollSeconds } = this.getSettingsSnapshot();
    if (!Number.isFinite(pollSeconds) || pollSeconds <= 0) return;
    this.state.pollId = window.setInterval(() => this.pollForUpdates(), pollSeconds * 1000);
  }

  stopPolling() {
    if (this.state.pollId) {
      window.clearInterval(this.state.pollId);
      this.state.pollId = null;
    }
  }

  handleDownload() {
    const selectedItems = this.getSelectedItems();
    if (!selectedItems.length) return;
    selectedItems.forEach((item) => {
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

  async handleDelete() {
    const selectedItems = this.getSelectedItems();
    if (!selectedItems.length) return;
    const settings = this.getSettingsSnapshot();
    const mode = settings.deleteMode;
    const message =
      mode === "hide"
        ? t("confirm.delete.hide_message")
        : t("confirm.delete.delete_message");
    const dialogService = this.app?.extensionManager?.dialog;
    let confirmed = false;
    if (dialogService?.confirm) {
      confirmed =
        (await dialogService.confirm({
          title: t("confirm.delete.title"),
          message,
          type: mode === "hide" ? "default" : "delete",
          itemList: selectedItems.map((asset) => asset.filename),
        })) === true;
    } else {
      confirmed = window.confirm(message);
    }
    if (!confirmed) return;

    try {
      await fetchJson("/assets_plus/output/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ relpaths: selectedItems.map((item) => item.relpath), mode }),
      });
      await this.refreshList();
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
    const workflow = normalizeWorkflow(metadata.workflow);
    return {
      workflow,
      filename: workflowFilenameForAsset(asset.filename),
    };
  }

  async openWorkflow(replaceCurrent) {
    const selectedItems = this.getSelectedItems();
    if (selectedItems.length !== 1) return;
    try {
      const { workflow, filename } = await this.extractWorkflow(selectedItems[0]);
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
        return;
      }
      const workflowActions = resolveWorkflowActionsService(this.app);
      if (workflowActions?.openWorkflowAction) {
        const result = await workflowActions.openWorkflowAction(workflow, filename);
        if (!result?.success) {
          throw new Error(result?.error || "Failed to open workflow");
        }
        this.toast({
          severity: "success",
          summary: t("toast.summary"),
          detail: t("toast.workflow_opened"),
          life: 2000,
        });
        return;
      }
      const workflowStore = resolveWorkflowStore(this.app);
      if (workflowStore?.createTemporary && workflowStore?.openWorkflow) {
        const temp = workflowStore.createTemporary(filename, workflow);
        await workflowStore.openWorkflow(temp);
        this.toast({
          severity: "success",
          summary: t("toast.summary"),
          detail: t("toast.workflow_opened"),
          life: 2000,
        });
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

  appInstance.registerExtension({
    name: EXTENSION_NAME,
    settings: buildSettingsSchema(t, languageOptions, (newValue) => {
      const nextLanguage = String(newValue || DEFAULT_LANGUAGE);
      if (nextLanguage === activeLanguage) return;
      applyLanguage(nextLanguage).catch((error) => {
        warn(t("log.translation_load_failed", { language: nextLanguage }), error);
      });
    }),
    setup(app) {
      registerSidebarTab(app);
    },
  });
};

boot();
