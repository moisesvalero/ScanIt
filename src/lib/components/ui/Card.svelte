<script lang="ts">
  type Variant = 'default' | 'soft' | 'outline';

  type Props = {
    as?: keyof HTMLElementTagNameMap;
    variant?: Variant;
    clickable?: boolean;
    className?: string;
  };

  let {
    as = 'div',
    variant = 'default',
    clickable = false,
    className = ''
  }: Props = $props();
</script>

<svelte:element
  this={as}
  class={`nk-card nk-card--${variant} ${clickable ? 'nk-card--clickable' : ''} ${className}`.trim()}
>
  <slot name="eyebrow" />
  <slot name="title" />
  <slot />
  <slot name="footer" />
</svelte:element>

<style>
  .nk-card {
    border-radius: 22px;
    padding: 1.6rem 1.7rem;
    border: 1px solid rgba(15, 23, 42, 0.06);
    background: #ffffff;
    box-shadow: 0 18px 40px rgba(15, 23, 42, 0.02);
    transition:
      transform 0.18s ease-out,
      box-shadow 0.2s ease-out,
      border-color 0.2s ease-out,
      background-color 0.2s ease-out;
  }

  .nk-card--soft {
    background: radial-gradient(circle at top left, rgba(99, 102, 241, 0.04), #ffffff);
  }

  .nk-card--outline {
    background: transparent;
    box-shadow: none;
  }

  .nk-card--clickable {
    cursor: pointer;
  }

  .nk-card--clickable:hover {
    transform: translateY(-4px);
    box-shadow: 0 26px 60px rgba(15, 23, 42, 0.14);
    border-color: rgba(99, 102, 241, 0.5);
  }
</style>

