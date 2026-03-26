import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { PORTFOLIO_LOCALE_COOKIE, type SiteLocale } from '$lib/i18n/site-locale';

export const POST: RequestHandler = async ({ request, cookies }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw error(400, 'JSON invalido');
  }
  const loc = (body as { locale?: string })?.locale;
  if (loc !== 'en' && loc !== 'es' && loc !== 'zh' && loc !== 'de' && loc !== 'pt' && loc !== 'fr') {
    throw error(400, 'locale debe ser en, es, zh, de, pt o fr');
  }
  const locale = loc as SiteLocale;
  cookies.set(PORTFOLIO_LOCALE_COOKIE, locale, {
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production'
  });
  return json({ ok: true, locale });
};
