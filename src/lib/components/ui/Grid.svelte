<script lang="ts">
  type Props = {
    columns?: number | 'auto';
    gap?: string;
    className?: string;
  };

  let {
    columns = 3,
    gap = '1.5rem',
    className = ''
  }: Props = $props();
</script>

<div
  class={`nk-grid ${className}`.trim()}
  style={`--nk-grid-gap:${gap};`}
>
  <slot />
</div>

<style>
  .nk-grid {
    display: grid;
    gap: var(--nk-grid-gap);
  }

  /* Por defecto: columnas responsivas base */
  :global(.nk-grid-cols-1) {
    grid-template-columns: minmax(0, 1fr);
  }

  :global(.nk-grid-cols-2) {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  :global(.nk-grid-cols-3) {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  :global(.nk-grid-cols-4) {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }

  @media (max-width: 900px) {
    :global(.nk-grid-md-down-cols-2) {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  @media (max-width: 640px) {
    :global(.nk-grid-sm-down-cols-1) {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>

