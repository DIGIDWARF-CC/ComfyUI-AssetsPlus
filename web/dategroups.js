import { t } from './i18n.js';

/*
 * Date groups in the manner of the Windows Explorer: Today, Yesterday, Earlier this week, Last week, Earlier this
 * month, Last month, Earlier this year, then one group per previous year. Boundaries are local midnights, weeks start
 * on Monday. Every group is a half-open interval [min, max) of epoch seconds (max is null for the newest group).
 */

const seconds = (date) => Math.floor(date.getTime() / 1000);
const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
const addDays = (date, days) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);

const OLDEST_YEAR_GROUPS = 30;

/** The relative groups that exist today, newest first: [{ key, start }] with start in epoch seconds. */
export const relativeBoundaries = (now = new Date()) => {
  const today = startOfDay(now);
  const weekStart = addDays(today, -((today.getDay() + 6) % 7));
  const candidates = [
    ["today", today],
    ["yesterday", addDays(today, -1)],
    ["earlier_week", weekStart],
    ["last_week", addDays(weekStart, -7)],
    ["earlier_month", new Date(now.getFullYear(), now.getMonth(), 1)],
    ["last_month", new Date(now.getFullYear(), now.getMonth() - 1, 1)],
    ["earlier_year", new Date(now.getFullYear(), 0, 1)],
  ];
  const kept = [];
  for (const [key, date] of candidates) {
    const start = seconds(date);
    // A boundary that is not older than the previous one would make an empty group (e.g. "this week" on a Monday).
    if (!kept.length || start < kept[kept.length - 1].start) kept.push({ key, start });
  }
  return kept;
};

/** Every group the gallery can show right now, newest first, as { key, label, min, max }. */
export const allGroups = (now = new Date()) => {
  const relative = relativeBoundaries(now);
  const groups = relative.map((boundary, index) => ({
    key: boundary.key,
    label: t(`groups.${boundary.key}`),
    min: boundary.start,
    max: index === 0 ? null : relative[index - 1].start,
  }));
  const floor = relative[relative.length - 1].start;
  for (let year = now.getFullYear() - 1, count = 0; count < OLDEST_YEAR_GROUPS; year -= 1, count += 1) {
    const min = seconds(new Date(year, 0, 1));
    const max = Math.min(seconds(new Date(year + 1, 0, 1)), floor);
    if (min >= max) continue;
    groups.push({ key: `y${year}`, label: String(year), min, max });
  }
  return groups;
};

/** The group of one file time (epoch seconds). Files older than the year groups fall into one "Older" group. */
export const groupOf = (mtime, groups) => {
  for (const group of groups) {
    if (mtime >= group.min && (group.max === null || mtime < group.max)) return group;
  }
  const oldest = groups[groups.length - 1];
  return { key: "older", label: t("groups.older"), min: 0, max: oldest ? oldest.min : null };
};

/** Interval edges (ascending, unique) that cut the history exactly into the given groups. */
export const edgesFor = (groups, now = new Date()) => {
  const set = new Set();
  groups.forEach((group) => {
    set.add(group.min);
    set.add(group.max === null ? seconds(addDays(startOfDay(now), 2)) : group.max);
  });
  return Array.from(set).sort((a, b) => a - b);
};

/** Sum the histogram counts (one per interval between `edges`) that lie inside each group. */
export const countsByGroup = (groups, edges, counts) => {
  const result = new Map();
  groups.forEach((group) => {
    const max = group.max === null ? Infinity : group.max;
    let sum = 0;
    for (let index = 0; index < counts.length; index += 1) {
      if (edges[index] >= group.min && edges[index + 1] <= max) sum += counts[index];
    }
    result.set(group.key, sum);
  });
  return result;
};
