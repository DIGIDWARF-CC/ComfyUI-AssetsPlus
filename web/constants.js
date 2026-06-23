export const EXTENSION_NAME = "digidwarf.AssetsPlus";
export const SIDEBAR_TAB_ID = "assets-plus-explorer";
export const OUTPUT_TAB = "output";
export const INPUT_TAB = "input";
export const DEFAULT_EXTENSIONS = [
  "png", "jpg", "jpeg", "webp", "gif", "bmp", "tiff",
  "mp4", "webm", "mov", "mkv",
  "mp3", "flac", "wav", "ogg", "m4a",
  "glb", "gltf",
];
export const VIDEO_THUMB_EXTENSIONS = new Set(["mp4", "webm"]);
export const DEFAULT_LIST_LIMIT = 200;
export const DEFAULT_THUMB_QUALITY = "low";
export const THUMB_QUALITY_SIZES = {
  low: 256,
  high: 512,
};
export const DEFAULT_DELETE_MODE = "trash";
export const DEFAULT_CONFIRM_DELETE = true;
export const DEFAULT_SHOW_OVERLAY_HELP = true;
export const DEFAULT_KEEP_OVERLAY_OPEN_ON_WORKFLOW = false;
export const DEFAULT_LANGUAGE = "en";
export const SETTINGS_CATEGORY = "Assets+";
export const ASSETS_PLUS_SHORTCUTS_CATEGORY = "assets-plus";
export const ASSETS_PLUS_SHORTCUTS_TAB_ID = "shortcuts-assets-plus";
export const ASSETS_PLUS_SHORTCUTS_TAB_CLASS = "assets-plus";
export const ASSETS_PLUS_SHORTCUTS_SUBCATEGORY = "overlay";

export const OVERLAY_COMMANDS = {
  first: "AssetsPlus.OverlayNavigateFirst",
  prev: "AssetsPlus.OverlayNavigatePrevious",
  last: "AssetsPlus.OverlayNavigateLast",
  next: "AssetsPlus.OverlayNavigateNext",
  delete: "AssetsPlus.OverlayDelete",
};

export const OVERLAY_KEYBINDINGS = [
  {
    commandId: OVERLAY_COMMANDS.prev,
    combo: { key: "ArrowLeft" },
  },
  {
    commandId: OVERLAY_COMMANDS.next,
    combo: { key: "ArrowRight" },
  },
  {
    commandId: OVERLAY_COMMANDS.last,
    combo: { key: "ArrowDown" },
  },
  {
    commandId: OVERLAY_COMMANDS.delete,
    combo: { key: "x" },
  },
  {
    commandId: "Workspace.ToggleSidebarTab.assets-plus-explorer",
    combo: { key: "ArrowUp" },
  },
];

export const SETTINGS = {
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

export const SHORTCUT_KEY_LABELS = {
  Control: "Ctrl",
  Meta: "Cmd",
  ArrowUp: "\u2191",
  ArrowDown: "\u2193",
  ArrowLeft: "\u2190",
  ArrowRight: "\u2192",
  Backspace: "\u232B",
  Delete: "\u2326",
  Enter: "\u21B5",
  Escape: "Esc",
  Tab: "\u21E5",
  " ": "Space",
};

export const applySettingsCategory = (setting, groupLabel) => ({
  ...setting,
  category: [SETTINGS_CATEGORY, groupLabel, setting.id],
});

export const formatShortcutKey = (key) => SHORTCUT_KEY_LABELS[key] || key;

export const getKeySequences = (keybinding) => {
  if (!keybinding?.combo) return [];
  if (typeof keybinding.combo.getKeySequences === "function") return keybinding.combo.getKeySequences();
  return keybinding.combo.key ? [keybinding.combo.key] : [];
};
