import { app as importedApp } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

import {
  OUTPUT_TAB, INPUT_TAB, SETTINGS,
  DEFAULT_LIST_LIMIT, DEFAULT_THUMB_QUALITY,
  DEFAULT_DELETE_MODE, DEFAULT_CONFIRM_DELETE,
  DEFAULT_CONFIRM_DELETE_STARRED, DEFAULT_STARRED_FIRST,
  DEFAULT_SHOW_OVERLAY_HELP, DEFAULT_KEEP_OVERLAY_OPEN_ON_WORKFLOW,
  THUMB_QUALITY_SIZES, VIDEO_THUMB_EXTENSIONS, DEFAULT_EXTENSIONS,
  VIEW_MODES, DEFAULT_VIEW_MODE, VIEW_MODE_STORAGE_KEY, DEFAULT_MESH_PREVIEW_MAX_MB
} from './constants.js';
import { createAudioControl } from './audio.js';
import { meshPreviews } from './meshpreview.js';
import { filtersAPI } from './filters.js';
import { groupOf } from './dategroups.js';
import {
  log, warn, sleep, clamp, resolveApp, fetchJson, buildViewUrl, itemVersion,
  buildThumbUrl, getFileExtension, normalizeWorkflow,
  workflowFilenameForAsset, resolveWorkflowStore,
  resolveWorkflowActionsService, resolveThumbnailQuality,
  resolveThumbnailSize, createElement, createStyleTag, getSettingValue
} from './utils.js';
import { t } from './i18n.js';
import { overlayAPI } from './overlay.js';

// Tiles are built when they come within this distance of the viewport and dropped beyond it.
const CARD_HYDRATE_MARGIN = "1500px 0px";
const THUMB_SETTLE_MS = 150;
const INITIAL_HYDRATED = 60;

// Corner badge icon per media type (images need none: the thumbnail says it all).
const CARD_KIND_ICONS = { video: "pi-video", audio: "pi-volume-up", mesh: "pi-box" };

// A music note for audio tiles (PrimeIcons has none): the "music_note" glyph of Google's Material Icons
// (Apache-2.0, see VENDORED.md).
const AUDIO_NOTE_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" ' +
  'd="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>';

const VIEW_MODE_ICONS = { list: "pi-list", small: "pi-th-large", large: "pi-objects-column" };

const loadViewMode = () => {
  try {
    const stored = window.localStorage?.getItem(VIEW_MODE_STORAGE_KEY);
    return VIEW_MODES.includes(stored) ? stored : DEFAULT_VIEW_MODE;
  } catch {
    return DEFAULT_VIEW_MODE;
  }
};

