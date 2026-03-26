export const caseStudyBySlugQuery = `*[_type == "caseStudy" && slug.current == $slug][0]{
  "slug": slug.current,
  title,
  seoDescription,
  heroTag,
  heroDescription,
  tags,
  images,
  metrics,
  reto,
  hice,
  resultado,
  stack,
  liveUrl
}`;
