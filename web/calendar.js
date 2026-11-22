import { createElement } from './utils.js';
import { t } from './i18n.js';

/*
 * A calendar in the manner of the Windows one: days of a month, months of a year, years of a decade.
 *   click          selects that day, month or year (the filter then covers all of it); Shift+click extends the choice
 *                  to a range of the same kind, from the last clicked cell
 *   double click   (or Enter) opens a month's days / a year's months
 *   title          goes one level up (days -> months -> years)
 *   chevrons       previous / next month, year or decade
 *   Show           hands the choice over; Clear forgets it
 * Cells with files are marked, the others are dimmed (loadCounts asks the server how many files fall into each cell).
 * Clicks never rebuild the grid, so a double click still lands on the same cell.
 */

const seconds = (date) => Math.floor(date.getTime() / 1000);

// Ordinals: a day is y*10000 + m*100 + d (months 0-11), a month is y*12 + m, a year is y. Each grows with time.
const dayOrd = (y, m, d) => y * 10000 + m * 100 + d;
const parts = {
  day: (o) => [Math.floor(o / 10000), Math.floor((o % 10000) / 100), o % 100],
  month: (o) => [Math.floor(o / 12), o % 12],
  year: (o) => [o],
};

/** [min, max) in epoch seconds of one cell. */
const rangeOf = (unit, ord) => {
  if (unit === "day") {
    const [y, m, d] = parts.day(ord);
    return [seconds(new Date(y, m, d)), seconds(new Date(y, m, d + 1))];
  }
  if (unit === "month") {
    const [y, m] = parts.month(ord);
    return [seconds(new Date(y, m, 1)), seconds(new Date(y, m + 1, 1))];
  }
  return [seconds(new Date(ord, 0, 1)), seconds(new Date(ord + 1, 0, 1))];
};

const formatDay = (ord, withYear = true) => {
  const [y, m, d] = parts.day(ord);
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "long",
    ...(withYear ? { year: "numeric" } : {}),
  }).format(new Date(y, m, d));
};
const formatMonth = (ord, withYear = true) => {
  const [y, m] = parts.month(ord);
  return new Intl.DateTimeFormat(undefined, { month: "long", ...(withYear ? { year: "numeric" } : {}) }).format(
    new Date(y, m, 1)
  );
};

/** What the chip says about a choice. */
const labelOf = (unit, from, to) => {
  const single = from === to;
  if (unit === "year") return single ? String(from) : `${from} – ${to}`;
  if (unit === "month") return single ? formatMonth(from) : `${formatMonth(from)} – ${formatMonth(to)}`;
  return single ? formatDay(from) : `${formatDay(from)} – ${formatDay(to)}`;
};

