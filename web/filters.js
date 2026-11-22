import { createElement, fetchJson, warn } from './utils.js';
import { t } from './i18n.js';
import { createPopover } from './popover.js';
import {
  allGroups, groupOf, edgesFor, countsByGroup, calendarRange, yearRange, monthRange, dayRange, daysInMonth,
} from './dategroups.js';

/*
 * Filters (type, only starred), the calendar and the date groups of the gallery, in the manner of the Windows Explorer.
 * Mixed into AssetsPlusExplorer. Filters live in the page only (they are not remembered after a reload, so a
 * forgotten filter never makes the gallery look empty); "group by date" is remembered like the view mode.
 */

export const TYPE_ORDER = ["images", "video", "audio", "mesh"];
export const GROUP_BY_DATE_STORAGE_KEY = "assetsPlus.groupByDate";

export const loadGroupByDate = () => {
  try {
    return window.localStorage?.getItem(GROUP_BY_DATE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
};

const emptyCalendar = () => ({ year: null, month: null, day: null });

const checkboxRow = (label, checked, onChange, { disabled = false } = {}) => {
  const row = createElement("label", { className: "assets-plus-popover-row" });
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = checked;
  box.disabled = disabled;
  box.addEventListener("change", () => onChange(box.checked, box));
  row.append(box, createElement("span", { text: label }));
  return row;
};

const monthName = (month) =>
  new Intl.DateTimeFormat(undefined, { month: "long" }).format(new Date(2000, month, 1));

export const filtersAPI = {
  /** Fresh filter state; called once from the constructor. */
  initFilterState() {
    Object.assign(this.state, {
      types: new Set(TYPE_ORDER),
      starredOnly: false,
      calendar: emptyCalendar(),
      groupByDate: loadGroupByDate(),
      selectedGroups: new Set(),
      groupAnchor: null,
      offscreen: new Map(), // selected items the gallery has not loaded (a whole date group is selected by range)
    });
    this.groups = [];
    this.groupLastKey = null;
    this.groupCounts = new Map();
    this.calendarOptions = { years: [], months: [], days: [] };
  },

  initFilterUi() {
    const { filterButton, dateButton } = this.elements;
    this.filterPopover = createPopover({
      button: filterButton,
      render: (list) => this.renderFilterMenu(list),
      className: "assets-plus-filter-menu",
    });
    this.datePopover = createPopover({
      button: dateButton,
      render: (list) => this.renderDateMenu(list),
      className: "assets-plus-date-menu",
    });
    filterButton.addEventListener("click", (event) => {
      event.stopPropagation();
      this.closeContextMenu();
      this.closeViewMenu();
      this.datePopover.close();
      this.filterPopover.toggle();
    });
    dateButton.addEventListener("click", (event) => {
      event.stopPropagation();
      this.closeContextMenu();
      this.closeViewMenu();
      this.filterPopover.close();
      if (!this.datePopover.isOpen()) this.refreshCalendarOptions();
      this.datePopover.toggle();
    });
    this.updateFilterIndicators();
  },

  destroyFilterUi() {
    this.filterPopover?.destroy();
    this.datePopover?.destroy();
  },

  /** A click outside closes the popovers it did not land in. */
  closeFilterPopovers(target) {
    [this.filterPopover, this.datePopover].forEach((popover) => {
      if (popover && !(target && popover.contains(target))) popover.close();
    });
  },

  // --- what the filters mean for a request ----------------------------------------------------------------

  typeFilterActive() {
    return this.state.types.size < this.availableTypeGroups().length;
  },

  calendarActive() {
    return calendarRange(this.state.calendar) !== null;
  },

  isFiltered() {
    return this.typeFilterActive() || this.state.starredOnly || this.calendarActive();
  },

  /** Groups of formats that have at least one format switched on in the settings. */
  availableTypeGroups() {
    const groups = this.state.config?.format_groups || {};
    const enabled = new Set(this.state.config?.allowed_extensions || []);
    const available = TYPE_ORDER.filter((name) => (groups[name] || []).some((ext) => enabled.has(ext)));
    return available.length ? available : TYPE_ORDER;
  },

  /** The enabled extensions (without dots) narrowed to the chosen types. */
  activeExtensions(extensions) {
    if (!this.typeFilterActive()) return extensions;
    const groups = this.state.config?.format_groups || {};
    const wanted = new Set();
    this.state.types.forEach((name) => (groups[name] || []).forEach((ext) => wanted.add(ext.replace(/^\./, ""))));
    const narrowed = extensions.filter((ext) => wanted.has(ext));
    return narrowed.length ? narrowed : extensions;
  },

  /** Show starred first only when the gallery is not cut into date groups (the two orders contradict each other). */
  useStarredFirst() {
    return Boolean(this.getSettingsSnapshot().starredFirst) && !this.state.groupByDate;
  },

  /** Add the filters to a list request. */
  applyFilterParams(params, { withCalendar = true } = {}) {
    if (this.state.starredOnly) params.set("starred_only", "1");
    const range = withCalendar ? calendarRange(this.state.calendar) : null;
    if (range) {
      params.set("mtime_min", String(range[0]));
      params.set("mtime_max", String(range[1]));
    }
  },

  /** Parameters of a histogram request: the current filters (the calendar only when asked) and the edges. */
  buildHistogramParams(edges, { withCalendar = false } = {}) {
    const params = this.buildListParams();
    ["limit", "cursor", "since", "starred_first", "mtime_min", "mtime_max"].forEach((name) => params.delete(name));
    if (withCalendar) this.applyFilterParams(params);
    params.set("edges", edges.join(","));
    return params;
  },

  async fetchHistogram(edges, options) {
    const params = this.buildHistogramParams(edges, options);
    return fetchJson(`/assets_plus/${this.state.tab}/histogram?${params.toString()}`);
  },

  // --- changing filters -----------------------------------------------------------------------------------

  applyFilters() {
    this.updateFilterIndicators();
    this.renderChips();
    this.refreshList();
  },

  resetFilters() {
    this.state.types = new Set(TYPE_ORDER);
    this.state.starredOnly = false;
    this.state.calendar = emptyCalendar();
    this.filterPopover?.refresh();
    this.datePopover?.refresh();
    this.applyFilters();
  },

  toggleType(name, checked) {
    const next = new Set(this.state.types);
    if (checked) next.add(name);
    else next.delete(name);
    if (!next.size) {
      this.filterPopover.refresh(); // the last type cannot be switched off
      return;
    }
    // Choosing every available type is the same as no filter.
    this.state.types = this.availableTypeGroups().every((group) => next.has(group)) ? new Set(TYPE_ORDER) : next;
    this.filterPopover.refresh();
    this.applyFilters();
  },

  setStarredOnly(value) {
    this.state.starredOnly = Boolean(value);
    this.applyFilters();
  },

  setGroupByDate(value) {
    this.state.groupByDate = Boolean(value);
    try {
      window.localStorage?.setItem(GROUP_BY_DATE_STORAGE_KEY, value ? "1" : "0");
    } catch {
      // Lasts until the page is reloaded.
    }
    this.state.selectedGroups.clear();
    this.state.groupAnchor = null;
    this.updateFilterIndicators();
    // The order changes with it (starred-first is off while grouped), so the list is asked for again.
    this.refreshList();
  },

  setCalendar(calendar) {
    this.state.calendar = { ...emptyCalendar(), ...calendar };
    this.applyFilters();
    this.refreshCalendarOptions();
  },

  updateFilterIndicators() {
    const { filterButton, dateButton } = this.elements;
    const typeOrStar = this.typeFilterActive() || this.state.starredOnly;
    filterButton?.classList.toggle("has-filter", typeOrStar);
    dateButton?.classList.toggle("has-filter", this.calendarActive());
    dateButton?.classList.toggle("active", this.state.groupByDate || this.calendarActive());
  },

  // --- menus ----------------------------------------------------------------------------------------------

  renderFilterMenu(list) {
    list.innerHTML = "";
    list.appendChild(createElement("div", { className: "assets-plus-popover-title", text: t("filters.type") }));
    const available = this.availableTypeGroups();
    available.forEach((name) => {
      list.appendChild(
        checkboxRow(t(`settings.formats.${name}`), this.state.types.has(name), (checked) => this.toggleType(name, checked))
      );
    });
    list.appendChild(createElement("div", { className: "assets-plus-context-menu-separator" }));
    list.appendChild(
      checkboxRow(t("filters.starred_only"), this.state.starredOnly, (checked) => this.setStarredOnly(checked))
    );
    list.appendChild(createElement("div", { className: "assets-plus-context-menu-separator" }));
    const reset = createElement("button", { className: "assets-plus-context-menu-item", text: t("filters.reset") });
    reset.disabled = !this.isFiltered();
    reset.addEventListener("click", (event) => {
      event.stopPropagation();
      this.resetFilters();
    });
    list.appendChild(reset);
  },

  renderDateMenu(list) {
    list.innerHTML = "";
    list.appendChild(
      checkboxRow(t("date.group"), this.state.groupByDate, (checked) => this.setGroupByDate(checked))
    );
    list.appendChild(createElement("div", { className: "assets-plus-context-menu-separator" }));
    list.appendChild(createElement("div", { className: "assets-plus-popover-title", text: t("date.calendar") }));
    const calendar = this.state.calendar;
    const options = this.calendarOptions;
    const makeSelect = (labelKey, entries, current, format, onChange) => {
      const row = createElement("label", { className: "assets-plus-popover-row assets-plus-popover-select" });
      row.appendChild(createElement("span", { text: t(labelKey) }));
      const select = document.createElement("select");
      const any = document.createElement("option");
      any.value = "";
      any.textContent = t("date.any");
      select.appendChild(any);
      entries.forEach((entry) => {
        const option = document.createElement("option");
        option.value = String(entry.value);
        option.textContent = `${format(entry.value)} (${entry.count})`;
        select.appendChild(option);
      });
      if (current !== null && !entries.some((entry) => entry.value === current)) {
        const option = document.createElement("option");
        option.value = String(current);
        option.textContent = format(current);
        select.appendChild(option);
      }
      select.value = current === null ? "" : String(current);
      select.addEventListener("change", () => onChange(select.value === "" ? null : Number(select.value)));
      row.appendChild(select);
      return row;
    };
    list.appendChild(
      makeSelect("date.year", options.years, calendar.year, String, (year) => this.setCalendar({ year }))
    );
    if (calendar.year !== null) {
      list.appendChild(
        makeSelect("date.month", options.months, calendar.month, monthName, (month) =>
          this.setCalendar({ year: calendar.year, month })
        )
      );
    }
    if (calendar.month !== null) {
      list.appendChild(
        makeSelect("date.day", options.days, calendar.day, String, (day) =>
          this.setCalendar({ year: calendar.year, month: calendar.month, day })
        )
      );
    }
    const clear = createElement("button", { className: "assets-plus-context-menu-item", text: t("date.clear") });
    clear.disabled = !this.calendarActive();
    clear.addEventListener("click", (event) => {
      event.stopPropagation();
      this.setCalendar(emptyCalendar());
    });
    list.appendChild(clear);
  },

  /** Which years / months / days have files (under the other filters, ignoring the calendar itself). */
  async refreshCalendarOptions() {
    const ticket = (this.calendarTicket = (this.calendarTicket || 0) + 1);
    const options = { years: [], months: [], days: [] };
    try {
      const bounds = await this.fetchHistogram([]);
      if (bounds.min === null || bounds.max === null) {
        this.calendarOptions = options;
        this.datePopover?.refresh();
        return;
      }
      const first = new Date(bounds.min * 1000).getFullYear();
      const last = new Date(bounds.max * 1000).getFullYear();
      const years = [];
      for (let year = first; year <= last + 1; year += 1) years.push(year);
      const yearEdges = years.map((year) => yearRange(year)[0]);
      const byYear = await this.fetchHistogram(yearEdges);
      byYear.counts.forEach((count, index) => count > 0 && options.years.push({ value: years[index], count }));
      options.years.reverse();
      const { year, month } = this.state.calendar;
      if (year !== null) {
        const edges = Array.from({ length: 13 }, (_, index) => monthRange(year, index)[0]);
        const byMonth = await this.fetchHistogram(edges);
        byMonth.counts.forEach((count, index) => count > 0 && options.months.push({ value: index, count }));
      }
      if (year !== null && month !== null) {
        const total = daysInMonth(year, month);
        const edges = Array.from({ length: total + 1 }, (_, index) => dayRange(year, month, index + 1)[0]);
        const byDay = await this.fetchHistogram(edges);
        byDay.counts.forEach((count, index) => count > 0 && options.days.push({ value: index + 1, count }));
      }
    } catch (error) {
      warn(t("log.filters_failed"), error);
    }
    if (ticket !== this.calendarTicket) return;
    this.calendarOptions = options;
    this.datePopover?.refresh();
  },

  // --- chips: what is filtered right now, each removable ----------------------------------------------------

  renderChips() {
    const chips = this.elements.chips;
    if (!chips) return;
    chips.replaceChildren();
    const add = (label, remove) => {
      const chip = createElement("button", {
        className: "assets-plus-chip",
        attrs: { type: "button", title: t("filters.remove") },
      });
      chip.append(createElement("span", { text: label }), createElement("i", { className: "pi pi-times" }));
      chip.addEventListener("click", (event) => {
        event.stopPropagation();
        remove();
      });
      chips.appendChild(chip);
    };
    if (this.typeFilterActive()) {
      const names = TYPE_ORDER.filter((name) => this.state.types.has(name)).map((name) => t(`settings.formats.${name}`));
      add(names.join(", "), () => {
        this.state.types = new Set(TYPE_ORDER);
        this.filterPopover?.refresh();
        this.applyFilters();
      });
    }
    if (this.state.starredOnly) {
      add(t("filters.starred_only"), () => {
        this.state.starredOnly = false;
        this.filterPopover?.refresh();
        this.applyFilters();
      });
    }
    if (this.calendarActive()) {
      const { year, month, day } = this.state.calendar;
      const parts = [];
      if (day !== null) parts.push(String(day));
      if (month !== null) parts.push(monthName(month));
      parts.push(String(year));
      add(parts.join(" "), () => this.setCalendar(emptyCalendar()));
    }
    chips.hidden = !chips.childElementCount;
  },

  // --- date groups ------------------------------------------------------------------------------------------

  /** Called whenever the grid is rebuilt from scratch. */
  resetGroups() {
    this.groupLastKey = null;
    this.groups = this.state.groupByDate ? allGroups() : [];
  },

  buildGroupHeader(group) {
    const header = createElement("div", { className: "assets-plus-group-header" });
    header.dataset.groupKey = group.key;
    header._group = group;
    header.classList.toggle("selected", this.state.selectedGroups.has(group.key));
    header.append(
      createElement("i", { className: "pi pi-chevron-down" }),
      createElement("span", { className: "assets-plus-group-label", text: group.label }),
      createElement("span", { className: "assets-plus-group-count" })
    );
    this.paintGroupCount(header);
    return header;
  },

  paintGroupCount(header) {
    const count = this.groupCounts.get(header._group?.key);
    const target = header.querySelector(".assets-plus-group-count");
    if (target) target.textContent = count === undefined ? "" : `(${count})`;
  },

  /** Ask the server how many files each group holds (the headers show it) and fill the counts in. */
  async refreshGroupCounts() {
    if (!this.state.groupByDate || !this.groups.length) return;
    const epoch = this.listEpoch;
    const edges = edgesFor(this.groups);
    try {
      const result = await this.fetchHistogram(edges, { withCalendar: true });
      if (epoch !== this.listEpoch || !this.state.groupByDate) return;
      this.groupCounts = countsByGroup(this.groups, edges, result.counts || []);
      this.elements.grid.querySelectorAll(".assets-plus-group-header").forEach((header) => this.paintGroupCount(header));
    } catch (error) {
      warn(t("log.filters_failed"), error);
    }
  },

  updateGroupHeaderStyles() {
    this.elements.grid.querySelectorAll(".assets-plus-group-header").forEach((header) => {
      header.classList.toggle("selected", this.state.selectedGroups.has(header._group?.key));
    });
  },

  /** The files of a time range (under the current filters), as light items: nothing is read from disk. */
  async fetchRangeItems(min, max) {
    const params = this.buildListParams();
    ["cursor", "since", "starred_first"].forEach((name) => params.delete(name));
    params.set("limit", "0");
    params.set("lite", "1");
    const calendar = calendarRange(this.state.calendar);
    const low = calendar ? Math.max(min, calendar[0]) : min;
    const high = max === null ? (calendar ? calendar[1] : null) : calendar ? Math.min(max, calendar[1]) : max;
    params.set("mtime_min", String(low));
    if (high === null) params.delete("mtime_max");
    else params.set("mtime_max", String(high));
    const payload = await fetchJson(`/assets_plus/${this.state.tab}/list?${params.toString()}`);
    return payload.items || [];
  },

  /**
   * Selection mode: a click on a date header selects (or, when it is all selected already, unselects) its whole
   * group, also the files that are not loaded yet. Shift+click does it for every group between the last clicked
   * header and this one.
   */
  async selectGroupFromClick(event, header) {
    if (this.groupSelectionBusy) return;
    const clicked = header._group;
    if (!clicked) return;
    const headers = Array.from(this.elements.grid.querySelectorAll(".assets-plus-group-header"));
    const value = !this.state.selectedGroups.has(clicked.key);
    let range = [clicked];
    if (event.shiftKey && this.state.groupAnchor) {
      const from = headers.findIndex((entry) => entry._group.key === this.state.groupAnchor);
      const to = headers.indexOf(header);
      if (from !== -1 && to !== -1) {
        range = headers.slice(Math.min(from, to), Math.max(from, to) + 1).map((entry) => entry._group);
      }
    }
    this.state.groupAnchor = clicked.key;
    const min = Math.min(...range.map((group) => group.min));
    const maxes = range.map((group) => group.max);
    const max = maxes.includes(null) ? null : Math.max(...maxes);
    this.groupSelectionBusy = true;
    header.classList.add("busy");
    try {
      const items = await this.fetchRangeItems(min, max);
      items.forEach((item) => {
        if (value) {
          this.state.selected.add(item.relpath);
          this.state.offscreen.set(item.relpath, item);
        } else {
          this.state.selected.delete(item.relpath);
          this.state.offscreen.delete(item.relpath);
        }
      });
      range.forEach((group) => (value ? this.state.selectedGroups.add(group.key) : this.state.selectedGroups.delete(group.key)));
      this.applySelectionStyles();
      this.updateGroupHeaderStyles();
      this.updateActionsBar();
    } catch (error) {
      warn(t("log.filters_failed"), error);
      this.toast({ severity: "error", summary: t("toast.summary"), detail: t("toast.group_select_failed"), life: 3000 });
    } finally {
      this.groupSelectionBusy = false;
      header.classList.remove("busy");
    }
  },
};
