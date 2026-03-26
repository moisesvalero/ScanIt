<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { fade, scale } from 'svelte/transition';

  type Verdict = 'VERIFICADO' | 'SOSPECHOSO' | 'ALERTA ROJA' | null;

  interface Props {
    open?: boolean;
    verdict?: Verdict;
    confidence?: number;
    riskScore?: number;
    fileName?: string;
    reason?: string;
    completedAt?: string;
    warnings?: string[];
  }

  let {
    open = false,
    verdict = null,
    confidence = 0,
    riskScore = 0,
    fileName = '',
    reason = '',
    completedAt = '',
    warnings = []
  }: Props = $props();

  const dispatch = createEventDispatcher<{ close: void; download: void }>();

  // Semáforo: verde=VERIFICADO, naranja=SOSPECHOSO, rojo=ALERTA ROJA
  let verdictTone = $derived(
    verdict === 'VERIFICADO' ? 'success' : verdict === 'SOSPECHOSO' ? 'warn' : verdict === 'ALERTA ROJA' ? 'danger' : 'success'
  );
  let isVerified = $derived(verdict === 'VERIFICADO');
  let isSuspicious = $derived(verdict === 'SOSPECHOSO');
  let statusLabel = $derived(verdict === 'ALERTA ROJA' ? 'ALERTA DE DEEPFAKE' : verdict ?? 'PENDIENTE');
  let normalizedDate = $derived(
    completedAt ? new Date(completedAt).toLocaleString('es-ES') : '-'
  );

  const close = () => dispatch('close');
  const download = () => dispatch('download');
</script>

