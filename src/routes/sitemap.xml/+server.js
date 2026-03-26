import { env } from '$env/dynamic/public';

const DEFAULT_SITE_URL = 'http://localhost:5173';
const staticRoutes = [
	'/',
	'/proyectos/vshield',
	'/proyectos/ember-iron',
	'/proyectos/galeria-nova',
	'/proyectos/chatbot',
	'/proyectos/novakit'
];

/** @param {string | undefined} url */
const normalizeBaseUrl = (url) => {
	try {
		const candidate = typeof url === 'string' ? url.trim() : '';
		const parsed = new URL(candidate || DEFAULT_SITE_URL);
		return parsed.toString().replace(/\/$/, '');
	} catch {
		const parsed = new URL(DEFAULT_SITE_URL);
		return parsed.toString().replace(/\/$/, '');
	}
};

export const GET = () => {
	const baseUrl = normalizeBaseUrl(env.PUBLIC_SITE_URL);
	const now = new Date().toISOString();

	const urls = staticRoutes
		.map(
			(route) => `<url>
  <loc>${baseUrl}${route}</loc>
  <lastmod>${now}</lastmod>
  <changefreq>weekly</changefreq>
  <priority>${route === '/' ? '1.0' : '0.8'}</priority>
</url>`
		)
		.join('\n');

	const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;

	return new Response(body, {
		headers: {
			'Content-Type': 'application/xml; charset=utf-8',
			'Cache-Control': 'max-age=0, s-maxage=3600'
		}
	});
};
