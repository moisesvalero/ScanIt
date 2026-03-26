export type CaseStudyMetric = {
  value: string;
  label: string;
};

export type CaseStudySection = {
  title: string;
  bodyHtml: string;
};

export type CaseStudy = {
  slug: string;
  title: string;
  seoDescription?: string;
  heroTag: string;
  heroDescription: string;
  tags: string[];
  images: {
    principal: string;
    secondary1: string;
    secondary2: string;
  };
  metrics: [CaseStudyMetric, CaseStudyMetric, CaseStudyMetric, CaseStudyMetric];
  reto: CaseStudySection;
  hice: CaseStudySection;
  resultado: CaseStudySection;
  stack: string[];
  liveUrl: string;
};
