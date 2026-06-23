import { EXTENSION_NAME, SIDEBAR_TAB_ID, OVERLAY_COMMANDS, OVERLAY_KEYBINDINGS,
         SETTINGS, DEFAULT_LANGUAGE, ASSETS_PLUS_SHORTCUTS_CATEGORY } from './constants.js';
import { log, warn, waitForApp, fetchJson, getSettingValue, createStyleTag } from './utils.js';
import { t, loadTranslationsList, loadTranslationData, buildLanguageOptions, applyLanguage,
         setOnLanguageChange, activeLanguage } from './i18n.js';
import { buildSettingsSchema } from './settings.js';
import { buildShortcutsPanelTab } from './shortcuts-panel.js';
import { AssetsPlusExplorer } from './explorer.js';

let explorerInstance = null;
let shortcutsPanelInstance = null;

function registerSidebarTab(appInstance) {
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
}

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

let booted = false;

const boot = async () => {
  if (booted) return;
  booted = true;
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

setOnLanguageChange(() => {
  explorerInstance?.updateTranslations?.();
  shortcutsPanelInstance?.updateTranslations?.();
});

boot();
