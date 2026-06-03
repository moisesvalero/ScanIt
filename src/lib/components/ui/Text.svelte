<script lang="ts">
  import type { Snippet } from "svelte";

  type Variant = "body" | "muted" | "small" | "label";
  type Align = "left" | "center" | "right";

  type Props = {
    children?: Snippet;
    as?: keyof HTMLElementTagNameMap;
    variant?: Variant;
    align?: Align;
    className?: string;
  };

  let {
    children,
    as = "p",
    variant = "body",
    align = "left",
    className = "",
  }: Props = $props();
</script>

<svelte:element
  this={as}
  class={`nk-text nk-text--${variant} nk-text--${align} ${className}`.trim()}
>
  {@render children?.()}
</svelte:element>

<style>
  .nk-text {
    margin: 0;
    color: var(--text-main, #0f172a);
  }

  .nk-text--muted {
    color: var(--text-secondary, #6b7280);
  }

  .nk-text--small {
    font-size: 0.82rem;
    color: var(--text-secondary, #6b7280);
  }

  .nk-text--label {
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--text-secondary, #6b7280);
  }

  .nk-text--center {
    text-align: center;
  }

  .nk-text--right {
    text-align: right;
  }
</style>
