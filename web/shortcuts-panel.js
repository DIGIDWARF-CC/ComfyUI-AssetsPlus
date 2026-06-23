import {
  ASSETS_PLUS_SHORTCUTS_TAB_ID,
  ASSETS_PLUS_SHORTCUTS_CATEGORY,
  ASSETS_PLUS_SHORTCUTS_SUBCATEGORY,
  ASSETS_PLUS_SHORTCUTS_TAB_CLASS,
  OVERLAY_COMMANDS,
  formatShortcutKey,
  getKeySequences
} from './constants.js';
import { log, createElement } from './utils.js';
import { t } from './i18n.js';

let shortcutsPanelInstance = null;

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
      "shortcut-item assets-plus-shortcut-row";

    const info = document.createElement("div");
    info.className = "shortcut-info assets-plus-shortcut-info";
    const name = document.createElement("div");
    name.className = "shortcut-name assets-plus-shortcut-name";
    name.textContent = command?.label || command?.id || "";
    info.append(name);

    const keybindingDisplay = document.createElement("div");
    keybindingDisplay.className = "keybinding-display assets-plus-keybinding-display";
    const keybindingCombo = document.createElement("div");
    keybindingCombo.className = "keybinding-combo assets-plus-keybinding-combo";
    keybindingCombo.setAttribute("aria-label", `Keyboard shortcut: ${sequences.join(" + ")}`);

    sequences.forEach((key) => {
      const badge = document.createElement("span");
      badge.className =
        "key-badge assets-plus-key-badge";
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
    content.className = "assets-plus-shortcuts-content";

    const scroll = document.createElement("div");
    scroll.className = "assets-plus-shortcuts-scroll";

    const shortcutsList = document.createElement("div");
    shortcutsList.className = `shortcuts-list flex justify-center ${ASSETS_PLUS_SHORTCUTS_TAB_CLASS}`;

    const grid = document.createElement("div");
    grid.className = "assets-plus-shortcuts-grid";

    const column = document.createElement("div");
    column.className = "assets-plus-shortcuts-column";

    const title = document.createElement("h3");
    title.className =
      "assets-plus-subcategory-title";
    title.textContent = t(`shortcuts.assets_plus.${ASSETS_PLUS_SHORTCUTS_SUBCATEGORY}`);

    const list = document.createElement("div");
    list.className = "assets-plus-shortcuts-list";

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

export { AssetsPlusShortcutsPanel, buildShortcutsPanelTab };
