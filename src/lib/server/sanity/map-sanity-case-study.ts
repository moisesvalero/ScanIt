import type { CaseStudy, CaseStudyMetric, CaseStudySection } from '$lib/types/case-study';

export type SanityCaseStudyRow = {
  slug: string;
  title: string;
  seoDescription?: string | null;
  heroTag: string;
  heroDescription: string;
  tags: string[];
  images?: {
    principal?: string | null;
    secondary1?: string | null;
    secondary2?: string | null;
  } | null;
  metrics?: Array<{ value?: string | null; label?: string | null }> | null;
  reto?: Partial<CaseStudySection> | null;
  hice?: Partial<CaseStudySection> | null;
  resultado?: Partial<CaseStudySection> | null;
  stack?: string[] | null;
  liveUrl?: string | null;
};

const placeholder = 'https://placehold.co/1200x800/e8e8ed/1d1d1f?text=Imagen';

function normalizeMetrics(raw: SanityCaseStudyRow['metrics']): CaseStudy['metrics'] {
  const list: CaseStudyMetric[] = (raw ?? []).map((m) => ({
    value: m?.value?.trim() || '-',
    label: m?.label?.trim() || '-'
  }));
  while (list.length < 4) {
    list.push({ value: '-', label: '-' });
  }
  return [list[0], list[1], list[2], list[3]] as CaseStudy['metrics'];
}

function section(
  key: string,
  data: Partial<CaseStudySection> | null | undefined,
  fallbackTitle: string
): CaseStudySection {
  const title = typeof data?.title === 'string' && data.title.trim() ? data.title.trim() : fallbackTitle;
  const bodyHtml =
    typeof data?.bodyHtml === 'string' && data.bodyHtml.trim() ? data.bodyHtml.trim() : `<p>(${key})</p>`;
  return { title, bodyHtml };
}

export function mapSanityRowToCaseStudy(row: SanityCaseStudyRow): CaseStudy {
  const img = row.images ?? {};
  return {
    slug: row.slug,
    title: row.title,
    seoDescription: row.seoDescription ?? undefined,
    heroTag: row.heroTag,
    heroDescription: row.heroDescription,
    tags: Array.isArray(row.tags) ? row.tags : [],
    images: {
      principal: img.principal?.trim() || placeholder,
      secondary1: img.secondary1?.trim() || img.principal?.trim() || placeholder,
      secondary2: img.secondary2?.trim() || img.principal?.trim() || placeholder
    },
    metrics: normalizeMetrics(row.metrics),
    reto: section('reto', row.reto, 'El reto'),
    hice: section('hice', row.hice, 'Lo que hice'),
    resultado: section('resultado', row.resultado, 'Resultado'),
    stack: Array.isArray(row.stack) ? row.stack : [],
    liveUrl: row.liveUrl?.trim() || '/'
  };
}
