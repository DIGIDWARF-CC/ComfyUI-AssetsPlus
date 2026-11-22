import { fetchJson, warn } from './utils.js';

/**
 * Settings entry with a check box per file format, grouped by kind.
 * The server keeps the choice (config.json); this only shows it and sends changes.
 *   t        translate function
 *   onSaved  called with the saved extension list after the server accepted a change
 *   onFailed called when the server refused or could not be reached
 */
export const createFormatsRenderer = (t, { onSaved, onFailed } = {}) => () => {
  const root = document.createElement("div");
  root.className = "assets-plus-formats";
  const note = document.createElement("div");
  note.className = "assets-plus-formats-note";
  note.textContent = t("settings.formats.loading");
  root.appendChild(note);

  const boxes = [];
  let saving = Promise.resolve();

  const selected = () => boxes.filter((box) => box.checked).map((box) => box.dataset.ext);

  const send = (changed) => {
    saving = saving.then(async () => {
      const previous = changed.checked;
      try {
        const result = await fetchJson("/assets_plus/extensions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ extensions: selected() }),
        });
        onSaved?.(result.allowed_extensions || []);
      } catch (error) {
        warn(t("log.formats_failed"), error);
        changed.checked = !previous;
        onFailed?.(error);
      }
    });
  };

  fetchJson("/assets_plus/config")
    .then((config) => {
      const enabled = new Set(config.allowed_extensions || []);
      root.textContent = "";
      for (const [group, extensions] of Object.entries(config.format_groups || {})) {
        const fieldset = document.createElement("fieldset");
        fieldset.className = "assets-plus-formats-group";
        const legend = document.createElement("legend");
        legend.textContent = t(`settings.formats.${group}`);
        fieldset.appendChild(legend);
        for (const ext of extensions) {
          const label = document.createElement("label");
          label.className = "assets-plus-formats-item";
          const box = document.createElement("input");
          box.type = "checkbox";
          box.dataset.ext = ext;
          box.checked = enabled.has(ext);
          box.addEventListener("change", () => send(box));
          boxes.push(box);
          label.append(box, document.createTextNode(ext));
          fieldset.appendChild(label);
        }
        root.appendChild(fieldset);
      }
    })
    .catch((error) => {
      warn(t("log.formats_failed"), error);
      note.textContent = t("settings.formats.unavailable");
    });

  return root;
};
