import { env as publicEnv } from '$env/dynamic/public';
import { sitePortfolioDefaults } from '$lib/data/site-portfolio-defaults';
import type { SiteLocale } from '$lib/i18n/site-locale';
import type { SitePortfolioContent } from '$lib/types/site-portfolio';
import { sitePortfolioQuery } from './sanity/groq-site-portfolio';
import { getSanityProjectConfig, getSanityServerClient } from './sanity/get-server-client';
import { mapSanitySitePortfolio } from './sanity/map-site-portfolio';

function defaultBaseUrl(): string {
  return new URL(publicEnv.PUBLIC_SITE_URL || 'http://localhost:5173').toString().replace(/\/$/, '');
}

export async function fetchSitePortfolio(locale: SiteLocale = 'es'): Promise<SitePortfolioContent> {
  const baseUrl = defaultBaseUrl();
  const client = getSanityServerClient();
  const cfg = getSanityProjectConfig();
  if (!client || !cfg) {
    return mapSanitySitePortfolio(null, sitePortfolioDefaults, {
      projectId: '',
      dataset: '',
      baseUrl,
      locale
    });
  }

  try {
    const raw = await client.fetch<Record<string, unknown> | null>(sitePortfolioQuery);
    return mapSanitySitePortfolio(raw, sitePortfolioDefaults, {
      projectId: cfg.projectId,
      dataset: cfg.dataset,
      baseUrl,
      locale
    });
  } catch (error) {
    console.warn('[portfolio] Sanity unavailable, using local defaults.', error);
    return mapSanitySitePortfolio(null, sitePortfolioDefaults, {
      projectId: cfg.projectId,
      dataset: cfg.dataset,
      baseUrl,
      locale
    });
  }
}
