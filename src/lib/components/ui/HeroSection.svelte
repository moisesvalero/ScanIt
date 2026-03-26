<script lang="ts">
  import Container from './Container.svelte';
  import Button from './Button.svelte';
  import Heading from './Heading.svelte';
  import Text from './Text.svelte';

  type Props = {
    eyebrow?: string;
    title?: string;
    subtitle?: string;
    primaryLabel?: string;
    primaryHref?: string;
    secondaryLabel?: string;
    secondaryHref?: string;
    align?: 'left' | 'center';
  };

  let {
    eyebrow = undefined,
    title = '',
    subtitle = undefined,
    primaryLabel = undefined,
    primaryHref = undefined,
    secondaryLabel = undefined,
    secondaryHref = undefined,
    align = 'left'
  }: Props = $props();
</script>

<section class="nk-hero">
  <Container className="nk-hero-inner">
    <div class={`nk-hero-copy nk-hero-copy--${align}`}>
      <Heading level={1} {eyebrow} align={align}>
        {title}
      </Heading>

      {#if subtitle}
        <Text variant="muted" align={align} className="nk-hero-subtitle">
          {subtitle}
        </Text>
      {/if}

      {#if primaryLabel || secondaryLabel}
        <div class="nk-hero-actions">
          {#if primaryLabel}
            <Button
              as={primaryHref ? 'a' : 'button'}
              href={primaryHref}
              variant="primary"
              size="lg"
            >
              {primaryLabel}
            </Button>
          {/if}

          {#if secondaryLabel}
            <Button
              as={secondaryHref ? 'a' : 'button'}
              href={secondaryHref}
              variant="secondary"
              size="lg"
            >
              {secondaryLabel}
            </Button>
          {/if}
        </div>
      {/if}
    </div>

    <div class="nk-hero-media">
      <slot />
    </div>
  </Container>
</section>

<style>
  .nk-hero {
    position: relative;
    padding-block: 120px;
    background: #ffffff;
  }

  .nk-hero-inner {
    display: grid;
    grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr);
    gap: clamp(2rem, 4vw, 4rem);
    align-items: center;
  }

  .nk-hero-copy {
    display: flex;
    flex-direction: column;
    gap: 1.4rem;
    max-width: 640px;
  }

  .nk-hero-copy--center {
    margin-inline: auto;
    align-items: center;
    text-align: center;
  }

  .nk-hero-subtitle {
    max-width: 34rem;
  }

  .nk-hero-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.9rem;
    align-items: center;
  }

  .nk-hero-media {
    min-height: 260px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .nk-hero-media :global(iframe),
  .nk-hero-media :global(img) {
    max-width: 100%;
    border-radius: 24px;
    box-shadow: 0 30px 80px rgba(15, 23, 42, 0.18);
  }

  @media (max-width: 900px) {
    .nk-hero-inner {
      grid-template-columns: minmax(0, 1fr);
    }

    .nk-hero {
      padding-block: 96px;
    }

    .nk-hero-copy--left {
      align-items: flex-start;
      text-align: left;
    }
  }

  @media (max-width: 640px) {
    .nk-hero {
      padding-block: 80px;
    }

    .nk-hero-media {
      min-height: 200px;
    }
  }
</style>

