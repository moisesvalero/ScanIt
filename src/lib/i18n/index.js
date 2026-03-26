import { writable, derived } from 'svelte/store';
import en from './en.json';
import es from './es.json';
import de from './de.json';
import fr from './fr.json';
import pt from './pt.json';
import zh from './zh.json';

/** @type {Record<string, any>} */
const translations = { en, es, de, fr, pt, zh };

const SUPPORTED = /** @type {const} */ (['en', 'es', 'zh', 'de', 'pt', 'fr']);

/** @param {string | null | undefined} lang */
function normalizeLocale(lang) {
  if (!lang) return 'en';
  const lower = lang.toLowerCase();
  if (lower.startsWith('en')) return 'en';
  if (lower.startsWith('es')) return 'es';
  if (lower.startsWith('zh')) return 'zh';
  if (lower.startsWith('de')) return 'de';
  if (lower.startsWith('pt')) return 'pt';
  if (lower.startsWith('fr')) return 'fr';
  return 'en';
}

function detectBrowserLocale() {
  if (typeof navigator === 'undefined') return 'en';
  const langs = Array.isArray(navigator.languages) && navigator.languages.length ? navigator.languages : [navigator.language];
  for (const l of langs) {
    const n = normalizeLocale(l);
    if (SUPPORTED.includes(n)) return n;
  }
  return 'en';
}

const defaultLang = (() => {
  // En SSR y si no hay info del navegador, fallback EN
  if (typeof window === 'undefined') return 'en';

  const saved = localStorage.getItem('lang');
  const hasManualSelection = localStorage.getItem('lang_manual') === '1';

  // Si el usuario eligió manualmente idioma, respetamos siempre esa preferencia
  if (hasManualSelection && saved) {
    return normalizeLocale(saved);
  }

  return detectBrowserLocale();
})();

export const locale = writable(defaultLang);

if (typeof document !== 'undefined') {
  document.documentElement.lang = defaultLang;
}

export const t = derived(locale, ($locale) => {
  return (
    /** @param {string} key */
    (key) => {
    const keys = key.split('.');
    /** @type {any} */
    let value = translations[$locale];
    for (const k of keys) {
      value = value?.[k];
    }
    return value || key;
  });
});

/** @param {string} lang */
export function setLocale(lang) {
  const normalized = normalizeLocale(lang);
  locale.set(normalized);
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('lang', normalized);
    localStorage.setItem('lang_manual', '1');
  }
  if (typeof document !== 'undefined') {
    document.documentElement.lang = normalized;
  }
}
