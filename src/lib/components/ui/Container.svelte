<script lang="ts">
  type Props = {
    as?: keyof HTMLElementTagNameMap;
    className?: string;
  };

  let {
    as = 'div',
    className = ''
  }: Props = $props();
</script>

<svelte:element
  this={as}
  class={`nk-container ${className}`.trim()}
>
  <slot />
</svelte:element>

<style>
  .nk-container {
    width: 100%;
    max-width: 1200px;
    margin-inline: auto;
    padding-inline: 1.5rem;
  }

  @media (max-width: 640px) {
    .nk-container {
      padding-inline: 1.25rem;
    }
  }

  @media (min-width: 1600px) {
    .nk-container {
      max-width: 1320px;
    }
  }
</style>

