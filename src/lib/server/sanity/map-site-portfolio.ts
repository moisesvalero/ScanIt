import { applyPortfolioEnglishDemo } from '$lib/data/site-portfolio-locale-en';
import type { SiteLocale } from '$lib/i18n/site-locale';
import type { SitePortfolioContent } from '$lib/types/site-portfolio';
import { imageUrl } from './image-builder';

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}
function asString(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.trim() ? v.trim() : fallback;
}
function asStringOpt(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}
function pickLocalized(raw: unknown, locale: SiteLocale, fallback: string): string {
  if (typeof raw === 'string') return raw.trim() || fallback;
  const o = asRecord(raw);
  if (!o) return fallback;
  const primary = locale === 'en' ? asStringOpt(o.en) : asStringOpt(o.es);
  const secondary = locale === 'en' ? asStringOpt(o.es) : asStringOpt(o.en);
  return primary || secondary || fallback;
}
function absolutizeOgImage(pathOrUrl: string, baseUrl: string): string {
  if (pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://')) return pathOrUrl;
  const base = baseUrl.replace(/\/$/, '');
  const path = pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`;
  return `${base}${path}`;
}

export function mapSanitySitePortfolio(
  raw: Record<string, unknown> | null | undefined,
  defaults: SitePortfolioContent,
  ctx: { projectId: string; dataset: string; baseUrl: string; locale: SiteLocale }
): SitePortfolioContent {
  if (!raw) {
    const base = { ...defaults, seo: { ...defaults.seo, ogImage: absolutizeOgImage(defaults.seo.ogImage, ctx.baseUrl) } };
    return ctx.locale === 'en' ? applyPortfolioEnglishDemo(base) : base;
  }
  const header = asRecord(raw.header);
  const seo = asRecord(raw.seo);
  const hero = asRecord(raw.hero);
  const about = asRecord(raw.about);
  const services = asRecord(raw.services);
  const techStack = asRecord(raw.techStack);
  const quality = asRecord(raw.quality);
  const projects = asRecord(raw.projects);
  const contact = asRecord(raw.contact);
  const footer = asRecord(raw.footer);

  const mapped: SitePortfolioContent = {
    header: {
      logoText: asString(header?.logoText, defaults.header.logoText),
      logoHref: asString(header?.logoHref, defaults.header.logoHref),
      navItems: Array.isArray(header?.navItems) ? (header?.navItems as SitePortfolioContent['header']['navItems']) : defaults.header.navItems,
      ctaLabel: asString(header?.ctaLabel, defaults.header.ctaLabel),
      ctaHref: asString(header?.ctaHref, defaults.header.ctaHref)
    },
    seo: {
      title: asString(seo?.title, defaults.seo.title),
      description: asString(seo?.description, defaults.seo.description),
      ogTitle: asString(seo?.ogTitle, defaults.seo.ogTitle),
      ogDescription: asString(seo?.ogDescription, defaults.seo.ogDescription),
      ogImage: absolutizeOgImage(asString(seo?.ogImage, defaults.seo.ogImage), ctx.baseUrl),
      twitterCard: seo?.twitterCard === 'summary' ? 'summary' : 'summary_large_image'
    },
    hero: {
      cvHref: asString(hero?.cvHref, defaults.hero.cvHref),
      label: asString(hero?.label, defaults.hero.label),
      title: asString(hero?.title, defaults.hero.title),
      subtitle: asString(hero?.subtitle, defaults.hero.subtitle),
      bio: asString(hero?.bio, defaults.hero.bio),
      ctaPrimaryLabel: asStringOpt(hero?.ctaPrimaryLabel) ?? defaults.hero.ctaPrimaryLabel,
      careerCtaLabel: asStringOpt(hero?.careerCtaLabel) ?? defaults.hero.careerCtaLabel
    },
    about: {
      imageSrc: imageUrl(ctx.projectId, ctx.dataset, about?.image, 800) || asString(about?.imageSrc, defaults.about.imageSrc),
      imageAlt: asString(about?.imageAlt, defaults.about.imageAlt),
      meta: asString(about?.meta, defaults.about.meta),
      title: asString(about?.title, defaults.about.title),
      aboutHtml: asString(about?.aboutHtml, defaults.about.aboutHtml)
    },
    services: {
      meta: pickLocalized(services?.meta, ctx.locale, defaults.services.meta),
      title: pickLocalized(services?.title, ctx.locale, defaults.services.title),
      items: defaults.services.items
    },
    techStack: {
      meta: asString(techStack?.meta, defaults.techStack.meta),
      title: asString(techStack?.title, defaults.techStack.title),
      categories: defaults.techStack.categories
    },
    quality: {
      meta: asString(quality?.meta, defaults.quality.meta),
      title: asString(quality?.title, defaults.quality.title),
      items: defaults.quality.items
    },
    projects: {
      meta: pickLocalized(projects?.meta, ctx.locale, defaults.projects.meta),
      title: pickLocalized(projects?.title, ctx.locale, defaults.projects.title),
      projects: defaults.projects.projects
    },
    contact: {
      heading: asString(contact?.heading, defaults.contact.heading),
      subtitle: asString(contact?.subtitle, defaults.contact.subtitle),
      typebotSrc: asString(contact?.typebotSrc, defaults.contact.typebotSrc),
      whatsappLead: asString(contact?.whatsappLead, defaults.contact.whatsappLead),
      whatsappButtonLabel: asString(contact?.whatsappButtonLabel, defaults.contact.whatsappButtonLabel),
      iframeTitle: asString(contact?.iframeTitle, defaults.contact.iframeTitle)
    },
    footer: {
      copyrightTemplate: asString(footer?.copyrightTemplate, defaults.footer.copyrightTemplate),
      githubHref: asString(footer?.githubHref, defaults.footer.githubHref),
      linkedinHref: asString(footer?.linkedinHref, defaults.footer.linkedinHref),
      emailHref: asString(footer?.emailHref, defaults.footer.emailHref)
    }
  };
  return ctx.locale === 'en' ? applyPortfolioEnglishDemo(mapped) : mapped;
}
