<script lang="ts">
  import { onDestroy } from 'svelte';
  import { locale, setLocale } from '$lib/i18n/index.js';

  const options = [
    { code: 'en', label: 'EN' },
    { code: 'es', label: 'ES' },
    { code: 'zh', label: 'ZH' },
    { code: 'de', label: 'DE' },
    { code: 'pt', label: 'PT' },
    { code: 'fr', label: 'FR' }
  ] as const;

  let open = $state(false);
  const current = $derived(options.find((o) => o.code === $locale)?.label ?? 'EN');
  let rootEl: HTMLDivElement | null = $state(null);

  function toggle() {
    open = !open;
  }

  function close() {
    open = false;
  }

  function onDocPointerDown(e: PointerEvent) {
    if (!open) return;
    const t = e.target as Node | null;
    if (!t) return;
    if (rootEl && rootEl.contains(t)) return;
    close();
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('pointerdown', onDocPointerDown, { capture: true });
  }

  onDestroy(() => {
    if (typeof document !== 'undefined') {
      document.removeEventListener('pointerdown', onDocPointerDown, { capture: true } as any);
    }
  });
</script>

<div class="lang" bind:this={rootEl}>
  <button type="button" class="lang-btn" aria-label="Language" aria-haspopup="listbox" aria-expanded={open} onclick={toggle}>
    {current}
  </button>
  {#if open}
    <div class="lang-menu" role="listbox" aria-label="Select language" onclick={(e) => e.stopPropagation()}>
      {#each options as opt (opt.code)}
        <button
          type="button"
          class="lang-opt"
          class:active={$locale === opt.code}
          role="option"
          aria-selected={$locale === opt.code}
          onclick={() => {
            setLocale(opt.code);
            close();
          }}
        >
          {opt.label}
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .lang {
    position: relative;
    display: inline-flex;
    align-items: center;
  }

  .lang-btn {
    height: 30px;
    padding: 0 10px;
    border-radius: 10px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(22, 22, 22, 0.55);
    color: rgba(255, 255, 255, 0.72);
    font-size: 12px;
    letter-spacing: 0.16em;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace;
    text-transform: uppercase;
    cursor: pointer;
    transition: border-color 180ms ease, color 180ms ease, background-color 180ms ease;
  }

  .lang-btn:hover {
    border-color: rgba(0, 229, 255, 0.35);
    color: rgba(255, 255, 255, 0.9);
    background: rgba(22, 22, 22, 0.72);
  }

  .lang-menu {
    position: absolute;
    right: 0;
    top: calc(100% + 8px);
    min-width: 64px;
    border-radius: 14px;
    border: 1px solid rgba(255, 255, 255, 0.09);
    background: rgba(16, 16, 16, 0.92);
    backdrop-filter: blur(12px);
    box-shadow: 0 22px 50px rgba(0, 0, 0, 0.5);
    padding: 6px;
    z-index: 200;
  }

  .lang-opt {
    width: 100%;
    text-align: right;
    height: 30px;
    padding: 0 10px;
    border-radius: 10px;
    border: 0;
    background: transparent;
    color: rgba(255, 255, 255, 0.68);
    font-size: 12px;
    letter-spacing: 0.16em;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace;
    text-transform: uppercase;
    cursor: pointer;
    transition: background-color 160ms ease, color 160ms ease;
  }

  .lang-opt:hover {
    background: rgba(0, 229, 255, 0.08);
    color: rgba(255, 255, 255, 0.92);
  }

  .lang-opt.active {
    background: rgba(0, 229, 255, 0.12);
    color: rgba(0, 229, 255, 0.92);
  }
</style>

