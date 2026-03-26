import { env } from '$env/dynamic/public';
import { writable } from 'svelte/store';

const DEFAULT_SITE_URL = 'http://localhost:5173';
const baseUrl = new URL(env.PUBLIC_SITE_URL || DEFAULT_SITE_URL).toString().replace(/\/$/, '');

export const defaultSeo = {
	title: 'Starter SvelteKit',
	description: 'Plantilla base para lanzar interfaces modernas con SvelteKit.',
	ogTitle: 'Starter SvelteKit',
	ogDescription: 'Plantilla base para lanzar interfaces modernas con SvelteKit.',
	ogImage: `${baseUrl}/og-image.png`,
	ogUrl: baseUrl,
	twitterCard: 'summary_large_image',
	canonical: baseUrl
};

export const seo = writable(defaultSeo);

export const setSeo = (data = {}) => {
	seo.set({
		...defaultSeo,
		...data
	});
};
