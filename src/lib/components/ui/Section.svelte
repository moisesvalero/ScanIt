<script lang="ts">
  type Variant = 'default' | 'muted' | 'soft' | 'surface';

  type Props = {
    as?: keyof HTMLElementTagNameMap;
    variant?: Variant;
    id?: string;
    className?: string;
  };

  let {
    as = 'section',
    variant = 'default',
    id = undefined,
    className = ''
  }: Props = $props();
</script>

<svelte:element
  this={as}
  id={id}
  class={`nk-section nk-section--${variant} ${className}`.trim()}
>
  <slot />
</svelte:element>

<style>
  .nk-section {
    padding-block: 96px;
  }

  .nk-section--default {
    background: #ffffff;
  }

  .nk-section--muted {
    background: var(--bg-soft, #f5f5f9);
  }

  .nk-section--soft {
    background:
      radial-gradient(circle at top, rgba(99, 102, 241, 0.04), transparent 60%),
      #ffffff;
  }

  .nk-section--surface {
    background: #f9fafb;
  }

  @media (max-width: 768px) {
    .nk-section {
      padding-block: 72px;
    }
  }
</style>

