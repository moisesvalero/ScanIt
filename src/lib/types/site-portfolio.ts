export type SiteNavItem = {
  label: string;
  href: string;
  openCareerModal?: boolean;
};

export type SiteHeader = {
  logoText: string;
  logoHref: string;
  navItems: SiteNavItem[];
  ctaLabel: string;
  ctaHref: string;
};

export type SiteSeo = {
  title: string;
  description: string;
  ogTitle: string;
  ogDescription: string;
  ogImage: string;
  twitterCard: 'summary' | 'summary_large_image';
};

export type SiteHero = {
  cvHref: string;
  label: string;
  title: string;
  subtitle: string;
  bio: string;
  ctaPrimaryLabel?: string;
  careerCtaLabel?: string;
};

export type SiteAbout = {
  imageSrc: string;
  imageAlt: string;
  meta: string;
  title: string;
  aboutHtml: string;
};

export type SiteServiceItem = {
  icon: string;
  title: string;
  description: string;
};

export type SiteServices = {
  meta: string;
  title: string;
  items: SiteServiceItem[];
};

export type SiteStackIcon = {
  src?: string;
  iconify?: string;
  alt: string;
  title?: string;
};

export type SiteStackCategory = {
  title: string;
  icons: SiteStackIcon[];
};

export type SiteTechStack = {
  meta: string;
  title: string;
  categories: SiteStackCategory[];
};

export type SiteQualityItem = {
  icon: string;
  title: string;
  description: string;
};

export type SiteQuality = {
  meta: string;
  title: string;
  items: SiteQualityItem[];
};

export type SiteProjectCard = {
  imageSrc: string;
  imageAlt: string;
  href: string;
  external: boolean;
  linkLabel: string;
  title: string;
  description: string;
  tags: string[];
};

export type SiteProjectsSection = {
  meta: string;
  title: string;
  projects: SiteProjectCard[];
};

export type SiteContact = {
  heading: string;
  subtitle: string;
  typebotSrc: string;
  whatsappLead: string;
  whatsappButtonLabel: string;
  iframeTitle: string;
};

export type SiteFooter = {
  copyrightTemplate: string;
  githubHref: string;
  linkedinHref: string;
  emailHref: string;
};

export type SitePortfolioContent = {
  header: SiteHeader;
  seo: SiteSeo;
  hero: SiteHero;
  about: SiteAbout;
  services: SiteServices;
  techStack: SiteTechStack;
  quality: SiteQuality;
  projects: SiteProjectsSection;
  contact: SiteContact;
  footer: SiteFooter;
};
