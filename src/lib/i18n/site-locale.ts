export type SiteLocale = 'en' | 'es' | 'zh' | 'de' | 'pt' | 'fr';

export const SITE_LOCALES: SiteLocale[] = ['en', 'es', 'zh', 'de', 'pt', 'fr'];
export const LOCALE_LOAD_DEPENDENCY = 'app:locale' as const;
export const PORTFOLIO_LOCALE_COOKIE = 'portfolio_locale';

export function parseSiteLocaleCookie(value: string | null | undefined): SiteLocale | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (v === 'en') return 'en';
  if (v === 'es') return 'es';
  if (v === 'zh') return 'zh';
  if (v === 'de') return 'de';
  if (v === 'pt') return 'pt';
  if (v === 'fr') return 'fr';
  return null;
}

export function resolveSiteLocale(cookieValue: string | null | undefined): SiteLocale {
  return parseSiteLocaleCookie(cookieValue) ?? 'en';
}
