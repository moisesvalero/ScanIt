<script lang="ts">
  import { env } from '$env/dynamic/public';
  import { fade, fly } from 'svelte/transition';
  import VideoProcessor from '$lib/components/Scanner/VideoProcessor.svelte';
  import { seo, setSeo } from '$lib/seo';
  import { t } from '$lib/i18n/index.js';
  import LanguageSelect from '$lib/components/LanguageSelect.svelte';

  const baseUrl = new URL(env.PUBLIC_SITE_URL || 'http://localhost:5173').toString().replace(/\/$/, '');
  const tickerItems = $derived([
    { pre: $t('kronos.ticker.items.0.pre'), tail: $t('kronos.ticker.items.0.tail') },
    { pre: $t('kronos.ticker.items.1.pre'), tail: $t('kronos.ticker.items.1.tail') },
    { pre: $t('kronos.ticker.items.2.pre'), tail: $t('kronos.ticker.items.2.tail') },
    { pre: $t('kronos.ticker.items.3.pre'), tail: $t('kronos.ticker.items.3.tail') },
    { pre: $t('kronos.ticker.items.4.pre'), tail: $t('kronos.ticker.items.4.tail') },
    { pre: $t('kronos.ticker.items.5.pre'), tail: $t('kronos.ticker.items.5.tail') }
  ]);

  setSeo({
    title: 'KRONOS | Deepfake Defense Suite',
    description: 'Proteccion de identidad digital mediante Auditoría de Integridad neuronal para entornos corporativos.',
    ogTitle: 'KRONOS: La Verdad es Atemporal',
    ogDescription: 'Suite SaaS para verificación de activos digitales con telemetría de integridad en tiempo real.',
    canonical: `${baseUrl}/`,
    ogUrl: `${baseUrl}/`,
    ogImage: `${baseUrl}/og-image.png`,
    twitterCard: 'summary_large_image'
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

<main class="kronos-page">
  <section class="hero" in:fade={{ duration: 300 }}>
    <div class="hero-top">
      <span class="hero-lang">
        <LanguageSelect />
      </span>
    </div>
    <p class="eyebrow">{$t('kronos.hero.eyebrow')}</p>
    <h1>KRONOS</h1>
    <p class="subtitle">{$t('kronos.hero.subtitle')}</p>
  </section>

  <section class="processor-wrap" in:fly={{ y: 18, duration: 300 }}>
    <VideoProcessor />
  </section>

  <section class="ticker" aria-label={$t('kronos.ticker.aria')}>
    <div class="ticker-viewport">
      <div class="ticker-track" aria-hidden="false">
        {#each tickerItems as item, i}
          <span class="t-item">
            <span class="t-pre">{item.pre}</span>
            <span class="t-tail">{item.tail}</span>
            {#if i !== tickerItems.length - 1}
              <span class="t-sep"> // </span>
            {/if}
          </span>
        {/each}
      </div>
      <div class="ticker-track" aria-hidden="true">
        {#each tickerItems as item, i}
          <span class="t-item">
            <span class="t-pre">{item.pre}</span>
            <span class="t-tail">{item.tail}</span>
            {#if i !== tickerItems.length - 1}
              <span class="t-sep"> // </span>
            {/if}
          </span>
        {/each}
      </div>
    </div>
  </section>

  <footer class="kronos-footer" aria-label={$t('kronos.footer.aria')}>
    <div class="kronos-footer-inner">
      <p class="kronos-footer-left">
        {$t('kronos.footer.developedBy')}
        <a class="kronos-footer-link" href="https://moisesvalero.es/" target="_blank" rel="noopener noreferrer"
          >{$t('kronos.footer.name')}</a
        >.
      </p>

      <p class="kronos-footer-right" aria-label={$t('kronos.footer.socialAria')}>
        <a class="kronos-footer-link" href="https://github.com/moisesvalero" target="_blank" rel="noopener noreferrer"
          >GitHub</a
        >
        <span class="kronos-footer-sep" aria-hidden="true">•</span>
        <a
          class="kronos-footer-link"
          href="https://www.linkedin.com/in/moisesvalero/"
          target="_blank"
          rel="noopener noreferrer"
          >LinkedIn</a
        >
        <span class="kronos-footer-sep" aria-hidden="true">•</span>
        <a
          class="kronos-footer-link"
          href="https://www.malt.es/profile/moisesvalerosanchez"
          target="_blank"
          rel="noopener noreferrer"
          >Malt</a
        >
      </p>
    </div>
  </footer>
</main>

<style>
  .kronos-page {
    min-height: 100vh;
    background: #000;
    color: rgba(255, 255, 255, 0.92);
    /* No hay menú superior: compactamos para 1080p */
    padding: clamp(3.2rem, 6.2vw, 4.4rem) 1rem 2rem;
  }

  .hero {
    width: min(100%, 1020px);
    margin: 0 auto;
    text-align: center;
    padding: 0 0 0.9rem;
    position: relative;
  }

  .hero-top {
    position: absolute;
    right: 0;
    top: -8px;
    display: flex;
    justify-content: flex-end;
    width: 100%;
    pointer-events: none;
  }

  .hero-lang {
    pointer-events: auto;
  }

  .eyebrow {
    font-size: 0.72rem;
    font-weight: 600;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: rgba(255, 255, 255, 0.48);
  }

  h1 {
    margin-top: 0.45rem;
    font-size: clamp(3.1rem, 7.2vw, 5.4rem);
    line-height: 1.02;
    font-weight: 900;
    letter-spacing: -0.05em;
    color: #ffffff;
  }

  .subtitle {
    margin: 0.82rem auto 0;
    max-width: 62ch;
    color: rgba(163, 163, 163, 1);
    font-size: 1.02rem;
    line-height: 1.35;
    white-space: nowrap;
  }

  .processor-wrap {
    margin-top: 1.45rem;
  }

  .processor-wrap {
    width: min(100%, 1080px);
    margin: 1.1rem auto 0;
  }

  .ticker {
    width: min(100%, 1080px);
    margin: 0.95rem auto 0;
    border: 1px solid var(--kronos-border);
    border-radius: 18px;
    background: rgba(22, 22, 22, 0.78);
    backdrop-filter: blur(12px);
    overflow: hidden;
    padding: 0.75rem 0;
  }

  .ticker-viewport {
    position: relative;
    display: flex;
    width: 100%;
    overflow: hidden;
    white-space: nowrap;
    mask-image: linear-gradient(90deg, transparent, #000 8%, #000 92%, transparent);
  }

  .ticker-track {
    display: inline-flex;
    align-items: center;
    gap: 0;
    padding-left: 1.2rem;
    will-change: transform;
    animation: kronos-marquee 26s linear infinite;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;
    font-size: 0.75rem; /* equivalente a text-xs */
    color: rgba(255, 255, 255, 0.42);
  }

  .ticker-track:nth-child(2) {
    padding-left: 2.2rem;
  }

  .t-item {
    display: inline-flex;
    align-items: baseline;
  }

  .t-sep {
    color: rgba(255, 255, 255, 0.22);
  }

  .t-tail {
    margin-left: 0.45rem;
    color: rgba(0, 229, 255, 0.92); /* última palabra/tail en Cyan */
  }

  @keyframes kronos-marquee {
    0% {
      transform: translateX(0);
    }
    100% {
      transform: translateX(-100%);
    }
  }

  .kronos-footer {
    margin: 0.95rem auto 0;
    width: min(100%, 1080px);
    color: rgba(115, 115, 115, 1); /* neutral-500 */
    font-size: 0.7rem; /* ~text-[10px] */
    letter-spacing: 0.08em;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace;
    text-transform: uppercase;
  }

  .kronos-footer-inner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .kronos-footer-left,
  .kronos-footer-right {
    margin: 0;
    line-height: 1.25;
  }

  .kronos-footer-right {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
  }

  .kronos-footer-sep {
    color: rgba(82, 82, 82, 1); /* neutral-600 */
  }

  .kronos-footer-link {
    color: rgba(115, 115, 115, 1);
    text-decoration: none;
    transition: color 180ms ease;
  }

  .kronos-footer-link:hover {
    color: rgba(0, 229, 255, 0.92);
  }

  @media (max-width: 560px) {
    .subtitle {
      white-space: normal;
    }

    .ticker {
      border-radius: 16px;
      padding: 0.65rem 0;
    }

    .ticker-track {
      font-size: 0.7rem;
      animation-duration: 22s;
    }
    .kronos-footer-inner {
      justify-content: center;
      text-align: center;
    }

    .kronos-footer-right {
      justify-content: center;
      width: 100%;
    }
  }

  /* Objetivo: que en 1080p (altura útil típica ~900-980px) se vea todo sin scroll */
  @media (max-height: 980px) {
    .kronos-page {
      padding-top: 2.55rem;
      padding-bottom: 1.35rem;
    }

    .hero {
      padding-bottom: 0.68rem;
    }

    .subtitle {
      margin-top: 0.68rem;
      font-size: 0.98rem;
    }

    .processor-wrap {
      margin-top: 0.78rem;
      /* Ajuste “invisible”: encajamos el bento del escáner */
      transform: scale(0.965);
      transform-origin: top center;
    }

    .ticker {
      margin-top: 0.62rem;
      padding: 0.6rem 0;
    }

    .kronos-footer {
      margin-top: 0.62rem;
    }
  }

  /* 1080p con barras grandes / zoom del SO: un poco más compacto */
  @media (max-height: 920px) {
    .kronos-page {
      padding-top: 2.25rem;
      padding-bottom: 1.1rem;
    }

    .hero {
      padding-bottom: 0.6rem;
    }

    .eyebrow {
      font-size: 0.7rem;
    }

    .subtitle {
      margin-top: 0.6rem;
      font-size: 0.96rem;
    }

    .processor-wrap {
      margin-top: 0.62rem;
      transform: scale(0.94);
    }

    .ticker {
      margin-top: 0.52rem;
      padding: 0.56rem 0;
    }

    .kronos-footer {
      margin-top: 0.52rem;
      font-size: 0.68rem;
    }
  }

  /* Ajuste por altura: evitar scroll en pantallas “bajas” (sin depender del zoom) */
  @media (max-height: 860px) {
    .kronos-page {
      padding-top: clamp(2.6rem, 4.4vh, 3.4rem);
      padding-bottom: 1.6rem;
    }

    h1 {
      font-size: clamp(2.7rem, 6.2vw, 4.6rem);
    }

    .hero {
      padding-bottom: 0.75rem;
    }

    .processor-wrap {
      margin-top: 0.95rem;
    }

    .ticker {
      margin-top: 0.8rem;
      padding: 0.62rem 0;
    }

    .kronos-footer {
      margin-top: 0.75rem;
    }
  }

  /* Extra compacto para 1366x768 / portátiles (altura útil reducida) */
  @media (max-height: 760px) {
    .kronos-page {
      padding-top: 2.1rem;
      padding-bottom: 1.25rem;
    }

    .eyebrow {
      font-size: 0.68rem;
    }

    h1 {
      font-size: clamp(2.35rem, 5.6vw, 4rem);
      margin-top: 0.35rem;
    }

    .subtitle {
      margin-top: 0.6rem;
      font-size: 0.98rem;
    }

    .processor-wrap {
      margin-top: 0.75rem;
    }

    .ticker {
      margin-top: 0.7rem;
      padding: 0.56rem 0;
    }

    .kronos-footer {
      margin-top: 0.65rem;
      font-size: 0.66rem;
    }
  }

  /* Accesibilidad: si el usuario prefiere menos movimiento, paramos el marquee */
  @media (prefers-reduced-motion: reduce) {
    .ticker-track {
      animation: none;
      transform: none;
    }
    .ticker-viewport {
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
      mask-image: none;
    }
  }
</style>