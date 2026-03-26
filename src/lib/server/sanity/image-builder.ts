import imageUrlBuilder from '@sanity/image-url';

export function createImageUrlBuilder(projectId: string, dataset: string) {
  return imageUrlBuilder({ projectId, dataset });
}

export function imageUrl(
  projectId: string,
  dataset: string,
  source: unknown,
  width?: number
): string | undefined {
  if (!source || typeof source !== 'object') {
    return undefined;
  }
  try {
    let b = createImageUrlBuilder(projectId, dataset).image(source as never);
    if (width) {
      b = b.width(width);
    }
    return b.auto('format').url();
  } catch {
    return undefined;
  }
}
