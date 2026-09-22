import { SETTINGS, SETTINGS_CATEGORY, THUMB_QUALITY_SIZES,
         DEFAULT_LIST_LIMIT, DEFAULT_THUMB_QUALITY, DEFAULT_DELETE_MODE,
         DEFAULT_CONFIRM_DELETE, DEFAULT_SHOW_OVERLAY_HELP,
         DEFAULT_KEEP_OVERLAY_OPEN_ON_WORKFLOW, DEFAULT_LANGUAGE,
         applySettingsCategory } from './constants.js';
import { createSettingsButtonRenderer, resolveThumbnailQuality } from './utils.js';

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

export { buildSettingsSchema };