const formatBytes = (bytes) => {
  if (!Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 && unit > 0 ? 2 : value < 100 ? 1 : 0)} ${units[unit]}`;
};

const formatShortDate = (seconds) =>
  new Date(seconds * 1000).toLocaleString([], { dateStyle: "short", timeStyle: "short" });

export class AssetsPlusExplorer {
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
      viewMode: loadViewMode(),
      selected: new Set(),
      selectionMode: false,
      selectionAnchor: null,
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
        anchorKind: null,
      },
      overlay: {
        relpath: null,
        window: null,
        zoom: 1,
        fitZoom: 1,
        imageWidth: 0,
        imageHeight: 0,
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
    this.initFilterState();
    this.overlayPanHandler = null;
    this.overlayPanEndHandler = null;
    this.overlayImageLoadId = 0;
    this.documentClickHandler = (event) => this.handleDocumentClick(event);
    this.documentContextMenuHandler = (event) => this.handleDocumentContextMenu(event);
    this.overlayKeydownHandler = (event) => this.handleOverlayKeydown(event);
    this.thumbObserver = null;
    this.cardObserver = null;
    this.scrollHandler = null;
    this.listEpoch = 0;
    this.nextPagePromise = null;
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

    const controls = createElement("div", {
      className: "assets-plus-controls",
      attrs: { role: "tablist" },
    });
    const outputTab = createElement("button", {
      className: "assets-plus-tab active",
      text: t("tabs.output"),
      attrs: { role: "tab", "aria-selected": "true" },
    });
    const inputTab = createElement("button", {
      className: "assets-plus-tab",
      text: t("tabs.input"),
      attrs: { role: "tab", "aria-selected": "false" },
    });
    controls.appendChild(outputTab);
    controls.appendChild(inputTab);

    const actionsBar = createElement("div", { className: "assets-plus-actions" });
    const searchToggle = createElement("button", {
      className: "assets-plus-action-button",
      attrs: { title: t("actions.search"), "aria-label": t("actions.search") },
    });
    searchToggle.innerHTML = '<i class="pi pi-search"></i>';
    const viewButton = createElement("button", {
      className: "assets-plus-action-button assets-plus-view-button",
      attrs: { title: t("actions.view"), "aria-label": t("actions.view"), "aria-haspopup": "menu" },
    });
    viewButton.innerHTML = '<i class="pi pi-sliders-h"></i>';
    const filterButton = createElement("button", {
      className: "assets-plus-action-button assets-plus-filter-button",
      attrs: { title: t("actions.filter"), "aria-label": t("actions.filter"), "aria-haspopup": "menu" },
    });
    filterButton.innerHTML = '<i class="pi pi-filter"></i>';
    const dateButton = createElement("button", {
      className: "assets-plus-action-button assets-plus-date-button",
      attrs: { title: t("actions.dates"), "aria-label": t("actions.dates"), "aria-haspopup": "menu" },
    });
    dateButton.innerHTML = '<i class="pi pi-clock"></i>';
    const selectModeButton = createElement("button", {
      className: "assets-plus-action-button",
      attrs: {
        title: t("actions.selection_mode"),
        "aria-label": t("actions.selection_mode"),
        "aria-pressed": "false",
      },
    });
    selectModeButton.innerHTML = '<i class="pi pi-check-circle"></i>';
    const selectAllButton = createElement("button", {
      className: "assets-plus-action-button",
      attrs: { title: t("actions.select_all"), "aria-label": t("actions.select_all") },
    });
    const starSelectedButton = createElement("button", {
      className: "assets-plus-action-button",
      attrs: { title: t("actions.star_selected"), "aria-label": t("actions.star_selected") },
    });
    starSelectedButton.innerHTML = '<i class="pi pi-star"></i>';
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
    const moveButton = createElement("button", {
      className: "assets-plus-action-button",
      attrs: {
        title: t("actions.move_selected_to_input"),
        "aria-label": t("actions.move_selected_to_input"),
      },
    });
    moveButton.innerHTML = '<i class="pi pi-inbox"></i>';
    const deleteButton = createElement("button", {
      className: "assets-plus-action-button",
      attrs: { title: t("actions.delete_selected"), "aria-label": t("actions.delete_selected") },
    });
    deleteButton.innerHTML = '<i class="pi pi-trash"></i>';

    actionsBar.appendChild(searchToggle);
    actionsBar.appendChild(viewButton);
    actionsBar.appendChild(filterButton);
    actionsBar.appendChild(dateButton);
    actionsBar.appendChild(selectModeButton);
    actionsBar.appendChild(selectAllButton);
    actionsBar.appendChild(invertSelectionButton);
    actionsBar.appendChild(starSelectedButton);
    actionsBar.appendChild(downloadButton);
    actionsBar.appendChild(moveButton);
    actionsBar.appendChild(deleteButton);

    const searchInput = createElement("input", {
      className: "assets-plus-input assets-plus-search",
      attrs: { placeholder: t("search.placeholder") },
    });

    header.appendChild(titleRow);
    header.appendChild(controls);
    header.appendChild(actionsBar);
    const chips = createElement("div", { className: "assets-plus-chips" });
    chips.hidden = true;
    header.appendChild(chips);
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
    contextMenu.appendChild(contextMenuList);

    // View menu (list / small tiles / large tiles); lives in <body> like the tile menu.
    const viewMenu = createElement("div", { className: "assets-plus-context-menu assets-plus-view-menu" });
    viewMenu.addEventListener("contextmenu", (event) => event.preventDefault());
    const viewMenuList = createElement("div", { className: "assets-plus-context-menu-list" });
    viewMenu.appendChild(viewMenuList);

    const overlay = createElement("div", { className: "assets-plus-overlay" });
    const overlayTop = createElement("div", { className: "assets-plus-overlay-top" });
    const overlayInfo = createElement("div", { className: "assets-plus-overlay-info" });
    const overlayMeta = createElement("div", { className: "assets-plus-overlay-meta" });
    const overlayFormatBadge = createElement("span", { className: "assets-plus-overlay-badge" });
    const overlayDimensionsBadge = createElement("span", { className: "assets-plus-overlay-badge" });
    const overlayZoomBadge = createElement("span", { className: "assets-plus-overlay-badge" });
    overlayMeta.appendChild(overlayFormatBadge);
    overlayMeta.appendChild(overlayDimensionsBadge);
    overlayMeta.appendChild(overlayZoomBadge);
    const overlayTopActions = createElement("div", { className: "assets-plus-overlay-top-actions" });
    const overlayPrint = createElement("button", {
      className: "assets-plus-icon-button",
      attrs: { title: t("actions.print"), "aria-label": t("actions.print") },
    });
    overlayPrint.innerHTML = '<i class="pi pi-print"></i>';
    const overlayCopy = createElement("button", {
      className: "assets-plus-icon-button",
      attrs: { title: t("actions.copy_original"), "aria-label": t("actions.copy_original") },
    });
    overlayCopy.innerHTML = '<i class="pi pi-copy"></i>';
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
      text: "\u00D7",
      attrs: { "aria-label": t("overlay.close") },
    });
    const overlayStar = createElement("button", {
      className: "assets-plus-icon-button assets-plus-overlay-star",
    });
    this.applyStarState(overlayStar, false);
    const overlayMove = createElement("button", {
      className: "assets-plus-icon-button",
      attrs: { title: t("actions.move_to_input"), "aria-label": t("actions.move_to_input") },
    });
    overlayMove.innerHTML = '<i class="pi pi-inbox"></i>';
    overlayTopActions.appendChild(overlayStar);
    overlayTopActions.appendChild(overlayMove);
    overlayTopActions.appendChild(overlayPrint);
    overlayTopActions.appendChild(overlayCopy);
    overlayTopActions.appendChild(overlayDownload);
    overlayTopActions.appendChild(overlayOpenWorkflow);
    overlayTopActions.appendChild(overlayReplaceWorkflow);
    overlayTop.appendChild(overlayInfo);
    overlayTop.appendChild(overlayMeta);
    overlayTop.appendChild(overlayTopActions);
    overlayTop.appendChild(overlayClose);

    const overlayBody = createElement("div", { className: "assets-plus-overlay-body" });
    const overlayPrev = createElement("button", {
      className: "assets-plus-overlay-nav",
      text: "\u2039",
      attrs: { "aria-label": t("overlay.previous") },
    });
    const overlayNext = createElement("button", {
      className: "assets-plus-overlay-nav",
      text: "\u203A",
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
    const hintStar = createElement("button", {
      className: "assets-plus-hint-button",
      attrs: { "data-action": "star", title: t("actions.toggle_star") },
    });
    const hintStarKey = createElement("span", { className: "assets-plus-hint-key" });
    const hintStarIcon = createElement("i", { className: "pi pi-star" });
    hintStar.appendChild(hintStarKey);
    hintStar.appendChild(hintStarIcon);
    const hintMove = createElement("button", {
      className: "assets-plus-hint-button",
      attrs: { "data-action": "move", title: t("actions.move_to_input") },
    });
    const hintMoveKey = createElement("span", { className: "assets-plus-hint-key" });
    const hintMoveIcon = createElement("i", { className: "pi pi-inbox" });
    hintMove.appendChild(hintMoveKey);
    hintMove.appendChild(hintMoveIcon);
    overlayHint.appendChild(hintStar);
    overlayHint.appendChild(hintUp);
    overlayHint.appendChild(hintMove);
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
    document.body.appendChild(viewMenu);

    this.elements = {
      root,
      title,
      outputTab,
      inputTab,
      refreshButton,
      searchToggle,
      viewButton,
      filterButton,
      dateButton,
      chips,
      viewMenu,
      viewMenuList,
      selectModeButton,
      selectAllButton,
      invertSelectionButton,
      starSelectedButton,
      searchInput,
      status,
      grid,
      body,
      contextMenu,
      contextMenuList,
      actionsBar,
      downloadButton,
      moveButton,
      deleteButton,
      overlay,
      overlayInfo,
      overlayMeta,
      overlayFormatBadge,
      overlayDimensionsBadge,
      overlayZoomBadge,
      overlayClose,
      overlayTopActions,
      overlayPrev,
      overlayNext,
      overlayMedia,
      overlayImage,
      overlayVideo,
      overlayStar,
      overlayMove,
      overlayPrint,
      overlayCopy,
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
      hintStar,
      hintStarIcon,
      hintStarKey,
      hintMove,
      hintMoveKey,
      hintUpKey,
      hintLeftKey,
      hintDownKey,
      hintRightKey,
      hintDeleteKey,
    };

    this.scrollHandler = () => this.handleScroll();
    body.addEventListener("scroll", this.scrollHandler);
    this.bindGridEvents(this.elements.grid);
    this.setupThumbObserver();

    this.updateSearchVisibility();
    this.applyViewMode();
    this.initFilterUi();
    this.renderChips();
    viewButton.addEventListener("click", (event) => {
      event.stopPropagation();
      this.toggleViewMenu();
    });

    // The refresh button is the user saying "look again": bypass the server's folder snapshot.
    refreshButton.addEventListener("click", () => this.refreshList({ fresh: true }));
    outputTab.addEventListener("click", () => this.setTab(OUTPUT_TAB));
    inputTab.addEventListener("click", () => this.setTab(INPUT_TAB));
    searchToggle.addEventListener("click", () => this.toggleSearchVisibility());
    selectModeButton.addEventListener("click", () => this.setSelectionMode(!this.state.selectionMode));
    starSelectedButton.addEventListener("click", () => this.toggleStarSelected());
    selectAllButton.addEventListener("click", () => this.selectAllFiltered());
    invertSelectionButton.addEventListener("click", () => this.invertSelection());
    searchInput.addEventListener("input", (event) => {
      this.handleSearchInput(event.target.value);
    });

    downloadButton.addEventListener("click", () => this.handleDownload());
    moveButton.addEventListener("click", () => this.moveToImported(this.getSelectedItems()));
    deleteButton.addEventListener("click", () => this.handleDelete());
    document.addEventListener("click", this.documentClickHandler);
    document.addEventListener("contextmenu", this.documentContextMenuHandler);

    overlayClose.addEventListener("click", () => this.closeOverlay());
    overlayPrev.addEventListener("click", () => this.navigateOverlay(-1));
    overlayNext.addEventListener("click", () => this.navigateOverlay(1));
    overlayStar.addEventListener("click", () => {
      const item = this.getOverlayItem();
      if (item) this.setStarred([item], !item.starred);
    });
    overlayMove.addEventListener("click", () => {
      const item = this.getOverlayItem();
      if (item) this.moveToImported([item]);
    });
    overlayPrint.addEventListener("click", () => this.handlePrintOverlayImage());
    overlayCopy.addEventListener("click", () => this.handleCopyOriginalToClipboard());
    overlayDownload.addEventListener("click", () => this.handleDownload(this.getOverlayItem()));
    overlayOpenWorkflow.addEventListener("click", () =>
      this.openWorkflow(false, this.getOverlayItem(), { fromOverlay: true })
    );
    overlayReplaceWorkflow.addEventListener("click", () =>
      this.openWorkflow(true, this.getOverlayItem(), { fromOverlay: true })
    );
    overlayReset.addEventListener("click", () => this.setOverlayActualSize());
    overlayHint.addEventListener("click", (event) => this.handleOverlayHintClick(event));

    overlayMedia.addEventListener("wheel", (event) => this.handleOverlayZoom(event), {
      passive: false,
    });
    overlayMedia.addEventListener("dblclick", () => this.resetOverlayZoom());
    overlayImage.addEventListener("pointerdown", (event) => this.startOverlayPan(event));
    overlayImage.addEventListener("pointerup", () => this.stopOverlayPan());
    overlayImage.addEventListener("pointerleave", () => this.stopOverlayPan());
    overlay.addEventListener("click", (event) => this.handleOverlayBackgroundClick(event));
    document.addEventListener("keydown", this.overlayKeydownHandler);

    this.loadConfig()
      .then(() => this.refreshList())
      .catch(() => this.refreshList());

    this.registerApiEvents();
    // Intercept drops with our custom payload before ComfyUI's canvas handler.
    this._dragDropHandler = (event) => this.handleDragDrop(event);
    document.addEventListener("drop", this._dragDropHandler, true);
    // Accept dragover so the cursor shows "copy" even on loaded nodes.
    this._dragOverHandler = (event) => this.handleDragOver(event);
    document.addEventListener("dragover", this._dragOverHandler, true);
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
      overlayClose,
      overlayPrev,
      overlayNext,
      overlayPrint,
      overlayCopy,
      overlayDownload,
      overlayOpenWorkflow,
      overlayReplaceWorkflow,
      overlayReset,
    } = this.elements;
    if (this.state.overlay.relpath) this.updateOverlayActions(this.getOverlayItem());
    this.elements.grid?.querySelectorAll(".assets-plus-card-star").forEach((button) => {
      this.applyStarState(button, button.classList.contains("active"));
    });
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
    if (this.elements.viewButton) {
      this.elements.viewButton.setAttribute("title", t("actions.view"));
      this.elements.viewButton.setAttribute("aria-label", t("actions.view"));
    }
    if (this.elements.filterButton) {
      this.elements.filterButton.setAttribute("title", t("actions.filter"));
      this.elements.filterButton.setAttribute("aria-label", t("actions.filter"));
    }
    if (this.elements.dateButton) {
      this.elements.dateButton.setAttribute("title", t("actions.dates"));
      this.elements.dateButton.setAttribute("aria-label", t("actions.dates"));
    }
    this.renderChips();
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
      deleteButton.setAttribute("title", t("actions.delete_selected"));
      deleteButton.setAttribute("aria-label", t("actions.delete_selected"));
    }
    if (this.elements.moveButton) {
      this.elements.moveButton.setAttribute("title", t("actions.move_selected_to_input"));
      this.elements.moveButton.setAttribute("aria-label", t("actions.move_selected_to_input"));
    }
    if (this.elements.overlayMove) {
      this.elements.overlayMove.setAttribute("title", t("actions.move_to_input"));
      this.elements.overlayMove.setAttribute("aria-label", t("actions.move_to_input"));
    }
    if (this.elements.selectModeButton) {
      this.elements.selectModeButton.setAttribute("title", t("actions.selection_mode"));
      this.elements.selectModeButton.setAttribute("aria-label", t("actions.selection_mode"));
    }
    this.updateActionsBar();
    this.closeContextMenu();
    this.elements.grid?.querySelectorAll(".assets-plus-card-more, .assets-plus-card-download").forEach((button) => {
      const label = t(button.classList.contains("assets-plus-card-more") ? "actions.more" : "actions.download");
      button.setAttribute("title", label);
      button.setAttribute("aria-label", label);
    });
    if (overlayClose) overlayClose.setAttribute("aria-label", t("overlay.close"));
    if (overlayPrev) overlayPrev.setAttribute("aria-label", t("overlay.previous"));
    if (overlayNext) overlayNext.setAttribute("aria-label", t("overlay.next"));
    if (overlayPrint) {
      overlayPrint.setAttribute("title", t("actions.print"));
      overlayPrint.setAttribute("aria-label", t("actions.print"));
    }
    if (overlayCopy) {
      overlayCopy.setAttribute("title", t("actions.copy_original"));
      overlayCopy.setAttribute("aria-label", t("actions.copy_original"));
    }
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

  /** Accept dragover for our custom asset payload so the cursor shows "copy". */
  handleDragOver(event) {
    if (!event.dataTransfer?.types.includes("application/x-assetsplus-asset")) return;
    const canvas = this.app?.canvas;
    if (!canvas || typeof canvas.adjustMouseEvent !== "function") return;
    canvas.adjustMouseEvent(event);
    const node = canvas.graph?.getNodeOnPos(event.canvasX, event.canvasY);
    if (!node) return;
    const compat = ["LoadImage", "LoadImageMask", "LoadVideo", "LoadAudio"];
    if (!compat.includes(node.type)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    this.app.dragOverNode = node;
  }

  /** Intercept drops carrying our asset payload. */
  handleDragDrop(event) {
    const raw = event.dataTransfer?.getData("application/x-assetsplus-asset");
    if (!raw) return;
    event.preventDefault();
    event.stopPropagation();

    const canvas = this.app?.canvas;
    if (canvas && typeof canvas.adjustMouseEvent === "function") {
      canvas.adjustMouseEvent(event);
    }

    try {
      const asset = JSON.parse(raw);
      // There is no matching Load node for meshes; do not create a wrong (Load Image) one.
      if (asset.type === "mesh") return;

      // Check if there's an existing media node under the cursor \u2192 replace.
      const hitNode = canvas?.graph?.getNodeOnPos(
        event.canvasX ?? 0,
        event.canvasY ?? 0,
      );
      if (hitNode) {
        const nodeType =
          asset.type === "video" ? "LoadVideo" :
          asset.type === "audio" ? "LoadAudio" :
          "LoadImage";
        // If the target node type matches, set its file widget instead of creating.
        if (hitNode.type === nodeType) {
          this.setNodeWidgetValue(hitNode, asset);
          return;
        }
      }
      // Empty canvas or mismatched node \u2192 create a new node.
      this.createNodeForAsset(asset, event, canvas);
    } catch (err) {
      log("Failed to parse drag payload", err);
    }
  }

  /** Fetch the original file as a blob from ComfyUI's /view endpoint. */
  async fetchOriginalBlob(asset) {
    const viewUrl = buildViewUrl(asset.relpath, asset.tab);
    const absoluteUrl = new URL(viewUrl, window.location.origin).href;
    const resp = await fetch(absoluteUrl);
    if (!resp.ok) throw new Error(`/view returned ${resp.status}`);
    return resp.blob();
  }

  /**
   * Set the file on a node via its native pasteFile() method.
   * This is the same code path used by clipboard paste and OS file drop,
   * guaranteeing proper widget initialisation and clean validation.
   */
  async setNodeWidgetValue(node, asset) {
    const segments = asset.relpath.split("/");
    const filename = segments.pop();
    const subfolder = segments.join("/");
    // Files from the Imported tab live in the input folder: Load nodes address those by
    // the plain name, while generated files need the "[output]" annotation.
    const fileType = asset.tab === INPUT_TAB ? "input" : "output";
    const path = subfolder ? `${subfolder}/${filename}` : filename;
    const valueStr = fileType === "output" ? `${path} [output]` : path;
    const resultItem = { filename, subfolder, type: fileType };

    // Direct widget value set.
    const widgetNames = ["file", "image", "video", "audio"];
    for (const name of widgetNames) {
      const w = node.widgets?.find((x) => x.name === name);
      if (!w) continue;

      if (w.type === "combo") {
        let values = w.options?.values;
        if (typeof values === "function") {
          values = values(w);
          w.options.values = values;
        }
        if (Array.isArray(values) && !values.includes(valueStr)) {
          values.push(valueStr);
        }
        w.value = valueStr;
      } else if (w.type === "image") {
        w.value = resultItem;
      } else {
        w.value = valueStr;
      }
      if (typeof w.callback === "function") {
        try { w.callback(w.value); } catch (e) { }
      }
      break;
    }

    // Force the graph to re-validate so the red border disappears.
    const g = this.app?.graph;
    // Some node definitions have required input slots that won't be
    // connected when we create the node programmatically.  Walk the
    // inputs and force them into a "satisfied" state.
    if (node.inputs) {
      for (const inp of node.inputs) {
        if (inp.link != null) continue; // already connected
        // Mark unconnected required inputs as "linked to self" so the
        // validator doesn't flag them.
        if (inp.required) {
          inp.required = false;
        }
      }
    }
    if (g) {
      g.change();
      g.setDirtyCanvas(true, true);
    }
    // Clear any error state on the node.
    if (node.errors) node.errors.length = 0;
    if (node.flags) {
      node.flags.error = false;
      node.flags.has_errors = false;
    }
    // Force-clear the missing-media scanner's flag for our node.
    // The scanner runs asynchronously and may mark output-annotated
    // widget values as pending; we remove the node from the candidate
    // list immediately to hide the transient red border.
    setTimeout(() => {
      try {
        const pinia = document.querySelector("#vue-app")?.__vue_app__
          ?.config?.globalProperties?.$pinia;
        const store = pinia?.state?.value?.missingMedia;
        if (store?.missingMediaCandidates) {
          const nid = String(node.id);
          store.missingMediaCandidates = store.missingMediaCandidates.filter(
            (c) => String(c.nodeId) !== nid
          );
          if (!store.missingMediaCandidates.length) {
            store.missingMediaCandidates = null;
          }
        }
      } catch (_) {}
      this.app?.canvas?.setDirty(true, true);
    }, 100);
  }

  /**
   * Create a LoadImage / LoadVideo / LoadAudio node on the graph
   * and wire it to the original file in ComfyUI's output directory.
   */
  async createNodeForAsset(asset, event, canvas) {
    const nodeType =
      asset.type === "video" ? "LoadVideo" :
      asset.type === "audio" ? "LoadAudio" :
      "LoadImage";
    const node = LiteGraph.createNode(nodeType);
    if (!node) {
      warn("Failed to create node type:", nodeType);
      return;
    }
    if (canvas && event.canvasX !== undefined) {
      node.pos = [event.canvasX, event.canvasY];
    }
    // Patch onDragOver so the node accepts our asset type even when already loaded.
    if (!node._assetsPlusPatched) {
      node._assetsPlusPatched = true;
      const origOver = node.onDragOver;
      node.onDragOver = function (e) {
        if (e.dataTransfer?.types?.includes("application/x-assetsplus-asset")) return true;
        return origOver ? origOver.call(this, e) : false;
      };
    }
    this.app?.graph?.add(node);
    await this.setNodeWidgetValue(node, asset);
  }

  destroy() {
    document.removeEventListener("drop", this._dragDropHandler, true);
    document.removeEventListener("dragover", this._dragOverHandler, true);
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
    document.removeEventListener("keydown", this.overlayKeydownHandler);
    document.removeEventListener("click", this.documentClickHandler);
    document.removeEventListener("contextmenu", this.documentContextMenuHandler);
    if (this.elements?.contextMenu?.parentNode) {
      this.elements.contextMenu.parentNode.removeChild(this.elements.contextMenu);
    }
    if (this.elements?.viewMenu?.parentNode) {
      this.elements.viewMenu.parentNode.removeChild(this.elements.viewMenu);
    }
    this.destroyFilterUi();
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
    return getSettingValue(this.app, id, fallback);
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
      confirmDeleteStarred: Boolean(
        this.getSetting(SETTINGS.confirmDeleteStarred, DEFAULT_CONFIRM_DELETE_STARRED)
      ),
      starredFirst: Boolean(this.getSetting(SETTINGS.starredFirst, DEFAULT_STARRED_FIRST)),
      showOverlayHelp: Boolean(
        this.getSetting(SETTINGS.showOverlayHelp, DEFAULT_SHOW_OVERLAY_HELP)
      ),
      keepOverlayOpenOnWorkflow: Boolean(
        this.getSetting(
          SETTINGS.keepOverlayOpenOnWorkflow,
          DEFAULT_KEEP_OVERLAY_OPEN_ON_WORKFLOW
        )
      ),
      // Large tiles want the sharper preview, rows only show a small one.
      thumbnailSize:
        this.state.viewMode === "large" ? THUMB_QUALITY_SIZES.high : this.state.viewMode === "list" ? THUMB_QUALITY_SIZES.low : thumbnailSize,
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
    // Switching tabs also leaves selection mode.
    this.setSelectionMode(false);
    this.state.scrollPositions[tab] = 0;
    this.closeOverlay();
    this.updateTabs();
    this.refreshList();
  }

  updateTabs() {
    const { outputTab, inputTab } = this.elements;
    const outputActive = this.state.tab === OUTPUT_TAB;
    outputTab.classList.toggle("active", outputActive);
    inputTab.classList.toggle("active", !outputActive);
    outputTab.setAttribute("aria-selected", outputActive ? "true" : "false");
    inputTab.setAttribute("aria-selected", outputActive ? "false" : "true");
    this.updateActionsBar();
  }

  toggleSearchVisibility() {
    this.state.searchVisible = !this.state.searchVisible;
    this.updateSearchVisibility({ focus: true });
  }

  updateSearchVisibility({ focus = false } = {}) {
    const { searchInput } = this.elements;
    if (!searchInput) return;
    searchInput.classList.toggle("visible", this.state.searchVisible);
    // Only grab focus when the user opens the search box; this method also runs on every
    // grid update and must not steal focus from hotkeys (Q, X, arrows, ...).
    if (focus && this.state.searchVisible) {
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
    this.state.selectionAnchor = null;
    this.state.selectedGroups.clear();
    this.state.groupAnchor = null;
    this.state.offscreen.clear();
    this.updateGroupHeaderStyles?.();
  }

  /** The selected items: the loaded ones, plus those a whole date group brought in without being loaded. */
  getSelectedItems() {
    const items = this.state.items.filter((item) => this.state.selected.has(item.relpath));
    if (this.state.offscreen.size) {
      const seen = new Set(items.map((item) => item.relpath));
      this.state.offscreen.forEach((item, relpath) => {
        if (this.state.selected.has(relpath) && !seen.has(relpath)) items.push(item);
      });
    }
    return items;
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
    if (this.state.contextMenu.open && this.state.contextMenu.anchorKind === "point") {
      this.closeContextMenu();
    }
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
    this.state.selectedGroups.clear();
    this.updateGroupHeaderStyles();
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
    const {
      downloadButton,
      moveButton,
      deleteButton,
      selectAllButton,
      invertSelectionButton,
      starSelectedButton,
      selectModeButton,
    } = this.elements;
    const mode = this.state.selectionMode;
    const hasSelection = mode && selectionCount > 0;
    const filteredCount = this.getFilteredItems().length;
    const allSelected = filteredCount > 0 && selectionCount >= filteredCount;
    const show = (button, visible) => {
      if (button) button.style.display = visible ? "inline-flex" : "none";
    };
    if (selectModeButton) {
      selectModeButton.classList.toggle("active", mode);
      selectModeButton.setAttribute("aria-pressed", mode ? "true" : "false");
    }
    show(selectAllButton, mode && !allSelected && filteredCount > 0);
    show(invertSelectionButton, mode && filteredCount > 0);
    show(downloadButton, hasSelection);
    show(moveButton, hasSelection && this.state.tab === OUTPUT_TAB);
    show(deleteButton, hasSelection && this.canDeleteCurrentTab());
    show(starSelectedButton, hasSelection && this.canDeleteCurrentTab());
    if (starSelectedButton) {
      const allStarred = hasSelection && this.getSelectedItems().every((item) => item.starred);
      const label = t(allStarred ? "actions.unstar_selected" : "actions.star_selected");
      starSelectedButton.setAttribute("title", label);
      starSelectedButton.setAttribute("aria-label", label);
      starSelectedButton.innerHTML = `<i class="pi ${allStarred ? "pi-star-fill" : "pi-star"}"></i>`;
      starSelectedButton.classList.toggle("active", allStarred);
    }
    this.updateSearchVisibility();
  }

  /**
   * Tile click in selection mode. Shift+click applies the new state of the clicked tile to every tile
   * between the previously clicked one (the anchor) and this one, in gallery order.
   */
  selectFromClick(event, relpath) {
    const items = this.getFilteredItems();
    const value = !this.state.selected.has(relpath);
    const anchor = this.state.selectionAnchor;
    const anchorIndex = event.shiftKey && anchor ? items.findIndex((entry) => entry.relpath === anchor) : -1;
    const index = items.findIndex((entry) => entry.relpath === relpath);
    this.state.selectionAnchor = relpath;
    if (anchorIndex === -1 || index === -1) {
      this.setSelected(relpath, value);
      return;
    }
    this.state.selectedGroups.clear();
    this.updateGroupHeaderStyles();
    const from = Math.min(anchorIndex, index);
    const to = Math.max(anchorIndex, index);
    for (let position = from; position <= to; position += 1) {
      const target = items[position].relpath;
      if (value) this.state.selected.add(target);
      else this.state.selected.delete(target);
    }
    this.applySelectionStyles();
    this.updateActionsBar();
    if (this.state.overlay.relpath) {
      this.updateOverlayView();
    }
  }

  setSelectionMode(enabled) {
    const next = Boolean(enabled);
    if (this.state.selectionMode === next) return;
    this.state.selectionMode = next;
    this.state.selectionAnchor = null;
    if (!next) this.state.selected = new Set();
    this.closeContextMenu();
    this.elements.root?.classList.toggle("assets-plus-selection-mode", next);
    this.elements.grid?.querySelectorAll(".assets-plus-card").forEach((card) => {
      card.draggable = !next;
    });
    this.applySelectionStyles();
    this.updateActionsBar();
  }

  /** Star every selected item, or remove the stars when all of them are already starred. */
  async toggleStarSelected() {
    const items = this.getSelectedItems();
    if (!items.length) return;
    const allStarred = items.every((item) => item.starred);
    await this.setStarred(items, !allStarred);
    this.updateActionsBar();
  }

  applySelectionStyles() {
    this.elements.grid.querySelectorAll(".assets-plus-card").forEach((card) => {
      const relpath = card.getAttribute("data-relpath");
      const isSelected = this.state.selected.has(relpath);
      card.classList.toggle("selected", isSelected);
    });
  }

  handleDocumentClick(event) {
    this.closeFilterPopovers(event.target);
    if (!event.target.closest(".assets-plus-view-menu") && !event.target.closest(".assets-plus-view-button")) {
      this.closeViewMenu();
    }
    if (event.target.closest(".assets-plus-context-menu")) return;
    if (event.target.closest(".assets-plus-card-more")) return;
    this.closeContextMenu();
  }

  handleDocumentContextMenu(event) {
    // A right click on a tile opens (or moves) the menu itself; anywhere else it closes it.
    if (event.target.closest?.(".assets-plus-card, .assets-plus-context-menu")) return;
    this.closeContextMenu();
  }

  /** Mirror the view mode on the root element (the CSS does the rest). */
  applyViewMode() {
    const { root } = this.elements;
    if (!root) return;
    VIEW_MODES.forEach((mode) => root.classList.toggle(`assets-plus-view-${mode}`, mode === this.state.viewMode));
  }

  setViewMode(mode) {
    if (!VIEW_MODES.includes(mode) || mode === this.state.viewMode) return;
    this.state.viewMode = mode;
    try {
      window.localStorage?.setItem(VIEW_MODE_STORAGE_KEY, mode);
    } catch {
      // The choice then lasts until the page is reloaded.
    }
    this.applyViewMode();
    this.closeContextMenu();
    // Tiles and rows are built differently: rebuild them (the scroll position is kept by renderGrid).
    this.renderGrid({ reset: true });
  }

  renderViewMenu() {
    const { viewMenuList } = this.elements;
    viewMenuList.innerHTML = "";
    VIEW_MODES.forEach((mode) => {
      const button = createElement("button", { className: "assets-plus-context-menu-item" });
      const icon = document.createElement("i");
      icon.className = `pi ${VIEW_MODE_ICONS[mode]}`;
      const label = document.createElement("span");
      label.textContent = t(`view.${mode}`);
      const check = document.createElement("i");
      check.className = `pi pi-check assets-plus-view-check${mode === this.state.viewMode ? "" : " hidden"}`;
      button.append(icon, label, check);
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        this.closeViewMenu();
        this.setViewMode(mode);
      });
      viewMenuList.appendChild(button);
    });
  }

  toggleViewMenu() {
    const { viewMenu, viewButton } = this.elements;
    if (viewMenu.classList.contains("open")) {
      this.closeViewMenu();
      return;
    }
    this.closeContextMenu();
    this.renderViewMenu();
    viewMenu.style.visibility = "hidden";
    viewMenu.classList.add("open");
    const rect = viewButton.getBoundingClientRect();
    const menuRect = viewMenu.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - menuRect.width - 8));
    viewMenu.style.left = `${left}px`;
    viewMenu.style.top = `${rect.bottom + 6}px`;
    viewMenu.style.visibility = "";
    viewButton.setAttribute("aria-expanded", "true");
  }

  closeViewMenu() {
    const { viewMenu, viewButton } = this.elements;
    if (!viewMenu) return;
    viewMenu.classList.remove("open");
    viewButton?.setAttribute("aria-expanded", "false");
  }

  closeContextMenu() {
    const { contextMenu } = this.elements;
    if (!contextMenu) return;
    contextMenu.classList.remove("open");
    this.state.contextMenu.open = false;
    this.state.contextMenu.relpath = null;
    this.state.contextMenu.anchorKind = null;
    this.elements.grid?.querySelectorAll(".assets-plus-card.menu-open").forEach((card) => {
      card.classList.remove("menu-open");
    });
  }

  /** Place the menu next to a button, or at a pointer position ({ x, y }), inside the viewport. */
  positionContextMenu(anchor) {
    const { contextMenu } = this.elements;
    if (!contextMenu || !anchor) return;
    contextMenu.style.visibility = "hidden";
    contextMenu.classList.add("open");
    contextMenu.style.left = "0px";
    contextMenu.style.top = "0px";
    const menuRect = contextMenu.getBoundingClientRect();
    const padding = 8;
    let left;
    let top;
    if (typeof anchor.getBoundingClientRect === "function") {
      const buttonRect = anchor.getBoundingClientRect();
      left = buttonRect.right + 6;
      top = buttonRect.bottom + 6;
      if (left + menuRect.width > window.innerWidth - padding) {
        left = Math.max(padding, buttonRect.left - menuRect.width - 6);
      }
      if (top + menuRect.height > window.innerHeight - padding) {
        top = Math.max(padding, buttonRect.top - menuRect.height - 6);
      }
    } else {
      left = Math.min(anchor.x, window.innerWidth - menuRect.width - padding);
      top = Math.min(anchor.y, window.innerHeight - menuRect.height - padding);
      left = Math.max(padding, left);
      top = Math.max(padding, top);
    }
    contextMenu.style.left = `${left}px`;
    contextMenu.style.top = `${top}px`;
    contextMenu.style.visibility = "";
  }

  /** Entries of the tile menu, in groups (a separator is drawn between non-empty groups). */
  getContextMenuGroups(item) {
    const hasWorkflow = item.has_workflow && (item.type === "image" || item.type === "video");
    const canInsert = ["image", "video", "audio"].includes(item.type);
    const starLabel = item.starred ? "actions.unstar" : "actions.star";
    return [
      [
        { icon: "pi-search-plus", label: "actions.inspect", run: () => this.openOverlay(item.relpath) },
        canInsert && { icon: "pi-plus-circle", label: "actions.insert_as_node", run: () => this.insertAssetAsNode(item) },
        { icon: "pi-download", label: "actions.download", run: () => this.handleDownload(item) },
      ],
      hasWorkflow && [
        { icon: "pi-external-link", label: "actions.open_workflow_new_tab", run: () => this.openWorkflow(false, item) },
        { icon: "pi-arrow-right-arrow-left", label: "actions.replace_workflow", run: () => this.openWorkflow(true, item) },
        { icon: "pi-file-export", label: "actions.export_workflow", run: () => this.exportWorkflow(item) },
      ],
      [
        {
          icon: item.starred ? "pi-star-fill" : "pi-star",
          label: starLabel,
          run: () => this.setStarred([item], !item.starred),
        },
        this.state.tab === OUTPUT_TAB && { icon: "pi-inbox", label: "actions.move_to_input", run: () => this.moveToImported([item]) },
      ],
      this.canDeleteCurrentTab() && [
        { icon: "pi-trash", label: "actions.delete", danger: true, run: () => this.handleDelete(item) },
      ],
    ]
      .filter(Boolean)
      .map((group) => group.filter(Boolean))
      .filter((group) => group.length);
  }

  renderContextMenu(item) {
    const { contextMenuList } = this.elements;
    if (!contextMenuList) return;
    contextMenuList.innerHTML = "";
    this.getContextMenuGroups(item).forEach((group, index) => {
      if (index > 0) {
        contextMenuList.appendChild(createElement("div", { className: "assets-plus-context-menu-separator" }));
      }
      group.forEach((entry) => {
        const button = createElement("button", {
          className: `assets-plus-context-menu-item${entry.danger ? " danger" : ""}`,
        });
        const icon = document.createElement("i");
        icon.className = `pi ${entry.icon}`;
        const label = document.createElement("span");
        label.textContent = t(entry.label);
        button.appendChild(icon);
        button.appendChild(label);
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          this.closeContextMenu();
          entry.run();
        });
        contextMenuList.appendChild(button);
      });
    });
  }

  /** Open the tile menu next to a button ({element}) or at the pointer ({x, y}). */
  openContextMenu(item, anchor) {
    if (!item || !anchor || this.state.selectionMode) return;
    this.closeContextMenu();
    const isElement = typeof anchor.getBoundingClientRect === "function";
    this.state.contextMenu.relpath = item.relpath;
    this.state.contextMenu.open = true;
    this.state.contextMenu.anchorKind = isElement ? "button" : "point";
    this.renderContextMenu(item);
    this.positionContextMenu(anchor);
    this.elements.grid
      ?.querySelector(`[data-relpath="${typeof CSS !== "undefined" && CSS.escape ? CSS.escape(item.relpath) : item.relpath}"]`)
      ?.classList.add("menu-open");
  }

  toggleContextMenu(item, button) {
    if (!item || !button) return;
    const { relpath, open } = this.state.contextMenu;
    if (open && relpath === item.relpath) {
      this.closeContextMenu();
      return;
    }
    this.openContextMenu(item, button);
  }

  restoreContextMenu() {
    if (!this.state.contextMenu.open || !this.state.contextMenu.relpath) return;
    const relpath = this.state.contextMenu.relpath;
    const safeRelpath =
      typeof CSS !== "undefined" && CSS.escape
        ? CSS.escape(relpath)
        : relpath.replace(/["\\]/g, "\\$&");
    const card = this.elements.grid?.querySelector(`[data-relpath="${safeRelpath}"]`);
    if (!card) {
      this.closeContextMenu();
      return;
    }
    card.classList.add("menu-open");
    if (this.state.contextMenu.anchorKind === "button") {
      const button = card.querySelector(".assets-plus-card-more");
      if (button) this.positionContextMenu(button);
    }
  }

  /** Put the asset on the canvas as a Load Image/Video/Audio node at the centre of the view. */
  async insertAssetAsNode(item) {
    const canvas = this.app?.canvas;
    const element = canvas?.canvas;
    if (!canvas || !element || typeof canvas.ds?.convertOffsetToCanvas !== "function") return;
    const rect = element.getBoundingClientRect();
    const [canvasX, canvasY] = canvas.ds.convertOffsetToCanvas([rect.width / 2, rect.height / 2]);
    await this.createNodeForAsset(
      { relpath: item.relpath, tab: this.state.tab, type: item.type, filename: item.filename },
      { canvasX, canvasY },
      canvas
    );
  }

  /** Save the embedded workflow (or the prompt when that is all the file has) as a .json file. */
  async exportWorkflow(item) {
    try {
      const payload = await fetchJson(
        `/assets_plus/${this.state.tab}/meta?relpath=${encodeURIComponent(item.relpath)}`
      );
      const metadata = payload?.metadata ?? {};
      const data = metadata.workflow ?? metadata.prompt ?? null;
      if (!data) {
        this.toast({
          severity: "warn",
          summary: t("toast.summary"),
          detail: t("toast.workflow_missing"),
          life: 2500,
        });
        return;
      }
      const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
      const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = workflowFilenameForAsset(item.filename);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (error) {
      warn(t("log.workflow_open_failed"), error);
      this.toast({
        severity: "error",
        summary: t("toast.summary"),
        detail: t("toast.workflow_export_failed"),
        life: 2500,
      });
    }
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
    this.thumbPending = new Map();
    this.thumbObserver = new IntersectionObserver(
      (entries) => {
        // A tile that merely flies through the band while the user drags the scrollbar is not worth a request:
        // it must stay in the band for THUMB_SETTLE_MS (see flushThumbs) before its picture is fetched.
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            if (!this.thumbPending.has(entry.target)) this.thumbPending.set(entry.target, performance.now());
          } else {
            this.thumbPending.delete(entry.target);
          }
        });
        this.scheduleThumbFlush();
      },
      {
        root,
        rootMargin: "300px 0px",
        threshold: 0.01,
      }
    );
    if (this.elements?.grid) {
      this.elements.grid.querySelectorAll("[data-src]").forEach((el) => {
        this.thumbObserver?.observe(el);
      });
    }
    this.setupCardObserver();
  }

  scheduleThumbFlush() {
    if (this.thumbFlushTimer || !this.thumbPending?.size) return;
    this.thumbFlushTimer = setTimeout(() => {
      this.thumbFlushTimer = 0;
      this.flushThumbs();
    }, THUMB_SETTLE_MS / 2);
  }

  /** Starts loading the pictures of tiles that have stayed near the viewport for THUMB_SETTLE_MS. */
  flushThumbs() {
    const pending = this.thumbPending;
    if (!pending) return;
    const now = performance.now();
    for (const [media, since] of pending) {
      if (now - since < THUMB_SETTLE_MS) continue;
      pending.delete(media);
      const src = media.dataset.src;
      if (src) {
        media.src = src;
        if (media.tagName === "VIDEO") media.load?.();
      }
      this.thumbObserver?.unobserve(media);
    }
    this.scheduleThumbFlush();
  }

  /** Builds the content of tiles that come near the viewport and drops it for tiles that are far away. */
  setupCardObserver() {
    this.cardObserver?.disconnect();
    if (typeof IntersectionObserver === "undefined") {
      this.cardObserver = null;
      return;
    }
    this.cardObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) this.hydrateCard(entry.target);
          else this.dehydrateCard(entry.target);
        });
      },
      { root: this.elements.body || null, rootMargin: CARD_HYDRATE_MARGIN, threshold: 0 }
    );
    this.elements.grid?.querySelectorAll(".assets-plus-card").forEach((card) => this.cardObserver.observe(card));
  }

  disconnectThumbObserver() {
    clearTimeout(this.thumbFlushTimer);
    this.thumbFlushTimer = 0;
    this.thumbPending?.clear();
    this.cardObserver?.disconnect();
    this.cardObserver = null;
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

  /**
   * A tile is a cheap shell (one element) until it comes near the viewport: only then its thumbnail, badges and
   * buttons are built (hydrateCard), and they are torn down again when it is far away. A gallery of thousands of
   * tiles then keeps a few hundred DOM nodes, so layout (resizing the sidebar) and scrolling stay cheap, while
   * the shells keep the grid, the scrollbar and every position-based update exactly as before.
   */
  buildCard(item, thumbnailSize) {
    const card = createElement("div", { className: "assets-plus-card" });
    card.setAttribute("data-relpath", item.relpath);
    card.setAttribute("data-type", item.type);
    card.classList.toggle("selected", this.state.selected.has(item.relpath));
    card.classList.toggle("starred", Boolean(item.starred));
    card.draggable = !this.state.selectionMode;
    card._assetsItem = item;
    card._assetsThumbSize = thumbnailSize;
    card._hydrated = false;
    if (this.cardObserver) {
      this.cardObserver.observe(card);
    } else {
      this.hydrateCard(card);
    }
    return card;
  }

  hydrateCard(card) {
    const item = card._assetsItem;
    if (!item || card._hydrated) return;
    card._hydrated = true;
    const thumbnailSize = card._assetsThumbSize;

    // Shown only in selection mode, on selected cards (see CSS).
    const selectMark = createElement("div", { className: "assets-plus-select-mark" });
    selectMark.innerHTML = '<i class="pi pi-check"></i>';

    const isList = this.state.viewMode === "list";
    const isAudio = item.type === "audio";
    const version = itemVersion(item);
    const thumb = createElement("div", { className: "assets-plus-thumb" });
    const thumbUrl = buildThumbUrl(item.relpath, this.state.tab, thumbnailSize, version);
    const extension = getFileExtension(item.filename);
    const audioLabels = {
      play: t("audio.play"),
      pause: t("audio.pause"),
      prev: t("audio.previous"),
      next: t("audio.next"),
      mute: t("audio.mute"),
      volume: t("audio.volume"),
    };
    let audioControl = null;
    if (isAudio) {
      // No server thumbnail for sound: a note, and (in tiles) the player right on it.
      thumb.classList.add("assets-plus-thumb-audio");
      const note = createElement("div", { className: "assets-plus-audio-note" });
      note.innerHTML = AUDIO_NOTE_SVG;
      thumb.appendChild(note);
      if (!isList) {
        thumb.appendChild(createElement("div", { className: "assets-plus-audio-caption", text: t("audio.label") }));
      }
      audioControl = createAudioControl(isList ? "row" : "tile", {
        key: `${this.state.tab}|${item.relpath}|${version}`,
        url: buildViewUrl(item.relpath, this.state.tab, version),
        label: item.relpath,
        bars: isList ? 36 : 32,
        labels: audioLabels,
      });
      card._audioControl = audioControl;
      if (!isList) thumb.appendChild(audioControl.element);
    } else if (item.type === "mesh") {
      // A big cube until the browser has rendered the model (see requestMeshPreview), then the picture on top.
      thumb.classList.add("assets-plus-thumb-mesh");
      const cube = createElement("div", { className: "assets-plus-mesh-icon" });
      cube.innerHTML = '<i class="pi pi-box"></i>';
      const preview = document.createElement("img");
      preview.alt = item.filename;
      preview.decoding = "async";
      preview.draggable = false;
      // Invisible but laid out (a hidden image has no box, so the lazy loader would never fetch it).
      preview.className = "assets-plus-mesh-preview pending";
      preview.addEventListener("load", () => {
        preview.classList.remove("pending");
        cube.hidden = true;
      });
      preview.addEventListener("error", () => this.requestMeshPreview(item, thumbnailSize, preview, thumbUrl));
      thumb.appendChild(cube);
      thumb.appendChild(preview);
      this.observeMedia(preview, thumbUrl);
    } else if (item.type === "video" && VIDEO_THUMB_EXTENSIONS.has(extension)) {
      const video = document.createElement("video");
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      video.preload = "none";
      video.draggable = false;
      this.observeMedia(video, thumbUrl);
      thumb.appendChild(video);
    } else {
      const image = document.createElement("img");
      image.alt = item.filename;
      image.loading = "lazy";
      image.decoding = "async";
      image.draggable = false;
      // Until the picture arrives: a dim pulsing dot (CSS) instead of the browser's broken-image icon and alt text.
      thumb.classList.add("loading");
      image.classList.add("pending");
      image.addEventListener("load", () => {
        image.classList.remove("pending");
        thumb.classList.remove("loading");
      });
      image.addEventListener("error", () => thumb.classList.remove("loading")); // stays invisible, no broken icon
      this.observeMedia(image, thumbUrl);
      thumb.appendChild(image);
    }

    const starButton = createElement("button", { className: "assets-plus-card-star" });
    this.applyStarState(starButton, Boolean(item.starred));
    starButton.addEventListener("click", (event) => {
      event.stopPropagation();
      this.setStarred([item], !item.starred);
    });

    card.appendChild(thumb);
    if (isList) {
      // Two lines per row, always: the name, then size and date (or, for sound, the player).
      const main = createElement("div", { className: "assets-plus-row-main" });
      const name = createElement("div", { className: "assets-plus-row-name", attrs: { title: item.relpath } });
      const tailLength = Math.min(12, Math.max(4, Math.floor(item.relpath.length / 3)));
      name.appendChild(createElement("span", { className: "assets-plus-row-name-head", text: item.relpath.slice(0, -tailLength) }));
      name.appendChild(createElement("span", { className: "assets-plus-row-name-tail", text: item.relpath.slice(-tailLength) }));
      main.appendChild(name);
      if (audioControl) {
        main.appendChild(audioControl.element);
      } else {
        main.appendChild(
          createElement("div", {
            className: "assets-plus-row-meta",
            text: `${formatBytes(item.size)} · ${formatShortDate(item.mtime)}`,
          })
        );
      }
      card.appendChild(main);
    }
    const kindIcon = isList || isAudio ? null : CARD_KIND_ICONS[item.type];
    if (kindIcon) {
      const kindBadge = createElement("div", { className: "assets-plus-card-kind" });
      kindBadge.innerHTML = `<i class="pi ${kindIcon}"></i>`;
      kindBadge.setAttribute("aria-hidden", "true");
      card.appendChild(kindBadge);
    }
    card.appendChild(starButton);
    card.appendChild(selectMark);

    // Hover panel (like the stock Media Assets tab): download + more actions.
    const menu = createElement("div", { className: "assets-plus-card-menu" });
    const downloadButton = createElement("button", {
      className: "assets-plus-card-menu-button assets-plus-card-download",
      attrs: { title: t("actions.download"), "aria-label": t("actions.download") },
    });
    downloadButton.innerHTML = '<i class="pi pi-download"></i>';
    const moreButton = createElement("button", {
      className: "assets-plus-card-menu-button assets-plus-card-more",
      attrs: { title: t("actions.more"), "aria-label": t("actions.more"), "aria-haspopup": "menu" },
    });
    moreButton.innerHTML = '<i class="pi pi-ellipsis-h"></i>';
    menu.appendChild(downloadButton);
    menu.appendChild(moreButton);
    card.appendChild(menu);
    downloadButton.addEventListener("click", (event) => {
      event.stopPropagation();
      this.closeContextMenu();
      this.handleDownload(item);
    });
    moreButton.addEventListener("click", (event) => {
      event.stopPropagation();
      this.toggleContextMenu(item, moreButton);
    });
  }

  /** The server has no preview of this model yet: have the browser render one (unless the file is too big). */
  requestMeshPreview(item, size, image, thumbUrl) {
    if (image._meshRequested || !image.isConnected) return;
    const limitMb = Number(this.getSetting(SETTINGS.meshPreviewMaxMb, DEFAULT_MESH_PREVIEW_MAX_MB));
    if (!(limitMb > 0) || item.size > limitMb * 1024 * 1024) return;
    image._meshRequested = true;
    const tab = this.state.tab;
    const version = itemVersion(item);
    const params = new URLSearchParams({ relpath: item.relpath, w: String(size), h: String(size), v: version });
    meshPreviews
      .render(`${tab}|${item.relpath}|${version}|${size}`, {
        modelUrl: buildViewUrl(item.relpath, tab, version),
        uploadUrl: `/assets_plus/${tab}/thumb_upload?${params.toString()}`,
        size,
      })
      .then((ok) => {
        if (ok && image.isConnected) image.src = `${thumbUrl}&ready=1`;
      });
  }

  /** Tear down the content of a tile that is far from the viewport (never one that is in use). */
  dehydrateCard(card) {
    if (!card._hydrated) return;
    if (card.classList.contains("menu-open") || card.contains(document.activeElement)) return;
    card.querySelectorAll("img, video").forEach((media) => {
      this.thumbObserver?.unobserve(media);
      this.thumbPending?.delete(media);
      // A picture still on its way is cancelled with its tile (a detached image may otherwise keep loading).
      if (media.tagName === "IMG" && !media.complete) media.removeAttribute("src");
    });
    card._audioControl?.destroy();
    card._audioControl = null;
    card.replaceChildren();
    card._hydrated = false;
  }

  /** One set of listeners for every tile (the tiles themselves carry none). */
  bindGridEvents(grid) {
    const cardOf = (event) => {
      const card = event.target.closest?.(".assets-plus-card");
      return card && grid.contains(card) ? card : null;
    };
    grid.addEventListener("dragstart", (event) => {
      const card = cardOf(event);
      const item = card?._assetsItem;
      if (!item) return;
      if (this.state.selectionMode) {
        event.preventDefault();
        return;
      }
      // Store the asset payload so our own drop handler can pick it up.
      const payload = JSON.stringify({
        relpath: item.relpath,
        tab: this.state.tab,
        type: item.type,
        filename: item.filename,
      });
      event.dataTransfer.setData("application/x-assetsplus-asset", payload);
      // Keep text/uri-list for notebook-paste compatibility.
      const viewUrl = buildViewUrl(item.relpath, this.state.tab, itemVersion(item));
      const absoluteUrl = new URL(viewUrl, window.location.origin).href;
      event.dataTransfer.setData("text/uri-list", absoluteUrl);
      event.dataTransfer.setData("text/plain", absoluteUrl);
      // Thumbnail preview on cursor
      const thumbEl = card.querySelector(".assets-plus-thumb img, .assets-plus-thumb video");
      if (thumbEl instanceof HTMLImageElement || thumbEl instanceof HTMLVideoElement) {
        event.dataTransfer.setDragImage(thumbEl, thumbEl.offsetWidth / 2, thumbEl.offsetHeight / 2);
      }
    });
    grid.addEventListener("contextmenu", (event) => {
      const item = cardOf(event)?._assetsItem;
      if (!item || this.state.selectionMode) return;
      event.preventDefault();
      this.openContextMenu(item, { x: event.clientX, y: event.clientY });
    });
    grid.addEventListener("mousedown", (event) => {
      // Shift+click extends a range: keep the browser from also selecting text/images between tiles.
      if (cardOf(event) && this.state.selectionMode && event.shiftKey) event.preventDefault();
    });
    grid.addEventListener("click", (event) => {
      const header = event.target.closest?.(".assets-plus-group-header");
      if (header && grid.contains(header)) {
        // The chevron always folds; the rest of the header folds too, except in selection mode where it selects.
        if (!this.state.selectionMode || event.target.closest(".assets-plus-group-chevron")) {
          this.toggleGroupCollapsed(header);
        } else {
          this.selectGroupFromClick(event, header);
        }
        return;
      }
      const item = cardOf(event)?._assetsItem;
      if (!item) return;
      if (this.state.selectionMode) {
        this.selectFromClick(event, item.relpath);
        return;
      }
      if (event.target.closest(".assets-plus-card-menu")) {
        return;
      }
      if (event.target.closest(".assets-plus-card-star")) {
        return;
      }
      this.closeContextMenu();
      this.openOverlay(item.relpath);
    });
  }

  appendItemsToGrid(items) {
    if (!items.length) return;
    const { thumbnailSize } = this.getSettingsSnapshot();
    const grid = this.elements.grid;
    const wasEmpty = grid.children.length === 0;
    const fragment = document.createDocumentFragment();
    items.forEach((item) => {
      if (this.state.groupByDate) {
        const group = groupOf(item.mtime, this.groups);
        if (group.key !== this.groupLastKey) {
          fragment.appendChild(this.buildGroupHeader(group));
          this.groupLastKey = group.key;
        }
        const card = this.buildCard(item, thumbnailSize);
        card.dataset.group = group.key;
        card.hidden = this.state.collapsedGroups.has(group.key);
        fragment.appendChild(card);
        return;
      }
      fragment.appendChild(this.buildCard(item, thumbnailSize));
    });
    grid.appendChild(fragment);
    if (wasEmpty) {
      // The first screenful needs no round trip through the observer.
      const cards = grid.querySelectorAll(".assets-plus-card");
      for (let index = 0; index < Math.min(INITIAL_HYDRATED, cards.length); index += 1) {
        this.hydrateCard(cards[index]);
      }
    }
    this.updateActionsBar();
    this.restoreContextMenu();
  }

  renderGrid({ reset = false } = {}) {
    const grid = this.elements.grid;
    const filtered = this.getFilteredItems();
    if (reset) {
      this.rememberScrollPosition();
      grid.querySelectorAll(".assets-plus-card").forEach((card) => card._audioControl?.destroy());
      grid.innerHTML = "";
      this.resetGroups();
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

  buildListParams({ cursor = "", since = null, fresh = false } = {}) {
    const settings = this.getSettingsSnapshot();
    const params = new URLSearchParams();
    if (fresh) params.set("fresh", "1");
    params.set("limit", String(settings.listLimit));
    const extensions = this.activeExtensions(settings.extensions || []);
    if (extensions.length) params.set("extensions", extensions.join(","));
    if (settings.scanDepth !== null && settings.scanDepth !== undefined) {
      params.set("scan_depth", String(settings.scanDepth));
    } else if (settings.recursive === false) {
      params.set("recursive", "0");
    }
    if (this.useStarredFirst()) {
      params.set("starred_first", "1");
    }
    this.applyFilterParams(params);
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

  /** Newest first; starred items lead when "show starred first" is on. */
  sortItems(items) {
    const starredFirst = this.useStarredFirst();
    return items.sort(
      (a, b) =>
        (starredFirst ? Number(Boolean(b.starred)) - Number(Boolean(a.starred)) : 0) ||
        b.mtime - a.mtime ||
        a.relpath.localeCompare(b.relpath)
    );
  }

  mergeNewItems(items) {
    if (!items.length) return;
    const map = new Map(this.state.items.map((item) => [item.relpath, item]));
    items.forEach((item) => map.set(item.relpath, item));
    let previousCount = this.state.items.length;
    const known = new Set(this.state.items.map((item) => item.relpath));
    // Items that replace a known one (same name, new content): drop the old tile so the new one is built fresh.
    const replaced = new Set(items.map((item) => item.relpath).filter((relpath) => known.has(relpath)));
    if (replaced.size) {
      this.elements.grid.querySelectorAll(".assets-plus-card").forEach((card) => {
        if (!replaced.has(card.getAttribute("data-relpath"))) return;
        card.querySelectorAll("[data-src]").forEach((media) => this.thumbObserver?.unobserve(media));
        this.cardObserver?.unobserve(card);
        card.remove();
        previousCount -= 1;
      });
      replaced.forEach((relpath) => known.delete(relpath));
    }
    const merged = this.sortItems(Array.from(map.values()));
    this.state.items = merged;
    const available = new Set(merged.map((item) => item.relpath));
    this.state.selected = new Set(
      Array.from(this.state.selected).filter((relpath) => available.has(relpath) || this.state.offscreen.has(relpath))
    );
    const grid = this.elements.grid;
    if (this.state.groupByDate) {
      // Date headers sit between the tiles, so positions no longer match: rebuild.
      this.renderGrid({ reset: true });
      this.refreshGroupCounts();
      return;
    }
    if (grid.children.length !== previousCount) {
      this.renderGrid({ reset: true });
      return;
    }
    // The grid shows exactly the previous items: insert the new tiles in place, leave the rest alone.
    const { thumbnailSize } = this.getSettingsSnapshot();
    merged.forEach((item, index) => {
      if (known.has(item.relpath)) return;
      grid.insertBefore(this.buildCard(item, thumbnailSize), grid.children[index] || null);
    });
    this.renderGrid();
    this.updateActionsBar();
    this.restoreContextMenu();
  }

  /** Remove the tiles of the given relpaths without rebuilding the grid. */
  removeCardsFromGrid(removed) {
    if (this.state.groupByDate) {
      this.renderGrid({ reset: true });
      this.refreshGroupCounts();
      return;
    }
    this.elements.grid.querySelectorAll(".assets-plus-card").forEach((card) => {
      if (!removed.has(card.getAttribute("data-relpath"))) return;
      card.querySelectorAll("[data-src]").forEach((media) => this.thumbObserver?.unobserve(media));
      card._audioControl?.destroy();
      this.cardObserver?.unobserve(card);
      card.remove();
    });
    this.renderGrid();
    this.updateActionsBar();
    this.restoreContextMenu();
  }

  /** Move the tiles of items whose position changed (e.g. a toggled star with "starred first") in place. */
  repositionCards(changedRelpaths) {
    if (this.state.groupByDate) {
      this.renderGrid({ reset: true });
      return;
    }
    const grid = this.elements.grid;
    const cards = new Map();
    grid.querySelectorAll(".assets-plus-card").forEach((card) => {
      const relpath = card.getAttribute("data-relpath");
      if (changedRelpaths.has(relpath)) cards.set(relpath, card);
    });
    cards.forEach((card) => card.remove());
    this.state.items.forEach((item, index) => {
      const card = cards.get(item.relpath);
      if (card) grid.insertBefore(card, grid.children[index] || null);
    });
  }

  async loadPage({ reset = false, fresh = false } = {}) {
    // Every refresh (tab switch, search, reload) starts a new epoch; answers of an older one are dropped.
    const epoch = this.listEpoch;
    const params = this.buildListParams({ cursor: reset ? "" : this.state.cursor, fresh });
    const payload = await fetchJson(`/assets_plus/${this.state.tab}/list?${params.toString()}`);
    if (epoch !== this.listEpoch) return;
    let items = payload.items || [];
    if (reset) {
      this.state.items = items;
    } else {
      // Starring/unstarring while paging can reorder items across the cursor; never show one twice.
      const known = new Set(this.state.items.map((item) => item.relpath));
      items = items.filter((item) => !known.has(item.relpath));
      this.state.items = this.state.items.concat(items);
    }
    this.state.cursor = payload.cursor || this.state.cursor;
    this.state.hasMore = Boolean(payload.has_more);
    this.updateLatestMtime(payload.latest_mtime);
    if (reset) {
      this.renderGrid({ reset: true });
      this.refreshGroupCounts();
    } else {
      this.appendItemsToGrid(items);
      if (!items.length && !this.state.items.length) {
        this.renderGrid({ reset: true });
      } else if (this.state.loadingMore) {
        this.setStatus(t("status.loading_more"));
      } else {
        this.setStatus("");
      }
      this.fillViewport();
    }
  }

  async refreshList({ fresh = false } = {}) {
    const epoch = ++this.listEpoch;
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
      await this.loadPage({ reset: true, fresh });
    } catch (error) {
      if (epoch !== this.listEpoch) return;
      this.state.error = t("status.load_error");
      this.renderGrid({ reset: true });
    } finally {
      if (epoch === this.listEpoch) {
        this.state.loading = false;
        this.renderGrid({ reset: true });
      }
    }
  }

  /** Load the next page; callers that arrive while one is already loading wait for that one. */
  loadNextPage() {
    if (this.nextPagePromise) return this.nextPagePromise;
    if (!this.state.hasMore || this.state.loadingMore || this.state.loading) return Promise.resolve();
    const epoch = this.listEpoch;
    this.state.loadingMore = true;
    this.renderGrid();
    this.nextPagePromise = (async () => {
      try {
        await this.loadPage();
      } catch (error) {
        if (epoch === this.listEpoch) this.state.error = t("status.load_error");
      } finally {
        this.nextPagePromise = null;
        if (epoch === this.listEpoch) {
          this.state.loadingMore = false;
          this.renderGrid();
        }
      }
    })();
    return this.nextPagePromise;
  }

  async refreshNewItems() {
    if (this.state.loading) return;
    const since = this.state.latestMtime || null;
    const params = this.buildListParams({ since });
    const epoch = this.listEpoch;
    try {
      const payload = await fetchJson(`/assets_plus/${this.state.tab}/list?${params.toString()}`);
      if (epoch !== this.listEpoch) return;
      // The server reports everything from the newest known second (inclusive, so files saved
      // within the same second are not missed); only rebuild the grid for really new items.
      // A file that was deleted behind our back and generated again under the same name comes back with a new
      // mtime/size: it is not "known", it replaces the old tile.
      const known = new Map(this.state.items.map((item) => [item.relpath, item]));
      const items = (payload.items || []).filter((item) => {
        const old = known.get(item.relpath);
        return !old || old.mtime !== item.mtime || old.size !== item.size;
      });
      if (items.length) {
        this.mergeNewItems(items);
      }
      this.updateLatestMtime(payload.latest_mtime);
    } catch (error) {
      warn(t("log.refresh_failed"), error);
    } finally {
      this.state.pendingRefresh[this.state.tab] = false;
    }
  }

  async handleDownload(targetItem) {
    const items = targetItem ? [targetItem] : this.getSelectedItems();
    if (!items.length) return;
    for (const item of items) {
      const url = buildViewUrl(item.relpath, this.state.tab, itemVersion(item));
      try {
        const headResponse = await fetch(url, { method: "HEAD" });
        if (!headResponse.ok) {
          this.toast({
            severity: "error",
            summary: t("toast.summary"),
            detail: t("toast.download_failed", { filename: item.filename }),
            life: 3000,
          });
          continue;
        }
      } catch {
        this.toast({
          severity: "error",
          summary: t("toast.summary"),
          detail: t("toast.download_failed", { filename: item.filename }),
          life: 3000,
        });
        continue;
      }
      const link = document.createElement("a");
      link.href = url;
      link.download = item.filename;
      link.rel = "noopener";
      link.target = "_blank";
      document.body.appendChild(link);
      link.click();
      link.remove();
    }
  }

  /** Paint a star button (card or lens) for the given state. */
  applyStarState(button, starred) {
    if (!button) return;
    const label = starred ? t("actions.unstar") : t("actions.star");
    button.classList.toggle("active", starred);
    button.setAttribute("title", label);
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-pressed", starred ? "true" : "false");
    button.innerHTML = `<i class="pi ${starred ? "pi-star-fill" : "pi-star"}"></i>`;
  }

  /** Move generated results into the input root so they become assets for generations. */
  async moveToImported(items) {
    if (this.state.tab !== OUTPUT_TAB || !items.length) return;
    try {
      const payload = await fetchJson("/assets_plus/output/move_to_input", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ relpaths: items.map((item) => item.relpath) }),
      });
      const moved = payload.moved || [];
      const failedCount = (payload.failed || []).length;
      if (moved.length) {
        this.removeItemsFromView(moved.map((entry) => entry.from));
      }
      if (!moved.length || failedCount) {
        this.toast({
          severity: moved.length ? "warn" : "error",
          summary: t("toast.summary"),
          detail: t("toast.move_failed", { count: failedCount || items.length }),
          life: 4000,
        });
      }
      if (moved.length) {
        this.toast({
          severity: "success",
          summary: t("toast.summary"),
          detail: t("toast.move_success", { count: moved.length }),
          life: 2500,
        });
      }
    } catch (error) {
      warn(t("toast.move_failed", { count: items.length }), error);
      this.toast({
        severity: "error",
        summary: t("toast.summary"),
        detail: t("toast.move_failed", { count: items.length }),
        life: 4000,
      });
    }
  }

  async setStarred(items, starred) {
    const relpaths = items.map((item) => item.relpath);
    if (!relpaths.length || !this.canDeleteCurrentTab()) return;
    try {
      const payload = await fetchJson(`/assets_plus/${this.state.tab}/star`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ relpaths, starred }),
      });
      const updated = new Set(payload.updated || []);
      if (!updated.size) throw new Error("nothing updated");
      const apply = (item) => {
        if (updated.has(item.relpath)) item.starred = starred;
      };
      this.state.items.forEach(apply);
      this.state.overlay.window?.items.forEach(apply);
      this.refreshStarVisuals(updated);
    } catch (error) {
      warn(t("toast.star_failed"), error);
      this.toast({
        severity: "error",
        summary: t("toast.summary"),
        detail: t("toast.star_failed"),
        life: 3000,
      });
    }
  }

  refreshStarVisuals(changedRelpaths) {
    const starredFirst = this.useStarredFirst();
    const byPath = new Map(this.state.items.map((entry) => [entry.relpath, entry]));
    if (starredFirst) {
      // Order depends on the star: re-sort, then move only the affected tiles and repaint their stars.
      this.state.items = this.sortItems(this.state.items);
      this.repositionCards(changedRelpaths);
      this.elements.grid.querySelectorAll(".assets-plus-card").forEach((card) => {
        const relpath = card.getAttribute("data-relpath");
        if (!changedRelpaths.has(relpath)) return;
        const starred = Boolean(byPath.get(relpath)?.starred);
        card.classList.toggle("starred", starred);
        this.applyStarState(card.querySelector(".assets-plus-card-star"), starred);
      });
    } else {
      this.elements.grid.querySelectorAll(".assets-plus-card").forEach((card) => {
        const relpath = card.getAttribute("data-relpath");
        if (!changedRelpaths.has(relpath)) return;
        const starred = Boolean(byPath.get(relpath)?.starred);
        card.classList.toggle("starred", starred);
        this.applyStarState(card.querySelector(".assets-plus-card-star"), starred);
      });
    }
    if (this.state.overlay.relpath) {
      this.updateOverlayActions(this.getOverlayItem());
    }
  }

  /** Drop items that left the current gallery; the lens moves to the nearest remaining item. */
  removeItemsFromView(relpaths) {
    const removed = new Set(relpaths);
    const overlayRelpath = this.state.overlay.relpath;
    const lensRemoved = Boolean(overlayRelpath && removed.has(overlayRelpath));
    let nextOverlayRelpath = null;
    if (lensRemoved) {
      // The lens item may live in the gallery's items or only in the lens window: use whichever has it.
      const position = this.lensPosition(overlayRelpath);
      if (position) {
        const { list, index } = position;
        for (let i = index + 1; i < list.length && !nextOverlayRelpath; i += 1) {
          if (!removed.has(list[i].relpath)) nextOverlayRelpath = list[i].relpath;
        }
        for (let i = index - 1; i >= 0 && !nextOverlayRelpath; i -= 1) {
          if (!removed.has(list[i].relpath)) nextOverlayRelpath = list[i].relpath;
        }
      }
    }

    const nextWindow = this.state.overlay.window;
    if (nextWindow) nextWindow.items = nextWindow.items.filter((item) => !removed.has(item.relpath));
    this.state.items = this.state.items.filter((item) => !removed.has(item.relpath));
    relpaths.forEach((relpath) => {
      this.state.selected.delete(relpath);
      this.state.offscreen.delete(relpath);
    });
    this.state.latestMtime = this.state.items.reduce(
      (latest, item) => Math.max(latest, item.mtime),
      0
    );
    if (lensRemoved) {
      this.state.overlay.relpath = nextOverlayRelpath;
      if (!nextOverlayRelpath) {
        this.closeOverlay();
      }
    }
    this.removeCardsFromGrid(removed);
    if (nextOverlayRelpath && this.findLensItem(nextOverlayRelpath)) {
      this.state.overlay.relpath = nextOverlayRelpath;
      this.updateOverlayView();
    }
  }

  async handleDelete(targetItem) {
    const items = targetItem ? [targetItem] : this.getSelectedItems();
    if (!items.length) return;
    const settings = this.getSettingsSnapshot();
    const mode = settings.deleteMode;
    const hasStarred = items.some((item) => item.starred);
    const baseMessage =
      mode === "hide"
        ? t("confirm.delete.hide_message")
        : t("confirm.delete.delete_message");
    const message = hasStarred
      ? `${baseMessage} ${t("confirm.delete.starred_note")}`
      : baseMessage;
    if (settings.confirmDelete || (hasStarred && settings.confirmDeleteStarred)) {
      const dialogService = this.app?.extensionManager?.dialog;
      let confirmed = false;
      if (dialogService?.confirm) {
        confirmed =
          (await dialogService.confirm({
            title: t("confirm.delete.title"),
            message,
            type: mode === "hide" ? "default" : "delete",
            itemList: items
              .slice(0, 100)
              .map((asset) => asset.filename)
              .concat(items.length > 100 ? [t("confirm.delete.and_more", { count: items.length - 100 })] : []),
          })) === true;
      } else {
        confirmed = window.confirm(message);
      }
      if (!confirmed) return;
    }

    const deleteRelpaths = items.map((item) => item.relpath);
    const deleteEndpoint = this.getDeleteEndpoint();
    if (!deleteEndpoint) return;

    try {
      const payload = await fetchJson(deleteEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ relpaths: deleteRelpaths, mode }),
      });
      // Only drop what the server really removed; failed items stay visible.
      const removed = Array.isArray(payload?.removed) ? payload.removed : deleteRelpaths;
      if (removed.length) this.removeItemsFromView(removed);
      if (deleteRelpaths.length > removed.length) {
        this.toast({
          severity: "error",
          summary: t("toast.summary"),
          detail: t("toast.delete_failed"),
          life: 4000,
        });
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
    // Files made through the API only carry the prompt; ComfyUI can rebuild a graph from it.
    const prompt = workflow ? null : normalizeWorkflow(metadata.prompt ?? null);
    return {
      workflow,
      workflowRaw,
      prompt,
      filename: workflowFilenameForAsset(asset.filename),
    };
  }

  /** Rebuild a graph from an API-format prompt (no node positions, groups or notes are stored in it). */
  async openWorkflowFromPrompt(replaceCurrent, prompt, filename, options) {
    if (!replaceCurrent) {
      const workflowStore = resolveWorkflowStore(this.app);
      if (workflowStore?.createTemporary && workflowStore?.openWorkflow) {
        // loadApiJson fills the active workflow, so make the new tab active first.
        await workflowStore.openWorkflow(workflowStore.createTemporary(filename));
      }
    }
    await this.app.loadApiJson(prompt, filename);
    this.toast({
      severity: "info",
      summary: t("toast.summary"),
      detail: t("toast.workflow_from_prompt"),
      life: 5000,
    });
    this.maybeCloseOverlayAfterWorkflow(options);
  }

  async openWorkflow(replaceCurrent, targetItem = null, options = {}) {
    const items = targetItem ? [targetItem] : this.getSelectedItems();
    if (items.length !== 1) return;
    try {
      const { workflow, workflowRaw, prompt, filename } = await this.extractWorkflow(items[0]);
      if (!workflow && prompt && typeof this.app?.loadApiJson === "function") {
        await this.openWorkflowFromPrompt(replaceCurrent, prompt, filename, options);
        return;
      }
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
}

Object.assign(AssetsPlusExplorer.prototype, overlayAPI, filtersAPI);
