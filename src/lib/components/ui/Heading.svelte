<script lang="ts">
  type Level = 1 | 2 | 3 | 4;
  type Align = 'left' | 'center' | 'right';

  type Props = {
    level?: Level;
    align?: Align;
    eyebrow?: string;
    kicker?: string;
    className?: string;
  };

  let {
    level = 2,
    align = 'left',
    eyebrow = undefined,
    kicker = undefined,
    className = ''
  }: Props = $props();
</script>

<div class={`nk-heading nk-heading--l${level} nk-heading--${align} ${className}`.trim()}>
  {#if eyebrow}
    <p class="nk-heading-eyebrow">{eyebrow}</p>
  {/if}

  {#if level === 1}
    <h1 class="nk-heading-title"><slot /></h1>
  {:else if level === 2}
    <h2 class="nk-heading-title"><slot /></h2>
  {:else if level === 3}
    <h3 class="nk-heading-title"><slot /></h3>
  {:else}
    <h4 class="nk-heading-title"><slot /></h4>
  {/if}

  {#if kicker}
    <p class="nk-heading-kicker">{kicker}</p>
  {/if}
</div>

<style>
  .nk-heading {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .nk-heading--center {
    text-align: center;
    align-items: center;
  }

  .nk-heading--right {
    text-align: right;
    align-items: flex-end;
  }

  .nk-heading--left {
    text-align: left;
    align-items: flex-start;
  }

  .nk-heading-eyebrow {
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.16em;
    color: var(--text-secondary, #6b7280);
  }

  .nk-heading-title {
    letter-spacing: -0.04em;
    color: var(--text-main, #0f172a);
    margin: 0;
  }

  .nk-heading--l1 .nk-heading-title {
    font-size: clamp(2.4rem, 5vw, 3.4rem);
    line-height: 1.03;
  }

  .nk-heading--l2 .nk-heading-title {
    font-size: clamp(2rem, 3vw, 2.6rem);
    line-height: 1.08;
  }

  .nk-heading--l3 .nk-heading-title {
    font-size: 1.4rem;
    line-height: 1.2;
  }

  .nk-heading--l4 .nk-heading-title {
    font-size: 1.1rem;
    line-height: 1.3;
  }

  .nk-heading-kicker {
    max-width: 36rem;
    font-size: 0.98rem;
    color: var(--text-secondary, #6b7280);
    line-height: 1.7;
  }

  .nk-heading--center .nk-heading-kicker {
    margin-inline: auto;
  }
</style>

