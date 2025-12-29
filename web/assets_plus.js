(() => {
  const EXTENSION_NAME = "digidwarf.AssetsPlus";
  const DEFAULT_POLL_SECONDS = 5;
  const DEFAULT_THUMB_SIZE = 256;
  const DEFAULT_PAGE_LIMIT = 200;
  const DEFAULT_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "mp4", "webm"];
  const SIDEBAR_TAB_ID = "assets";
  const SETTINGS = {
    pollSeconds: "AssetsPlus.PollSeconds",
    deleteMode: "AssetsPlus.DeleteMode",
    recursive: "AssetsPlus.Recursive",
    scanDepth: "AssetsPlus.ScanDepth",
    listLimit: "AssetsPlus.ListLimit",
    thumbnailSize: "AssetsPlus.ThumbnailSize",
    extensions: "AssetsPlus.AllowedExtensions",
  };

  function getVue() {
    return window.Vue ?? window.comfyVue ?? null;
  }

  function getApp() {
    return window.app ?? window.comfyApp ?? window.comfy?.app ?? null;
  }

  function getVueApp() {
    const root = document.getElementById("vue-app");
    return root?.__vue_app__ ?? null;
  }

  function getApi(appInstance) {
    return appInstance?.api ?? window.api ?? window.comfyApi ?? null;
  }

  function internalUrl(appInstance, path) {
    const api = getApi(appInstance);
    if (api?.internalURL) {
      return api.internalURL(path);
    }
    return `/internal${path}`;
  }

  function getSetting(appInstance, id, fallback) {
    const settingValue = appInstance?.extensionManager?.setting?.get?.(id);
    return settingValue ?? fallback;
  }

  async function fetchList({ cursor, limit, extensions, recursive, scanDepth }) {
    const params = new URLSearchParams();
    if (cursor) {
      params.set("cursor", cursor);
    }
    if (limit) {
      params.set("limit", String(limit));
    }
    if (extensions?.length) {
      params.set("extensions", extensions.join(","));
    }
    if (scanDepth !== null && scanDepth !== undefined) {
      params.set("scan_depth", String(scanDepth));
    } else if (recursive === false) {
      params.set("recursive", "0");
    }
    const response = await fetch(`/assets_plus/output/list?${params.toString()}`);
    if (!response.ok) {
      throw new Error("Failed to load Assets+ list");
    }
    return response.json();
  }

  async function fetchConfig() {
    const response = await fetch("/assets_plus/config");
    if (!response.ok) {
      throw new Error("Failed to load Assets+ config");
    }
    return response.json();
  }

  async function fetchMetadata(relpath) {
    const response = await fetch(`/assets_plus/output/meta?relpath=${encodeURIComponent(relpath)}`);
    if (!response.ok) {
      throw new Error("Failed to load metadata");
    }
    return response.json();
  }

  async function fetchInputFiles(appInstance) {
    const response = await fetch(internalUrl(appInstance, "/files/input"), {
      headers: (() => {
        const headers = new Headers();
        const user = getApi(appInstance)?.user;
        if (user) {
          headers.set("Comfy-User", user);
        }
        return headers;
      })(),
    });
    if (!response.ok) {
      throw new Error("Failed to load input files");
    }
    return response.json();
  }

  async function deleteAssets(relpaths, mode) {
    const response = await fetch("/assets_plus/output/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ relpaths, mode }),
    });
    if (!response.ok) {
      throw new Error("Failed to delete asset");
    }
    return response.json();
  }

  function getFilenameParts(relpath) {
    const segments = relpath.split("/");
    const filename = segments.pop() ?? relpath;
    const subfolder = segments.join("/");
    return { filename, subfolder };
  }

  function buildViewUrl(relpath, type) {
    const { filename, subfolder } = getFilenameParts(relpath);
    const params = new URLSearchParams({ filename, type });
    if (subfolder) {
      params.set("subfolder", subfolder);
    }
    return `/view?${params.toString()}`;
  }

  function buildThumbUrl(relpath, size = DEFAULT_THUMB_SIZE) {
    const params = new URLSearchParams({
      relpath,
      w: String(size),
      h: String(size),
    });
    return `/assets_plus/output/thumb?${params.toString()}`;
  }

  function normalizeWorkflow(workflow) {
    if (!workflow) {
      return null;
    }
    if (typeof workflow === "string") {
      try {
        return JSON.parse(workflow);
      } catch (error) {
        console.warn("Assets+: failed to parse workflow JSON", error);
        return null;
      }
    }
    return workflow;
  }

  function workflowFilenameForAsset(assetName) {
    return assetName.replace(/\.[^/.]+$/, ".json");
  }

  function resolveWorkflowStore(appInstance) {
    const workflowRef = appInstance?.extensionManager?.workflow ?? null;
    if (!workflowRef) {
      return null;
    }
    return workflowRef.value ?? workflowRef;
  }

  function resolveWorkflowActionsService(appInstance) {
    const fromApp =
      appInstance?.extensionManager?.workflowActionsService ||
      appInstance?.extensionManager?.workflowActions ||
      appInstance?.workflowActionsService ||
      appInstance?.workflowActions;
    if (fromApp?.openWorkflowAction) {
      return fromApp;
    }
    const globalService =
      window?.comfyWorkflowActionsService ||
      window?.workflowActionsService ||
      window?.useWorkflowActionsService?.() ||
      null;
    if (globalService?.openWorkflowAction) {
      return globalService;
    }
    return null;
  }

  async function extractWorkflowFromAsset(asset, { fetchMetadataFallback }) {
    const extractor =
      window?.extractWorkflowFromAsset ||
      window?.comfyExtractWorkflowFromAsset ||
      window?.comfy?.extractWorkflowFromAsset ||
      null;
    if (typeof extractor === "function") {
      return extractor(asset);
    }

    const baseFilename = workflowFilenameForAsset(asset.name);
    const directWorkflow = asset.user_metadata?.workflow;
    if (directWorkflow) {
      return { workflow: normalizeWorkflow(directWorkflow), filename: baseFilename };
    }

    try {
      const metadata = await fetchMetadataFallback(asset.id);
      if (metadata?.workflow) {
        return {
          workflow: normalizeWorkflow(metadata.workflow),
          filename: baseFilename,
        };
      }
    } catch (error) {
      console.warn("Assets+: failed to extract workflow metadata", error);
    }

    return { workflow: null, filename: baseFilename };
  }

  function resolveComponentFromAssetsTab(appInstance, name) {
    const tabs = appInstance?.extensionManager?.getSidebarTabs?.() ?? [];
    const assetsTab = tabs.find((tab) => tab.id === "assets");
    const assetsComponent = assetsTab?.component;
    return (
      assetsComponent?.components?.[name] ||
      assetsComponent?.__components?.[name] ||
      assetsComponent?.[name] ||
      null
    );
  }

  function resolveVueComponent(appInstance, name) {
    const vueApp = getVueApp();
    const globalRegistry = vueApp?._context?.components?.[name];
    return (
      globalRegistry ||
      window.ComfyUIComponents?.[name] ||
      window.comfyUIComponents?.[name] ||
      resolveComponentFromAssetsTab(appInstance, name) ||
      null
    );
  }

  function showToast(appInstance, options) {
    const toast = appInstance?.extensionManager?.toast;
    if (toast?.add) {
      toast.add(options);
    }
  }

  function inferMediaType(name) {
    const lower = name.toLowerCase();
    if (lower.endsWith(".mp4") || lower.endsWith(".webm")) {
      return "video";
    }
    if (
      lower.endsWith(".mp3") ||
      lower.endsWith(".wav") ||
      lower.endsWith(".ogg") ||
      lower.endsWith(".flac")
    ) {
      return "audio";
    }
    return "image";
  }

  function buildGalleryItem(asset) {
    const relpath = asset.id;
    const type = asset.user_metadata?.source === "input" ? "input" : "output";
    const url = buildViewUrl(relpath, type);
    const lower = asset.name.toLowerCase();
    const isVideo = lower.endsWith(".mp4") || lower.endsWith(".webm");
    const isAudio =
      lower.endsWith(".mp3") ||
      lower.endsWith(".wav") ||
      lower.endsWith(".ogg") ||
      lower.endsWith(".flac");
    return {
      url,
      filename: asset.name,
      isVideo,
      isAudio,
      isImage: !isVideo && !isAudio,
      htmlVideoType: lower.endsWith(".webm") ? "video/webm" : lower.endsWith(".mp4") ? "video/mp4" : undefined,
      htmlAudioType: lower.endsWith(".mp3")
        ? "audio/mpeg"
        : lower.endsWith(".wav")
          ? "audio/wav"
          : lower.endsWith(".ogg")
            ? "audio/ogg"
            : lower.endsWith(".flac")
              ? "audio/flac"
              : undefined,
      vhsAdvancedPreviewUrl: url,
    };
  }

  function registerSettings(appInstance, defaults) {
    const settings = appInstance?.ui?.settings;
    if (!settings?.addSetting) {
      return;
    }
    settings.addSetting({
      id: SETTINGS.pollSeconds,
      name: "Assets+ Poll interval (seconds)",
      category: ["Assets+", "Generated+", "Polling"],
      tooltip: "Как часто обновлять список Generated+",
      type: "slider",
      attrs: { min: 1, max: 60, step: 1 },
      defaultValue: defaults.poll_seconds ?? DEFAULT_POLL_SECONDS,
    });
    settings.addSetting({
      id: SETTINGS.deleteMode,
      name: "Assets+ Delete mode",
      category: ["Assets+", "Generated+", "Deletion"],
      tooltip: "Режим удаления ассетов в Generated+",
      type: "combo",
      options: ["trash", "delete", "hide"],
      defaultValue: defaults.default_delete_mode ?? "trash",
    });
    settings.addSetting({
      id: SETTINGS.recursive,
      name: "Assets+ Recursive scan",
      category: ["Assets+", "Generated+", "Scanning"],
      tooltip: "Искать ассеты рекурсивно в output",
      type: "boolean",
      defaultValue: defaults.recursive ?? true,
    });
    settings.addSetting({
      id: SETTINGS.scanDepth,
      name: "Assets+ Scan depth",
      category: ["Assets+", "Generated+", "Scanning"],
      tooltip: "Максимальная глубина сканирования (-1 = без лимита)",
      type: "number",
      defaultValue: Number.isFinite(defaults.scan_depth) ? defaults.scan_depth : -1,
    });
    settings.addSetting({
      id: SETTINGS.listLimit,
      name: "Assets+ List limit",
      category: ["Assets+", "Generated+", "Paging"],
      tooltip: "Сколько элементов загружать за раз",
      type: "number",
      defaultValue: defaults.list_limit ?? DEFAULT_PAGE_LIMIT,
    });
    settings.addSetting({
      id: SETTINGS.thumbnailSize,
      name: "Assets+ Thumbnail size",
      category: ["Assets+", "Generated+", "Thumbnails"],
      tooltip: "Размер превью в пикселях",
      type: "number",
      defaultValue: defaults.thumbnail_size?.[0] ?? DEFAULT_THUMB_SIZE,
    });
    settings.addSetting({
      id: SETTINGS.extensions,
      name: "Assets+ Allowed extensions",
      category: ["Assets+", "Generated+", "Filters"],
      tooltip: "Список расширений через запятую",
      type: "string",
      defaultValue: (defaults.allowed_extensions || []).join(","),
    });
  }

  function createAssetsPlusComponent(appInstance, vue) {
    const { markRaw, computed, ref, onMounted, onBeforeUnmount, onActivated, onDeactivated, watch } =
      vue;

    const MediaAssetCard = resolveVueComponent(appInstance, "MediaAssetCard");
    const MediaAssetFilterBar = resolveVueComponent(appInstance, "MediaAssetFilterBar");
    const ResultGallery = resolveVueComponent(appInstance, "ResultGallery");
    const VirtualGrid = resolveVueComponent(appInstance, "VirtualGrid");
    const SidebarTabTemplate = resolveVueComponent(appInstance, "SidebarTabTemplate");
    const TabList = resolveVueComponent(appInstance, "TabList");
    const Tab = resolveVueComponent(appInstance, "Tab");
    const Button = resolveVueComponent(appInstance, "Button");
    const ProgressSpinner = resolveVueComponent(appInstance, "ProgressSpinner");
    const NoResultsPlaceholder = resolveVueComponent(appInstance, "NoResultsPlaceholder");

    if (!MediaAssetCard || !MediaAssetFilterBar || !ResultGallery || !VirtualGrid) {
      console.warn(
        "Assets+: required Media Assets components not found; check ComfyUI_frontend availability."
      );
    }

    const component = {
      name: "AssetsPlusSidebarTab",
      components: {
        MediaAssetCard: MediaAssetCard ?? undefined,
        MediaAssetFilterBar: MediaAssetFilterBar ?? undefined,
        ResultGallery: ResultGallery ?? undefined,
        VirtualGrid: VirtualGrid ?? undefined,
        SidebarTabTemplate: SidebarTabTemplate ?? undefined,
        TabList: TabList ?? undefined,
        Tab: Tab ?? undefined,
        Button: Button ?? undefined,
        ProgressSpinner: ProgressSpinner ?? undefined,
        NoResultsPlaceholder: NoResultsPlaceholder ?? undefined,
      },
      setup() {
        const hasTabs = Boolean(TabList && Tab);
        const hasNoResultsPlaceholder = Boolean(NoResultsPlaceholder);
        const activeTab = ref("output");
        const outputItems = ref([]);
        const inputItems = ref([]);
        const isLoadingOutput = ref(false);
        const isLoadingInput = ref(false);
        const isLoadingMore = ref(false);
        const hasMoreOutput = ref(true);
        const cursor = ref(null);
        const error = ref("");
        const deleteMode = ref("trash");
        const searchQuery = ref("");
        const sortBy = ref("newest");
        const mediaTypeFilters = ref([]);
        const openContextMenuId = ref(null);
        const galleryActiveIndex = ref(-1);
        const pollSeconds = ref(DEFAULT_POLL_SECONDS);
        const listLimit = ref(DEFAULT_PAGE_LIMIT);
        const extensions = ref(DEFAULT_EXTENSIONS);
        const recursive = ref(true);
        const scanDepth = ref(null);
        const thumbnailSize = ref(DEFAULT_THUMB_SIZE);
        const outputSelection = ref(new Set());
        const inputSelection = ref(new Set());
        const selectedIds = computed(() =>
          activeTab.value === "output" ? outputSelection.value : inputSelection.value
        );
        let pollId = null;
        let settingListenersRegistered = false;

        const resolveActiveTabId = () => {
          const manager = appInstance?.extensionManager;
          const candidate =
            manager?.activeSidebarTabId ??
            manager?.sidebarActiveTabId ??
            manager?.activeSidebarTab?.id ??
            manager?.sidebar?.activeTabId ??
            null;
          if (candidate?.value !== undefined) {
            return candidate.value;
          }
          return candidate ?? null;
        };

        const setActiveState = (nextActive) => {
          if (nextActive) {
            if (activeTab.value === "output") {
              fetchOutputList();
              startPolling();
            } else {
              fetchInputList();
              stopPolling();
            }
          } else {
            stopPolling();
          }
        };

        const startPolling = () => {
          if (pollId) {
            return;
          }
          const interval = Math.max(1, pollSeconds.value) * 1000;
          pollId = window.setInterval(pollForUpdates, interval);
        };

        const stopPolling = () => {
          if (pollId) {
            window.clearInterval(pollId);
            pollId = null;
          }
        };

        const syncSelection = (nextItems, selectionRef) => {
          const validIds = new Set(nextItems.map((item) => item.relpath || item.id));
          const nextSelected = new Set(
            Array.from(selectionRef.value).filter((id) => validIds.has(id))
          );
          selectionRef.value = nextSelected;
        };

        const applyConfig = (config) => {
          if (!config || typeof config !== "object") {
            return;
          }
          if (Array.isArray(config.allowed_extensions) && config.allowed_extensions.length) {
            extensions.value = config.allowed_extensions.map((ext) =>
              ext.startsWith(".") ? ext.slice(1) : ext
            );
          }
          if (Number.isFinite(config.list_limit)) {
            listLimit.value = config.list_limit;
          }
          if (Number.isFinite(config.poll_seconds)) {
            pollSeconds.value = config.poll_seconds;
          }
          if (typeof config.recursive === "boolean") {
            recursive.value = config.recursive;
          }
          if (Number.isFinite(config.scan_depth)) {
            scanDepth.value = config.scan_depth;
          } else if (config.scan_depth === null) {
            scanDepth.value = null;
          }
          if (typeof config.default_delete_mode === "string") {
            deleteMode.value = config.default_delete_mode;
          }
          if (Array.isArray(config.thumbnail_size) && config.thumbnail_size.length) {
            const size = Number(config.thumbnail_size[0]);
            if (Number.isFinite(size)) {
              thumbnailSize.value = size;
            }
          } else if (Number.isFinite(config.thumbnail_size)) {
            thumbnailSize.value = Number(config.thumbnail_size);
          }
        };

        const applySettingOverrides = () => {
          const rawExtensions = getSetting(
            appInstance,
            SETTINGS.extensions,
            extensions.value.join(",")
          );
          if (typeof rawExtensions === "string") {
            extensions.value = rawExtensions
              .split(",")
              .map((ext) => ext.trim())
              .filter(Boolean)
              .map((ext) => (ext.startsWith(".") ? ext.slice(1) : ext));
          }
          const listLimitValue = Number(getSetting(appInstance, SETTINGS.listLimit, listLimit.value));
          if (Number.isFinite(listLimitValue) && listLimitValue > 0) {
            listLimit.value = listLimitValue;
          }
          const pollSecondsValue = Number(
            getSetting(appInstance, SETTINGS.pollSeconds, pollSeconds.value)
          );
          if (Number.isFinite(pollSecondsValue) && pollSecondsValue > 0) {
            pollSeconds.value = pollSecondsValue;
          }
          const scanDepthValue = Number(
            getSetting(appInstance, SETTINGS.scanDepth, scanDepth.value ?? -1)
          );
          scanDepth.value = Number.isFinite(scanDepthValue) && scanDepthValue >= 0 ? scanDepthValue : null;
          const recursiveValue = getSetting(appInstance, SETTINGS.recursive, recursive.value);
          if (typeof recursiveValue === "boolean") {
            recursive.value = recursiveValue;
          }
          const deleteModeValue = getSetting(appInstance, SETTINGS.deleteMode, deleteMode.value);
          if (typeof deleteModeValue === "string") {
            deleteMode.value = deleteModeValue;
          }
          const thumbValue = Number(
            getSetting(appInstance, SETTINGS.thumbnailSize, thumbnailSize.value)
          );
          if (Number.isFinite(thumbValue) && thumbValue > 0) {
            thumbnailSize.value = thumbValue;
          }
        };

        const refreshConfig = async () => {
          try {
            const config = await fetchConfig();
            applyConfig(config);
            applySettingOverrides();
          } catch (err) {
            console.warn("Assets+: failed to load config", err);
          }
        };

        const registerSettingListeners = () => {
          if (settingListenersRegistered) {
            return;
          }
          const settings = appInstance?.ui?.settings;
          if (!settings?.addEventListener) {
            return;
          }
          settings.addEventListener(`${SETTINGS.pollSeconds}.change`, (event) => {
            const value = Number(event?.detail?.value);
            if (Number.isFinite(value) && value > 0) {
              pollSeconds.value = value;
            }
          });
          settings.addEventListener(`${SETTINGS.deleteMode}.change`, (event) => {
            const value = event?.detail?.value;
            if (typeof value === "string") {
              deleteMode.value = value;
            }
          });
          settings.addEventListener(`${SETTINGS.recursive}.change`, (event) => {
            const value = event?.detail?.value;
            if (typeof value === "boolean") {
              recursive.value = value;
            }
          });
          settings.addEventListener(`${SETTINGS.scanDepth}.change`, (event) => {
            const value = Number(event?.detail?.value);
            scanDepth.value = Number.isFinite(value) && value >= 0 ? value : null;
          });
          settings.addEventListener(`${SETTINGS.listLimit}.change`, (event) => {
            const value = Number(event?.detail?.value);
            if (Number.isFinite(value) && value > 0) {
              listLimit.value = value;
            }
          });
          settings.addEventListener(`${SETTINGS.thumbnailSize}.change`, (event) => {
            const value = Number(event?.detail?.value);
            if (Number.isFinite(value) && value > 0) {
              thumbnailSize.value = value;
            }
          });
          settings.addEventListener(`${SETTINGS.extensions}.change`, (event) => {
            const value = event?.detail?.value;
            if (typeof value === "string") {
              extensions.value = value
                .split(",")
                .map((ext) => ext.trim())
                .filter(Boolean)
                .map((ext) => (ext.startsWith(".") ? ext.slice(1) : ext));
            }
          });
          settingListenersRegistered = true;
        };

        const fetchOutputList = async () => {
          isLoadingOutput.value = true;
          error.value = "";
          try {
            const data = await fetchList({
              limit: listLimit.value,
              extensions: extensions.value,
              recursive: recursive.value,
              scanDepth: scanDepth.value,
            });
            outputItems.value = data.items || [];
            cursor.value = data.cursor ?? null;
            hasMoreOutput.value = Boolean(cursor.value) && (data.items?.length ?? 0) >= listLimit.value;
            syncSelection(outputItems.value, outputSelection);
          } catch (err) {
            console.error(err);
            error.value = "Не удалось загрузить ассеты.";
          } finally {
            isLoadingOutput.value = false;
          }
        };

        const fetchInputList = async () => {
          isLoadingInput.value = true;
          error.value = "";
          try {
            const data = await fetchInputFiles(appInstance);
            inputItems.value = (Array.isArray(data) ? data : []).map((relpath) => ({
              relpath,
              filename: relpath.split("/").pop() ?? relpath,
              mtime: 0,
              size: 0,
              type: inferMediaType(relpath),
              has_workflow: false,
            }));
            syncSelection(inputItems.value, inputSelection);
          } catch (err) {
            console.error(err);
            error.value = "Не удалось загрузить импортированные ассеты.";
          } finally {
            isLoadingInput.value = false;
          }
        };

        const refreshActiveTab = async () => {
          if (activeTab.value === "output") {
            await fetchOutputList();
          } else {
            await fetchInputList();
          }
        };

        const loadMore = async () => {
          if (activeTab.value !== "output") {
            return;
          }
          if (isLoadingMore.value || !hasMoreOutput.value) {
            return;
          }
          isLoadingMore.value = true;
          try {
            const data = await fetchList({
              cursor: cursor.value,
              limit: listLimit.value,
              extensions: extensions.value,
              recursive: recursive.value,
              scanDepth: scanDepth.value,
            });
            const nextItems = data.items || [];
            outputItems.value = outputItems.value.concat(nextItems);
            cursor.value = data.cursor ?? null;
            hasMoreOutput.value = Boolean(cursor.value) && nextItems.length >= listLimit.value;
            syncSelection(outputItems.value, outputSelection);
          } catch (err) {
            console.error(err);
            showToast(appInstance, {
              severity: "error",
              summary: "Assets+",
              detail: "Не удалось подгрузить ассеты.",
              life: 3000,
            });
          } finally {
            isLoadingMore.value = false;
          }
        };

        const mergeNewItems = (nextItems) => {
          if (!nextItems.length) {
            return;
          }
          const existing = new Set(outputItems.value.map((item) => item.relpath));
          const uniqueNew = nextItems.filter((item) => !existing.has(item.relpath));
          if (uniqueNew.length) {
            outputItems.value = uniqueNew.concat(outputItems.value);
          }
        };

        const pollForUpdates = async () => {
          if (activeTab.value !== "output") {
            return;
          }
          if (!cursor.value) {
            await fetchOutputList();
            return;
          }
          try {
            const data = await fetchList({
              cursor: cursor.value,
              limit: listLimit.value,
              extensions: extensions.value,
              recursive: recursive.value,
              scanDepth: scanDepth.value,
            });
            const nextItems = data.items || [];
            mergeNewItems(nextItems);
            cursor.value = data.cursor ?? cursor.value;
            syncSelection(outputItems.value, outputSelection);
          } catch (err) {
            console.error(err);
          }
        };

        const assets = computed(() => {
          const source = activeTab.value === "output" ? "output" : "input";
          const list = source === "output" ? outputItems.value : inputItems.value;
          return (list || []).map((item) => {
            const relpath = item.relpath;
            const previewUrl =
              source === "output"
                ? buildThumbUrl(relpath, thumbnailSize.value)
                : buildViewUrl(relpath, "input");
            return {
              id: relpath,
              name: relpath,
              size: item.size || 0,
              created_at: item.mtime ? new Date(item.mtime * 1000).toISOString() : new Date().toISOString(),
              tags: [source],
              preview_url: previewUrl,
              user_metadata: {
                relpath,
                mtime: item.mtime,
                size: item.size,
                type: item.type,
                has_workflow: item.has_workflow,
                source,
              },
            };
          });
        });

        const filteredAssets = computed(() => {
          const query = searchQuery.value.trim().toLowerCase();
          let result = assets.value;
          if (query) {
            result = result.filter((asset) => asset.name.toLowerCase().includes(query));
          }
          if (mediaTypeFilters.value.length) {
            result = result.filter((asset) =>
              mediaTypeFilters.value.includes(asset.user_metadata?.type || "image")
            );
          }
          return result;
        });

        const sortedAssets = computed(() => {
          const sorted = [...filteredAssets.value];
          sorted.sort((a, b) => {
            const aTime = a.user_metadata?.mtime ?? 0;
            const bTime = b.user_metadata?.mtime ?? 0;
            if (sortBy.value === "oldest") {
              return aTime - bTime;
            }
            return bTime - aTime;
          });
          return sorted;
        });

        const displayAssets = computed(() => sortedAssets.value);

        const mediaAssetsWithKey = computed(() =>
          displayAssets.value.map((asset) => ({ ...asset, key: asset.id }))
        );

        const galleryItems = computed(() => displayAssets.value.map(buildGalleryItem));

        const hasSelection = computed(() => selectedIds.value.size > 0);

        const selectedAssets = computed(() =>
          displayAssets.value.filter((asset) => selectedIds.value.has(asset.id))
        );

        const totalOutputCount = computed(() => selectedIds.value.size);

        const hasSingleSelection = computed(() => selectedAssets.value.length === 1);

        const workflowMetadataCache = new Map();
        const selectedWorkflowAvailable = ref(false);

        const resolveWorkflowFromAsset = (asset) => {
          if (!asset) return null;
          const directWorkflow = asset.user_metadata?.workflow;
          if (directWorkflow) {
            return normalizeWorkflow(directWorkflow);
          }
          const cached = workflowMetadataCache.get(asset.id);
          if (cached?.workflow) {
            return normalizeWorkflow(cached.workflow);
          }
          return null;
        };

        const refreshWorkflowAvailability = async (asset) => {
          if (!asset || asset.user_metadata?.source !== "output") {
            selectedWorkflowAvailable.value = false;
            return;
          }
          const cachedWorkflow = resolveWorkflowFromAsset(asset);
          if (cachedWorkflow) {
            selectedWorkflowAvailable.value = true;
            return;
          }
          if (asset.user_metadata?.has_workflow === false) {
            selectedWorkflowAvailable.value = false;
            return;
          }
          try {
            const payload = await fetchMetadata(asset.id);
            const metadata = payload?.metadata ?? {};
            workflowMetadataCache.set(asset.id, metadata);
            selectedWorkflowAvailable.value = Boolean(normalizeWorkflow(metadata.workflow));
          } catch (error) {
            console.error(error);
            selectedWorkflowAvailable.value = false;
          }
        };

        const selectedAssetHasWorkflow = computed(
          () => hasSingleSelection.value && selectedWorkflowAvailable.value
        );

        const isSelected = (assetId) => selectedIds.value.has(assetId);

        const toggleSelection = (asset) => {
          const selectionRef = activeTab.value === "output" ? outputSelection : inputSelection;
          const next = new Set(selectionRef.value);
          if (next.has(asset.id)) {
            next.delete(asset.id);
          } else {
            next.add(asset.id);
          }
          selectionRef.value = next;
        };

        const clearSelection = () => {
          outputSelection.value = new Set();
          inputSelection.value = new Set();
        };

        const handleAssetSelect = (asset) => {
          toggleSelection(asset);
        };

        const handleEmptySpaceClick = (event) => {
          const target = event.target;
          if (target?.closest?.("[data-asset-card]")) {
            return;
          }
          clearSelection();
        };

        const handleZoomClick = (asset) => {
          const index = displayAssets.value.findIndex((item) => item.id === asset.id);
          if (index >= 0) {
            galleryActiveIndex.value = index;
          }
        };

        const confirmDeleteSelected = async () => {
          if (!selectedAssets.value.length) {
            return false;
          }
          const mode = deleteMode.value;
          const dialogService = appInstance?.extensionManager?.dialog;
          const message =
            mode === "hide"
              ? "Скрыть выбранные ассеты из списка?"
              : "Удалить выбранные ассеты с диска?";
          const itemList = selectedAssets.value.map((asset) => asset.name);
          if (dialogService?.confirm) {
            const result = await dialogService.confirm({
              title: "Подтверждение удаления",
              message,
              type: mode === "hide" ? "default" : "delete",
              itemList,
            });
            return result === true;
          }
          return window.confirm(message);
        };

        const handleDeleteSelected = async () => {
          if (activeTab.value !== "output") {
            return;
          }
          const confirmed = await confirmDeleteSelected();
          if (!confirmed) {
            return;
          }
          try {
            const relpaths = selectedAssets.value.map((asset) => asset.id);
            const mode = deleteMode.value;
            await deleteAssets(relpaths, mode);
            outputItems.value = outputItems.value.filter((item) => !relpaths.includes(item.relpath));
            clearSelection();
            await fetchOutputList();
          } catch (err) {
            console.error(err);
            showToast(appInstance, {
              severity: "error",
              summary: "Assets+",
              detail: "Не удалось удалить ассеты.",
              life: 3000,
            });
          }
        };

        const triggerDownload = (url, filename) => {
          const link = document.createElement("a");
          link.href = url;
          link.download = filename;
          link.rel = "noopener";
          link.target = "_blank";
          document.body.appendChild(link);
          link.click();
          link.remove();
        };

        const handleDownloadSelected = () => {
          selectedAssets.value.forEach((asset) => {
            const type = asset.user_metadata?.source === "input" ? "input" : "output";
            triggerDownload(buildViewUrl(asset.id, type), asset.name);
          });
        };

        const openWorkflow = async (replaceCurrent) => {
          if (!hasSingleSelection.value || activeTab.value !== "output") {
            return;
          }
          const asset = selectedAssets.value[0];
          try {
            const { workflow, filename } = await extractWorkflowFromAsset(asset, {
              fetchMetadataFallback: async (relpath) => {
                const payload = await fetchMetadata(relpath);
                const metadata = payload?.metadata ?? {};
                workflowMetadataCache.set(relpath, metadata);
                return metadata;
              },
            });
            if (!workflow) {
              showToast(appInstance, {
                severity: "warn",
                summary: "Assets+",
                detail: "Workflow metadata не найдена.",
                life: 2500,
              });
              return;
            }
            if (replaceCurrent) {
              const workflowStore = resolveWorkflowStore(appInstance);
              const activeWorkflow = workflowStore?.activeWorkflow ?? null;
              await appInstance?.loadGraphData?.(workflow, true, true, activeWorkflow);
              showToast(appInstance, {
                severity: "success",
                summary: "Assets+",
                detail: "Workflow заменён в текущей вкладке.",
                life: 2000,
              });
              return;
            }
            const workflowActions = resolveWorkflowActionsService(appInstance);
            if (workflowActions?.openWorkflowAction) {
              const result = await workflowActions.openWorkflowAction(workflow, filename);
              if (!result?.success) {
                throw new Error(result?.error || "Failed to open workflow");
              }
              showToast(appInstance, {
                severity: "success",
                summary: "Assets+",
                detail: "Workflow открыт в новой вкладке.",
                life: 2000,
              });
              return;
            }
            const workflowStore = resolveWorkflowStore(appInstance);
            if (workflowStore?.createTemporary && workflowStore?.openWorkflow) {
              const temp = workflowStore.createTemporary(filename, workflow);
              await workflowStore.openWorkflow(temp);
              showToast(appInstance, {
                severity: "success",
                summary: "Assets+",
                detail: "Workflow открыт в новой вкладке.",
                life: 2000,
              });
              return;
            }
            await appInstance?.loadGraphData?.(workflow);
          } catch (err) {
            console.error(err);
            showToast(appInstance, {
              severity: "error",
              summary: "Assets+",
              detail: "Не удалось открыть workflow.",
              life: 3000,
            });
          }
        };

        const handleApproachEnd = async () => {
          if (activeTab.value === "output") {
            await loadMore();
          }
        };

        onMounted(async () => {
          await refreshConfig();
          registerSettingListeners();
          const activeId = resolveActiveTabId();
          const shouldAssumeActive = activeId === null;
          setActiveState(shouldAssumeActive || activeId === SIDEBAR_TAB_ID);
        });

        onActivated(() => {
          setActiveState(true);
        });

        onDeactivated(() => {
          setActiveState(false);
        });

        onBeforeUnmount(() => {
          stopPolling();
        });

        watch(
          () => resolveActiveTabId(),
          (nextId) => {
            if (nextId === null) {
              return;
            }
            setActiveState(nextId === SIDEBAR_TAB_ID);
          }
        );

        watch(
          () => pollSeconds.value,
          () => {
            if (activeTab.value === "output") {
              stopPolling();
              startPolling();
            }
          }
        );

        watch(
          () => activeTab.value,
          async (nextTab) => {
            if (nextTab === "output") {
              await fetchOutputList();
              startPolling();
            } else {
              stopPolling();
              await fetchInputList();
            }
          }
        );

        watch(
          () => (hasSingleSelection.value ? selectedAssets.value[0]?.id : null),
          async (nextId) => {
            if (!nextId) {
              selectedWorkflowAvailable.value = false;
              return;
            }
            await refreshWorkflowAvailability(selectedAssets.value[0]);
          }
        );

        return {
          hasTabs,
          hasNoResultsPlaceholder,
          activeTab,
          isLoadingOutput,
          isLoadingInput,
          isLoadingMore,
          hasMoreOutput,
          error,
          deleteMode,
          searchQuery,
          sortBy,
          mediaTypeFilters,
          openContextMenuId,
          mediaAssetsWithKey,
          displayAssets,
          galleryActiveIndex,
          galleryItems,
          hasSelection,
          hasSingleSelection,
          selectedAssetHasWorkflow,
          totalOutputCount,
          refreshActiveTab,
          handleApproachEnd,
          handleAssetSelect,
          handleZoomClick,
          handleEmptySpaceClick,
          handleDeleteSelected,
          handleDownloadSelected,
          openWorkflow,
          isSelected,
        };
      },
      template: `
        <SidebarTabTemplate :title="$t('sideToolbar.mediaAssets.title')">
          <template #tool-buttons>
            <div class="flex items-center gap-2">
              <TabList v-if="hasTabs" v-model="activeTab">
                <Tab class="font-inter" value="output">Generated+</Tab>
                <Tab class="font-inter" value="input">Imported</Tab>
              </TabList>
              <button
                class="rounded-md border border-transparent bg-secondary-background px-3 py-1 text-xs"
                type="button"
                @click="refreshActiveTab"
                :disabled="activeTab === 'output' ? isLoadingOutput : isLoadingInput"
              >
                Refresh
              </button>
            </div>
          </template>
          <template #header>
            <div class="flex items-center justify-between gap-2 px-2 pb-2 2xl:px-4">
              <MediaAssetFilterBar
                v-model:search-query="searchQuery"
                v-model:sort-by="sortBy"
                v-model:media-type-filters="mediaTypeFilters"
                :show-generation-time-sort="activeTab === 'output'"
              />
              <select
                v-if="activeTab === 'output'"
                class="rounded-md border border-secondary-border bg-transparent px-2 py-1 text-xs"
                v-model="deleteMode"
              >
                <option value="trash">Delete to Trash</option>
                <option value="delete">Delete Permanently</option>
                <option value="hide">Hide Only</option>
              </select>
            </div>
            <div class="border-b border-secondary-border" />
          </template>
          <template #body>
            <div v-if="(activeTab === 'output' ? isLoadingOutput : isLoadingInput) && !displayAssets.length">
              <ProgressSpinner class="absolute left-1/2 w-[50px] -translate-x-1/2" />
            </div>
            <div
              v-else-if="!displayAssets.length && !(activeTab === 'output' ? isLoadingOutput : isLoadingInput)"
              class="px-4 py-3 text-sm text-muted-foreground"
            >
              <NoResultsPlaceholder
                v-if="hasNoResultsPlaceholder"
                icon="pi pi-info-circle"
                :title="activeTab === 'input' ? 'Нет импортированных файлов.' : 'Нет сгенерированных файлов.'"
                message="Файлы не найдены."
              />
              <span v-else>Нет ассетов.</span>
            </div>
            <div v-else class="relative size-full" @click="handleEmptySpaceClick">
              <VirtualGrid
                :items="mediaAssetsWithKey"
                :grid-style="{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
                  padding: '0 0.5rem',
                  gap: '0.5rem'
                }"
                @approach-end="handleApproachEnd"
              >
                <template #item="{ item }">
                  <div data-asset-card>
                    <MediaAssetCard
                      :asset="item"
                      :selected="isSelected(item.id)"
                      :show-output-count="false"
                      :show-delete-button="false"
                      :open-context-menu-id="openContextMenuId"
                      @click="handleAssetSelect(item)"
                      @zoom="handleZoomClick(item)"
                      @context-menu-opened="openContextMenuId = item.id"
                    />
                  </div>
                </template>
              </VirtualGrid>
              <div v-if="isLoadingMore" class="px-4 py-3 text-xs text-muted-foreground">
                Загружаем ещё...
              </div>
            </div>
          </template>
          <template #footer>
            <div
              v-if="hasSelection"
              class="flex h-18 items-center justify-between gap-2 border-t border-secondary-border px-4"
            >
              <div class="text-sm text-muted-foreground">
                Выбрано: {{ totalOutputCount }}
              </div>
              <div class="flex flex-wrap gap-2">
                <button
                  class="rounded-md border border-secondary-border bg-secondary-background px-3 py-1 text-xs"
                  type="button"
                  @click="handleDownloadSelected"
                >
                  Скачать
                </button>
                <button
                  v-if="activeTab === 'output'"
                  class="rounded-md border border-secondary-border bg-secondary-background px-3 py-1 text-xs"
                  type="button"
                  @click="handleDeleteSelected"
                >
                  Удалить
                </button>
                <button
                  v-if="activeTab === 'output' && hasSingleSelection"
                  class="rounded-md border border-secondary-border bg-secondary-background px-3 py-1 text-xs"
                  type="button"
                  :disabled="!selectedAssetHasWorkflow"
                  @click="openWorkflow(false)"
                >
                  Open workflow (new tab)
                </button>
                <button
                  v-if="activeTab === 'output' && hasSingleSelection"
                  class="rounded-md border border-secondary-border bg-secondary-background px-3 py-1 text-xs"
                  type="button"
                  :disabled="!selectedAssetHasWorkflow"
                  @click="openWorkflow(true)"
                >
                  Replace current workflow
                </button>
              </div>
            </div>
          </template>
        </SidebarTabTemplate>

        <ResultGallery
          v-model:active-index="galleryActiveIndex"
          :all-gallery-items="galleryItems"
        />
      `,
    };

    return markRaw(component);
  }

  function registerExtension() {
    const app = getApp();
    if (!app?.registerExtension) {
      setTimeout(registerExtension, 100);
      return;
    }

    app.registerExtension({
      name: EXTENSION_NAME,
      async setup(appInstance) {
        const vue = getVue();
        if (!vue?.markRaw) {
          console.warn("Assets+: Vue is not available, sidebar tab not registered.");
          return;
        }
        if (!appInstance?.extensionManager?.registerSidebarTab) {
          console.warn("Assets+: extensionManager.registerSidebarTab is not available.");
          return;
        }

        try {
          const config = await fetchConfig();
          registerSettings(appInstance, config);
        } catch (error) {
          registerSettings(appInstance, {});
        }

        const component = createAssetsPlusComponent(appInstance, vue);
        if (appInstance.extensionManager.unregisterSidebarTab) {
          appInstance.extensionManager.unregisterSidebarTab("assets");
        }

        appInstance.extensionManager.registerSidebarTab({
          id: "assets",
          icon: "icon-[comfy--image-ai-edit]",
          title: "sideToolbar.assets",
          tooltip: "sideToolbar.assets",
          label: "sideToolbar.labels.assets",
          component,
          type: "vue",
        });
      },
    });
  }

  registerExtension();
})();
