import type { CaseStudy } from '$lib/types/case-study';
import { getSanityServerClient } from './get-server-client';
import { caseStudyBySlugQuery } from './groq';
import { mapSanityRowToCaseStudy, type SanityCaseStudyRow } from './map-sanity-case-study';

export async function fetchCaseStudyFromSanity(slug: string): Promise<CaseStudy | undefined> {
  const client = getSanityServerClient();
  if (!client) {
    return undefined;
  }

  try {
    const row = await client.fetch<SanityCaseStudyRow | null>(caseStudyBySlugQuery, { slug });
    if (!row || typeof row.slug !== 'string' || typeof row.title !== 'string') {
      return undefined;
    }
    if (typeof row.heroTag !== 'string' || typeof row.heroDescription !== 'string') {
      return undefined;
    }

    return mapSanityRowToCaseStudy(row);
  } catch (error) {
    console.warn(`[case-study] Sanity unavailable for slug "${slug}", using local fallback.`, error);
    return undefined;
  }
}
