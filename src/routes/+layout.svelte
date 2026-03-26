<script lang="ts">
  import '../app.css';
  import { seo } from '$lib/seo';
  import { onMount } from 'svelte';

  onMount(() => {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Registro opcional: no rompe la app si falla.
    });
  });
</script>

<svelte:head>
  <title>{$seo.title}</title>
  <meta name="description" content={$seo.description} />
  <link rel="canonical" href={$seo.canonical} />

  <meta property="og:type" content="website" />
  <meta property="og:title" content={$seo.ogTitle} />
  <meta property="og:description" content={$seo.ogDescription} />
  <meta property="og:url" content={$seo.ogUrl} />
  <meta property="og:image" content={$seo.ogImage} />

  <meta name="twitter:card" content={$seo.twitterCard} />
  <meta name="twitter:title" content={$seo.ogTitle} />
  <meta name="twitter:description" content={$seo.ogDescription} />
  <meta name="twitter:image" content={$seo.ogImage} />
</svelte:head>

<slot />