export const createCalendar = ({ loadCounts, onShow, onClear }) => {
  const now = new Date();
  const view = { level: "days", year: now.getFullYear(), month: now.getMonth() };
  let selection = null; // { unit, from, to } with from <= to
  let anchor = null; // { unit, ord } of the last plain click
  let ticket = 0;
  let cells = [];

  const root = createElement("div", { className: "assets-plus-calendar" });
  const head = createElement("div", { className: "assets-plus-calendar-head" });
  const title = createElement("button", { className: "assets-plus-calendar-title", attrs: { type: "button" } });
  const nav = createElement("div", { className: "assets-plus-calendar-nav" });
  const previous = createElement("button", { className: "assets-plus-calendar-step", attrs: { type: "button" } });
  previous.innerHTML = '<i class="pi pi-chevron-up"></i>';
  const next = createElement("button", { className: "assets-plus-calendar-step", attrs: { type: "button" } });
  next.innerHTML = '<i class="pi pi-chevron-down"></i>';
  nav.append(previous, next);
  head.append(title, nav);
  const grid = createElement("div", { className: "assets-plus-calendar-grid" });
  const hint = createElement("div", { className: "assets-plus-calendar-hint" });
  const actions = createElement("div", { className: "assets-plus-calendar-actions" });
  const showButton = createElement("button", { className: "assets-plus-calendar-show", attrs: { type: "button" } });
  const clearButton = createElement("button", { className: "assets-plus-calendar-clear", attrs: { type: "button" } });
  actions.append(clearButton, showButton);
  root.append(head, grid, hint, actions);

  const selectionRange = () => {
    if (!selection) return null;
    return [rangeOf(selection.unit, selection.from)[0], rangeOf(selection.unit, selection.to)[1]];
  };

  const paintTexts = () => {
    showButton.textContent = t("date.show");
    clearButton.textContent = t("date.clear");
    hint.textContent = t("date.hint");
    previous.title = t("date.previous");
    next.title = t("date.next");
    showButton.disabled = !selection;
  };

  /** Highlight the cells inside the choice (also the days of a chosen month, the months of a chosen year). */
  const paintSelection = () => {
    const range = selectionRange();
    cells.forEach((cell) => {
      const inside = Boolean(range) && cell._min >= range[0] && cell._max <= range[1];
      cell.classList.toggle("selected", inside);
      cell.setAttribute("aria-pressed", inside ? "true" : "false");
    });
    showButton.disabled = !selection;
  };

  const choose = (unit, ord, extend) => {
    if (extend && anchor && anchor.unit === unit) {
      const from = Math.min(anchor.ord, ord);
      const to = Math.max(anchor.ord, ord);
      selection = { unit, from, to };
    } else {
      selection = { unit, from: ord, to: ord };
      anchor = { unit, ord };
    }
    paintSelection();
  };

  const drillDown = (unit, ord) => {
    if (unit === "month") {
      const [y, m] = parts.month(ord);
      Object.assign(view, { level: "days", year: y, month: m });
    } else if (unit === "year") {
      Object.assign(view, { level: "months", year: ord });
    } else {
      return;
    }
    render();
  };

  /** The cells of the current view: { unit, ord, text, outside } in time order. */
  const buildModel = () => {
    if (view.level === "days") {
      const first = new Date(view.year, view.month, 1);
      const offset = (first.getDay() + 6) % 7; // weeks start on Monday
      return Array.from({ length: 42 }, (_, index) => {
        const date = new Date(view.year, view.month, 1 - offset + index);
        return {
          unit: "day",
          ord: dayOrd(date.getFullYear(), date.getMonth(), date.getDate()),
          text: String(date.getDate()),
          outside: date.getMonth() !== view.month,
          today:
            date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate(),
        };
      });
    }
    if (view.level === "months") {
      return Array.from({ length: 12 }, (_, month) => ({
        unit: "month",
        ord: view.year * 12 + month,
        text: new Intl.DateTimeFormat(undefined, { month: "short" }).format(new Date(2000, month, 1)),
        outside: false,
        today: view.year === now.getFullYear() && month === now.getMonth(),
      }));
    }
    const base = Math.floor(view.year / 10) * 10;
    return Array.from({ length: 16 }, (_, index) => {
      const year = base - 2 + index;
      return { unit: "year", ord: year, text: String(year), outside: year < base || year > base + 9, today: year === now.getFullYear() };
    });
  };

  const titleText = () => {
    if (view.level === "days") return formatMonth(view.year * 12 + view.month);
    if (view.level === "months") return String(view.year);
    const base = Math.floor(view.year / 10) * 10;
    return `${base} – ${base + 9}`;
  };

  const loadMarks = () => {
    if (!cells.length) return;
    const mine = ++ticket;
    const edges = cells.map((cell) => cell._min).concat([cells[cells.length - 1]._max]);
    Promise.resolve(loadCounts(edges))
      .then((counts) => {
        if (mine !== ticket) return;
        cells.forEach((cell, index) => {
          const count = Number(counts?.[index] || 0);
          cell.classList.toggle("has-files", count > 0);
          cell.classList.toggle("empty", count === 0);
          cell.title = count ? t("date.files", { count }) : "";
        });
      })
      .catch(() => {});
  };

  function render() {
    title.textContent = titleText();
    title.disabled = view.level === "years";
    grid.replaceChildren();
    grid.className = `assets-plus-calendar-grid assets-plus-calendar-${view.level}`;
    if (view.level === "days") {
      const monday = new Date(2024, 0, 1); // a Monday
      for (let index = 0; index < 7; index += 1) {
        grid.appendChild(
          createElement("div", {
            className: "assets-plus-calendar-weekday",
            text: new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(new Date(2024, 0, monday.getDate() + index)),
          })
        );
      }
    }
    cells = buildModel().map((model) => {
      const cell = createElement("button", {
        className: `assets-plus-calendar-cell${model.outside ? " outside" : ""}${model.today ? " today" : ""}`,
        text: model.text,
        attrs: { type: "button" },
      });
      [cell._min, cell._max] = rangeOf(model.unit, model.ord);
      cell.addEventListener("click", (event) => {
        event.stopPropagation();
        choose(model.unit, model.ord, event.shiftKey);
      });
      cell.addEventListener("dblclick", (event) => {
        event.stopPropagation();
        drillDown(model.unit, model.ord);
      });
      cell.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        event.stopPropagation();
        drillDown(model.unit, model.ord);
      });
      grid.appendChild(cell);
      return cell;
    });
    paintTexts();
    paintSelection();
    loadMarks();
  }

  const shift = (direction) => {
    if (view.level === "days") {
      const moved = new Date(view.year, view.month + direction, 1);
      Object.assign(view, { year: moved.getFullYear(), month: moved.getMonth() });
    } else if (view.level === "months") {
      view.year += direction;
    } else {
      view.year += direction * 10;
    }
    render();
  };

  title.addEventListener("click", (event) => {
    event.stopPropagation();
    if (view.level === "days") view.level = "months";
    else if (view.level === "months") view.level = "years";
    render();
  });
  previous.addEventListener("click", (event) => {
    event.stopPropagation();
    shift(-1);
  });
  next.addEventListener("click", (event) => {
    event.stopPropagation();
    shift(1);
  });
  showButton.addEventListener("click", (event) => {
    event.stopPropagation();
    const range = selectionRange();
    if (range) onShow({ min: range[0], max: range[1], label: labelOf(selection.unit, selection.from, selection.to) });
  });
  clearButton.addEventListener("click", (event) => {
    event.stopPropagation();
    selection = null;
    anchor = null;
    paintSelection();
    onClear();
  });
  root.addEventListener("click", (event) => event.stopPropagation());

  render();

  return {
    element: root,
    /** The menu opened again: show the month of the choice (or the current one) and refresh the marks. */
    open() {
      if (selection?.unit === "day") {
        const [year, month] = parts.day(selection.from);
        Object.assign(view, { level: "days", year, month });
      } else if (selection?.unit === "month") {
        const [year, month] = parts.month(selection.from);
        Object.assign(view, { level: "days", year, month });
      } else if (selection?.unit === "year") {
        Object.assign(view, { level: "months", year: selection.from });
      } else {
        Object.assign(view, { level: "days", year: now.getFullYear(), month: now.getMonth() });
      }
      render();
    },
    /** The filter was removed from outside (chip, reset): forget the choice. */
    clear() {
      selection = null;
      anchor = null;
      paintSelection();
    },
    retranslate: paintTexts,
  };
};