{#if open}
  <div class="backdrop" role="presentation" on:click={close} in:fade={{ duration: 260 }} out:fade={{ duration: 220 }}>
    <section
      class="modal"
      class:danger={verdictTone === 'danger'}
      class:warn={verdictTone === 'warn'}
      class:verified={isVerified}
      role="dialog"
      aria-modal="true"
      aria-label="Informe de Auditoría de Integridad KRONOS"
      on:click|stopPropagation
      in:scale={{ duration: 320, start: 0.94 }}
      out:scale={{ duration: 220, start: 0.98 }}
    >
      <header class="head">
        <p>INFORME DE AUDITORÍA DE INTEGRIDAD</p>
        <button type="button" class="close" on:click={close} aria-label="Cerrar modal">x</button>
      </header>

      <div class="status">
        <span class="dot"></span>
        <strong>{statusLabel}</strong>
      </div>

      <div class="grid">
        <article>
          <h4>Archivo</h4>
          <p class="file">{fileName || '-'}</p>
        </article>
        <article>
          <h4>Confianza</h4>
          <p>{confidence.toFixed(1)}%</p>
        </article>
        <article>
          <h4>Riesgo</h4>
          <p>{riskScore}/100</p>
        </article>
        <article>
          <h4>Timestamp</h4>
          <p>{normalizedDate}</p>
        </article>
      </div>

      <section class="notes">
        <h4>Resumen de Auditoría de Integridad</h4>
        <p>{reason || 'Proceso en espera de finalizacion de escaneo.'}</p>
      </section>

      {#if warnings?.length}
        <section class="notes">
          <h4>Avisos</h4>
          <ul class="warn-list">
            {#each warnings as w}
              <li>{w}</li>
            {/each}
          </ul>
        </section>
      {/if}

      <footer>
        <button type="button" class="download" on:click={download}>Descargar Certificado de Validación</button>
      </footer>
    </section>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 120;
    background: rgba(2, 2, 2, 0.72);
    backdrop-filter: blur(12px);
    display: grid;
    place-items: center;
    padding: 1rem;
  }

  .modal {
    width: min(100%, 640px);
    border-radius: 18px;
    border: 1px solid #1a1a1a;
    background: rgba(22, 22, 22, 0.92);
    box-shadow:
      0 0 0 1px rgba(0, 229, 255, 0.08) inset,
      0 20px 50px rgba(0, 0, 0, 0.52),
      0 0 38px rgba(0, 229, 255, 0.12);
    color: #f3f3f3;
    padding: 1.3rem;
  }

  .modal.danger {
    box-shadow:
      0 0 0 1px rgba(230, 57, 70, 0.12) inset,
      0 20px 50px rgba(0, 0, 0, 0.52),
      0 0 38px rgba(230, 57, 70, 0.2);
  }

  .modal.warn {
    box-shadow:
      0 0 0 1px rgba(245, 158, 11, 0.12) inset,
      0 20px 50px rgba(0, 0, 0, 0.52),
      0 0 38px rgba(245, 158, 11, 0.18);
  }

  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 1rem;
  }

  .head p {
    letter-spacing: 0.15em;
    font-size: 0.72rem;
    color: rgba(255, 255, 255, 0.7);
  }

  .close {
    width: 34px;
    height: 34px;
    border-radius: 999px;
    border: 1px solid #242424;
    background: rgba(255, 255, 255, 0.02);
    color: #dbdbdb;
    cursor: pointer;
  }

  .status {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 1rem;
    padding: 0.42rem 0.75rem;
    border-radius: 999px;
    border: 1px solid rgba(0, 229, 255, 0.22);
    background: rgba(0, 229, 255, 0.06);
  }

  .modal.danger .status {
    border-color: rgba(230, 57, 70, 0.32);
    background: rgba(230, 57, 70, 0.1);
  }

  .modal.warn .status {
    border-color: rgba(245, 158, 11, 0.32);
    background: rgba(245, 158, 11, 0.09);
  }

  .dot {
    width: 10px;
    height: 10px;
    border-radius: 999px;
    background: #00e5ff;
    box-shadow: 0 0 14px rgba(0, 229, 255, 0.75);
    position: relative;
  }

  .modal.verified .dot {
    background: #22c55e;
    box-shadow: 0 0 14px rgba(34, 197, 94, 0.85);
  }

  .modal.warn .dot {
    background: #f59e0b;
    box-shadow: 0 0 14px rgba(245, 158, 11, 0.85);
  }

  .modal.danger .dot {
    background: #e63946;
    box-shadow: 0 0 14px rgba(230, 57, 70, 0.8);
  }

  .dot::after {
    content: '✓';
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    font-size: 7px;
    color: rgba(2, 2, 2, 0.9);
    font-weight: 900;
    line-height: 1;
  }

  .modal.danger .dot::after {
    content: '✕';
    color: rgba(2, 2, 2, 0.92);
  }

  .modal.warn .dot::after {
    content: '!';
    color: rgba(2, 2, 2, 0.92);
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.7rem;
  }

  article {
    border: 1px solid #1a1a1a;
    border-radius: 12px;
    background: rgba(255, 255, 255, 0.02);
    padding: 0.78rem;
  }

  h4 {
    font-size: 0.72rem;
    color: rgba(255, 255, 255, 0.66);
    margin-bottom: 0.24rem;
    letter-spacing: 0.09em;
    text-transform: uppercase;
  }

  p {
    font-size: 0.93rem;
  }

  /* Evita que nombres largos rompan el modal */
  .file {
    overflow-wrap: anywhere;
    word-break: break-word;
  }

  .notes {
    margin-top: 0.9rem;
    border: 1px solid #1a1a1a;
    border-radius: 12px;
    background: rgba(255, 255, 255, 0.02);
    padding: 0.8rem;
  }

  .notes p {
    margin-top: 0.25rem;
    color: rgba(255, 255, 255, 0.85);
  }

  .warn-list {
    margin-top: 0.25rem;
    padding-left: 1.2rem;
    display: grid;
    gap: 0.25rem;
    color: rgba(255, 255, 255, 0.82);
    font-size: 0.9rem;
  }

  footer {
    margin-top: 1rem;
  }

  .download {
    width: 100%;
    border: 1px solid rgba(0, 229, 255, 0.42);
    border-radius: 10px;
    padding: 0.73rem;
    background: rgba(0, 229, 255, 0.14);
    color: #fff;
    font-weight: 600;
    cursor: pointer;
    transition: transform 180ms ease, box-shadow 180ms ease;
  }

  .download:hover {
    transform: translateY(-1px);
    box-shadow: 0 0 22px rgba(0, 229, 255, 0.18);
  }

  .modal.danger .download {
    border-color: rgba(230, 57, 70, 0.42);
    background: linear-gradient(120deg, rgba(230, 57, 70, 0.2), rgba(230, 57, 70, 0.1));
  }

  @media (max-width: 640px) {
    .grid {
      grid-template-columns: 1fr;
    }
  }
</style>
