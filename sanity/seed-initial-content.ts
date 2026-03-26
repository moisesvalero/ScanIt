import { getCliClient } from 'sanity/cli';
import { sitePortfolioDefaults } from '../src/lib/data/site-portfolio-defaults';

type LocaleString = { es: string; en?: string };
type LocaleText = { es: string; en?: string };

const asLocaleString = (value?: string): LocaleString => ({ es: value || '' });
const asLocaleText = (value?: string): LocaleText => ({ es: value || '' });
const keyOf = (prefix: string, index: number) => `${prefix}-${index + 1}`;

function mapSitePortfolioDocument() {
  const site = sitePortfolioDefaults;
  return {
    _id: 'portfolioSite',
    _type: 'sitePortfolio',
    title: 'Web principal',
    header: {
      ...site.header,
      navItems: site.header.navItems.map((item, index) => ({
        _key: keyOf('nav', index),
        ...item
      }))
    },
    seo: site.seo,
    hero: {
      cvHref: site.hero.cvHref,
      label: site.hero.label,
      title: site.hero.title,
      subtitle: site.hero.subtitle,
      bio: site.hero.bio
    },
    about: site.about,
    services: {
      meta: asLocaleString(site.services.meta),
      title: asLocaleString(site.services.title),
      items: site.services.items.map((item, index) => ({
        _key: keyOf('service', index),
        icon: item.icon,
        title: asLocaleString(item.title),
        description: asLocaleText(item.description)
      }))
    },
    techStack: {
      ...site.techStack,
      categories: site.techStack.categories.map((category, catIndex) => ({
        _key: keyOf('stack-category', catIndex),
        title: category.title,
        icons: category.icons.map((icon, iconIndex) => ({
          _key: keyOf(`stack-icon-${catIndex + 1}`, iconIndex),
          ...icon
        }))
      }))
    },
    quality: {
      ...site.quality,
      items: site.quality.items.map((item, index) => ({
        _key: keyOf('quality', index),
        ...item
      }))
    },
    projects: {
      meta: asLocaleString(site.projects.meta),
      title: asLocaleString(site.projects.title),
      projects: site.projects.projects.map((project, index) => ({
        _key: keyOf('featured-project', index),
        sortOrder: index,
        imageSrc: project.imageSrc,
        imageAlt: project.imageAlt,
        title: asLocaleString(project.title),
        description: asLocaleText(project.description),
        tags: project.tags,
        linkLabel: asLocaleString(project.linkLabel),
        destinationUrl: project.href
      }))
    },
    contact: site.contact,
    footer: site.footer
  };
}

async function main() {
  const client = getCliClient({ apiVersion: '2025-01-01' });
  const siteDoc = mapSitePortfolioDocument();
  await client.createOrReplace(siteDoc);
  console.log('Seed completado: documento global cargado en Sanity.');
}

main().catch((error) => {
  console.error('Error cargando seed inicial en Sanity:', error);
  process.exit(1);
});
