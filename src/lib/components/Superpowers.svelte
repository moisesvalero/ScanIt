<script lang="ts">
  import PhoneMockup from '$lib/components/PhoneMockup.svelte';
  import { reveal } from '$lib/reveal';
  import { t } from '$lib/i18n/index.js';
</script>

<section class="superpowers" id="superpowers">
  <div class="header" use:reveal={{ stage: 'title' }}>
    <p class="eyebrow">{$t('superpowers.eyebrow')}</p>
    <h2>{$t('superpowers.title')}</h2>
  </div>

  <div class="layout">
    <div class="device" use:reveal={{ stage: 'content', delay: 140 }}>
      <PhoneMockup />
    </div>

    <div class="grid">
      <article class="card motion-card" use:reveal={{ stage: 'content', delay: 180 }}>
        <h3>{$t('superpowers.card1Title')}</h3>
        <p>
          {$t('superpowers.card1Desc')}
        </p>
      </article>

      <article class="card motion-card" use:reveal={{ stage: 'content', delay: 220 }}>
        <h3>{$t('superpowers.card2Title')}</h3>
        <p>
          {$t('superpowers.card2Desc')}
        </p>
      </article>

      <article class="card motion-card" use:reveal={{ stage: 'content', delay: 260 }}>
        <h3>{$t('superpowers.card3Title')}</h3>
        <p>
          {$t('superpowers.card3Desc')}
        </p>
      </article>

      <article class="card motion-card" use:reveal={{ stage: 'content', delay: 300 }}>
        <h3>{$t('superpowers.card4Title')}</h3>
        <p>
          {$t('superpowers.card4Desc')}
        </p>
      </article>

      <article class="card motion-card" use:reveal={{ stage: 'content', delay: 340 }}>
        <h3>{$t('superpowers.card5Title')}</h3>
        <p>
          {$t('superpowers.card5Desc')}
        </p>
      </article>

      <article class="card motion-card" use:reveal={{ stage: 'content', delay: 380 }}>
        <h3>{$t('superpowers.card6Title')}</h3>
        <p>
          {$t('superpowers.card6Desc')}
        </p>
      </article>
    </div>
  </div>
</section>

<style>
  .superpowers {
    padding: 120px 1.5rem 120px;
    background: radial-gradient(circle at top, rgba(99, 102, 241, 0.04), transparent 60%);
  }

  .header {
    max-width: 820px;
    margin: 0 auto 2.5rem;
    text-align: center;
  }

  .eyebrow {
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--text-secondary);
    margin-bottom: 0.75rem;
  }

  h2 {
    font-size: clamp(2rem, 3vw, 2.4rem);
    letter-spacing: -0.04em;
    color: var(--text-main);
  }

  .layout {
    max-width: 1100px;
    margin: 0 auto;
    display: grid;
    grid-template-columns: minmax(0, 1.1fr) minmax(0, 1.4fr);
    gap: 2.5rem;
    align-items: center;
  }

  .device {
    display: flex;
    justify-content: center;
    align-items: flex-end;
    perspective: 1200px;
  }

  .device-frame {
    width: 260px;
    height: 420px;
    border-radius: 34px;
    padding: 0.85rem;
    background: radial-gradient(circle at top, #111827, #020617);
    box-shadow: 0 30px 80px rgba(15, 23, 42, 0.65);
    position: relative;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  .device-header {
    width: 40%;
    height: 5px;
    border-radius: 999px;
    background: rgba(148, 163, 184, 0.4);
    margin: 0 auto 0.9rem;
  }

  .device-screen {
    background: rgba(15, 23, 42, 0.95);
    border-radius: 26px;
    position: relative;
    overflow: hidden;
    flex: 1;
    min-height: 0;
  }

  .device-screen-viewport {
    position: relative;
    overflow: hidden;
    width: 100%;
    height: 100%;
    cursor: default;
    touch-action: pan-y;
    overscroll-behavior: contain;
    border-radius: inherit;
  }

  .device-preview {
    position: absolute;
    top: 0;
    left: 0;
    width: 390px;
    height: 844px;
    border: none;
    transform-origin: top left;
    display: block;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 1.25rem;
  }

  .card {
    border-radius: 22px;
    background: white;
    border: 1px solid rgba(15, 23, 42, 0.06);
    padding: 1.6rem 1.7rem;
    box-shadow: 0 18px 40px rgba(15, 23, 42, 0.02);
    transition:
      opacity 0.7s cubic-bezier(0.34, 1.56, 0.64, 1),
      transform 0.7s cubic-bezier(0.34, 1.56, 0.64, 1),
      box-shadow 0.4s cubic-bezier(0.34, 1.56, 0.64, 1),
      border-color 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
  }

  .card.is-visible:nth-child(1) {
    animation: card-float 8s cubic-bezier(0.34, 1.56, 0.64, 1) 0.8s infinite alternate;
  }

  .card.is-visible:nth-child(2) {
    animation: card-float 9s cubic-bezier(0.34, 1.56, 0.64, 1) 1s infinite alternate;
  }

  .card.is-visible:nth-child(3) {
    animation: card-float 7.5s cubic-bezier(0.34, 1.56, 0.64, 1) 0.9s infinite alternate;
  }

  .card.is-visible:nth-child(4) {
    animation: card-float 8.5s cubic-bezier(0.34, 1.56, 0.64, 1) 1.1s infinite alternate;
  }

  .card.is-visible:nth-child(5) {
    animation: card-float 9.5s cubic-bezier(0.34, 1.56, 0.64, 1) 1.2s infinite alternate;
  }

  .card.is-visible:nth-child(6) {
    animation: card-float 7.8s cubic-bezier(0.34, 1.56, 0.64, 1) 1.3s infinite alternate;
  }

  .card h3 {
    font-size: 1rem;
    margin-bottom: 0.45rem;
    color: var(--text-main);
  }

  .card p {
    font-size: 0.9rem;
    color: var(--text-secondary);
    line-height: 1.7;
  }

  .card.is-visible:hover {
    transform: translateY(-4px) scale(1.02);
    box-shadow: 0 26px 60px rgba(15, 23, 42, 0.12);
    border-color: rgba(99, 102, 241, 0.5);
  }

  /* Entrada inercial del mockup cuando la columna izquierda entra en viewport */
  .device.is-visible .device-frame {
    animation: device-inertia 1s cubic-bezier(0.34, 1.56, 0.64, 1) both;
  }

  @keyframes device-inertia {
    0% {
      transform: translateX(-80px) scale(0.9);
    }
    70% {
      transform: translateX(8px) scale(1.02);
    }
    100% {
      transform: translateX(0) scale(1);
    }
  }

  @media (max-width: 900px) {
    .layout {
      grid-template-columns: minmax(0, 1fr);
      gap: 2rem;
    }

    .device {
      order: -1;
    }

    .grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  @media (max-width: 768px) {
    .superpowers {
      padding-top: 80px;
      padding-bottom: 80px;
    }
  }

  @media (max-width: 640px) {
    .grid {
      grid-template-columns: minmax(0, 1fr);
    }
  }

  @media (min-width: 1600px) {
    .superpowers {
      padding-block: 120px;
    }

    .layout {
      max-width: 1320px;
      gap: 3rem;
    }

    .device-frame {
      width: 290px;
      height: 460px;
    }

    .grid {
      gap: 1.4rem;
    }
  }
</style>

