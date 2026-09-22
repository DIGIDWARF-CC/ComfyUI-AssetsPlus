import { DEFAULT_LANGUAGE } from './constants.js';
import { warn, fetchJson } from './utils.js';

let activeTranslations = {};
let fallbackTranslations = {};
let activeLanguage = DEFAULT_LANGUAGE;

const t = (key, vars = {}) => {
  const template = activeTranslations?.[key] ?? fallbackTranslations?.[key] ?? key;
  if (typeof template !== "string") return String(template);
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match
  );
};

const loadTranslationsList = async () => {
  try {
    const payload = await fetchJson("/assets_plus/i18n");
    if (Array.isArray(payload?.translations)) {
      return payload.translations;
    }
  } catch (error) {
    warn(t("log.translations_list_failed"), error);
  }
  return [];
};

const loadTranslationData = async (language) => {
  try {
    return await fetchJson(`/assets_plus/i18n?lang=${encodeURIComponent(language)}`);
  } catch (error) {
    warn(t("log.translation_load_failed", { language }), error);
  }
  return {};
};

const buildLanguageOptions = (translations) => {
  if (!translations.length) {
    return [{ text: DEFAULT_LANGUAGE, value: DEFAULT_LANGUAGE }];
  }
  return translations.map((entry) => {
    const name = entry["translation-name"] || entry.code;
    const author = entry["translation-author"];
    const label = author ? `${name} — ${author}` : name;
    return { text: label, value: entry.code };
  });
};

let _onLanguageChange = null;

const setOnLanguageChange = (fn) => {
  _onLanguageChange = fn;
};

const applyLanguage = async (language, { force = false } = {}) => {
  const normalized = language || DEFAULT_LANGUAGE;
  if (!force && normalized === activeLanguage) {
    return;
  }
  fallbackTranslations = await loadTranslationData(DEFAULT_LANGUAGE);
  activeTranslations =
    normalized === DEFAULT_LANGUAGE
      ? fallbackTranslations
      : await loadTranslationData(normalized);
  activeLanguage = normalized;
  _onLanguageChange?.();
};

export {
  t,
  loadTranslationsList,
  loadTranslationData,
  buildLanguageOptions,
  applyLanguage,
  setOnLanguageChange,
  activeTranslations,
  fallbackTranslations,
  activeLanguage,
};
