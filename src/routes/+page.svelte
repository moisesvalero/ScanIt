<script lang="ts">
  import { jsPDF } from 'jspdf';
  import { env } from '$env/dynamic/public';
  import { seo, setSeo } from '$lib/seo';
  import { onDestroy, onMount } from 'svelte';
  import { fade, fly } from 'svelte/transition';
  import mammoth from 'mammoth';
  import { tick } from 'svelte';

  type Verdict = 'integro' | 'anomalias_detectadas' | 'no_concluyente';
  type Anomaly = { code: string; severity: 'green' | 'amber' | 'red'; message: string };

  type DocumentResult = {
    suite: string;
    mode: string;
    fileName: string;
    extension: 'docx' | 'pdf';
    timeline: { created: string | null; modified: string | null };
    metrics: {
      wordCount: number;
      editingMinutes: number | null;
      pageCount: number | null;
      ratioWordsPerMinute: number | null;
      textEntropy: number;
      syntaxUniformityCoefficient: number | null;
    };
    metadata: Record<string, unknown>;
    anomalies: Anomaly[];
    anomalyIndex: number;
    verdict: Verdict;
    linguisticAi: { suspicionPercent: number; reasons: string[] } | null;
    linguisticAiStatus?: { state: 'ok' | 'omitted' | 'error'; reason: string } | null;
  };

  type ImageResult = {
    fileName: string;
    width: number;
    height: number;
    elaScore: number;
    prnuScore: number;
    anomalyIndex: number;
    anomalies: Anomaly[];
    verdict: Verdict;
    visualAi: {
      suspicionPercent: number;
      reasons: string[];
      origin: 'Origen: Dispositivo Digital (Captura)' | 'Origen: Captura Óptica (Cámara)';
    } | null;
    visualAiStatus?: { state: 'ok' | 'omitted' | 'error' | 'blocked'; reason: string } | null;
    visualPrecheck?: {
      allowed: boolean;
      category: 'documento' | 'captura_software' | 'texto_academico' | 'irrelevante';
      reason: string;
    } | null;
  };

  const baseUrl = new URL(env.PUBLIC_SITE_URL || 'http://localhost:5173').toString().replace(/\/$/, '');
  setSeo({
    title: 'Jamalajam | Suite Forense de Integridad Academica',
    description:
      'Auditoria pericial de documentos e imagenes con evidencias tecnicas verificables y politica conservadora de no concluyente.',
    ogTitle: 'Jamalajam - Certificacion Forense Academica',
    ogDescription: 'Suite de auditoria para institutos y universidades.',
    canonical: `${baseUrl}/`,
    ogUrl: `${baseUrl}/`,
    ogImage: `${baseUrl}/og-image.png`,
    twitterCard: 'summary_large_image'
  });

  let mode = $state<'document' | 'image'>('document');
  let busy = $state(false);
  let documentFile = $state<File | null>(null);
  let imageFile = $state<File | null>(null);
  let imagePreview = $state('');
  let documentHash = $state('');
  let imageHash = $state('');
  let documentResult = $state<DocumentResult | null>(null);
  let imageResult = $state<ImageResult | null>(null);
  let error = $state('');
  let generatedAt = $state('');
  let dragActive = $state(false);
  let scanLogs = $state<string[]>([]);
  let scanStep = $state(0);
  let showResult = $state(false);
  let visualScanning = $state(false);
  let scanStartedAt = $state(0);
  const MIN_CINEMATIC_MS = 15_000;
  const MAX_LOG_LINES = 42;

  let documentInputRef: HTMLInputElement | null = $state(null);
  let imageInputRef: HTMLInputElement | null = $state(null);
  let telemetryTimer: ReturnType<typeof setInterval> | null = null;
  let docPreviewKind = $state<'pdf' | 'docx' | null>(null);
  let docPreviewHtml = $state('');
  let docPreviewLoading = $state(false);
  let docPreviewPdfUrl = $state('');
  let pendingDocPreviewFile = $state<File | null>(null);
  let docPreviewError = $state('');
  let footerClock = $state('--:--');
  let footerGeo = $state('Local');
  let footerTimer: ReturnType<typeof setInterval> | null = null;
  let idleTelemetryTimer: ReturnType<typeof setInterval> | null = null;
  let showScienceModal = $state(false);
  let showResultModal = $state(false);
  let cursorX = $state(0);
  let cursorY = $state(0);
  let cursorVisible = $state(false);
  let cursorHover = $state(false);
  let customCursorEnabled = $state(true);
  let glitchSha = $state('');
  let glitchPercent = $state('');
  let glitchActive = $state(false);
  let glitchTimer: ReturnType<typeof setInterval> | null = null;

  const DOC_LOGS = [
    'Inicializando auditoria...',
    'Analizando SHA-256...',
    'Verificando firmas digitales del archivo...',
    'Extrayendo metadatos DOCX/PDF...',
    'Analizando estructura XML del DOCX...',
    'Leyendo propiedades de creacion/modificacion...',
    'Calculando editing time vs word count...',
    'Analizando estructura y huellas de exportacion...',
    'Calculando entropia y uniformidad sintactica...',
    'Correlacionando señales IA + metadatos forenses...',
    'Correlacionando anomalias...',
    'Compilando acta pericial...'
  ];

  const IMG_LOGS = [
    'Inicializando certificacion...',
    'Analizando SHA-256...',
    'Verificando consistencia de captura y compresion...',
    'Decodificando evidencia...',
    'Clasificando tipo de contenido con IA de pre-validacion...',
    'Revisando zonas con posible edicion...',
    'Comprobando si viene de foto real de camara...',
    'Correlacionando PRNU/ELA con veredicto visual IA...',
    'Normalizando metricas...',
    'Correlacionando anomalias...',
    'Compilando acta pericial...'
  ];
  const DOC_KEEPALIVE_LOGS = [
    'Esperando respuesta del motor IA',
    'Correlacionando trazas de metadatos',
    'Validando consistencia pericial'
  ];
  const IMG_KEEPALIVE_LOGS = [
    'Esperando respuesta del detector visual IA',
    'Fusionando señales PRNU/ELA',
    'Ajustando indice de riesgo visual'
  ];

  const IDLE_TELEMETRY_LINES = [
    'Canal de telemetria activo.',
    'Sincronizando reloj forense local...',
    'Esperando evidencia documental...',
    'Buffer de eventos en escucha.',
    'Motor Jamalajam en estado LISTO.'
  ];

  function startIdleTelemetry() {
    if (busy || visualScanning || idleTelemetryTimer) return;
    if (scanLogs.length === 0) {
      scanLogs = [`${IDLE_TELEMETRY_LINES[0]} ${new Date().toLocaleTimeString('es-ES')}`];
    }
    let idx = 1;
    idleTelemetryTimer = setInterval(() => {
      if (busy || visualScanning) return;
      if (idx >= IDLE_TELEMETRY_LINES.length) {
        stopIdleTelemetry();
        return;
      }
      const line = `${IDLE_TELEMETRY_LINES[idx % IDLE_TELEMETRY_LINES.length]} ${new Date().toLocaleTimeString('es-ES')}`;
      scanLogs = [...scanLogs, line].slice(-MAX_LOG_LINES);
      idx += 1;
    }, 2400);
  }

  function stopIdleTelemetry() {
    if (!idleTelemetryTimer) return;
    clearInterval(idleTelemetryTimer);
    idleTelemetryTimer = null;
  }

  function randomHexChar() {
    const chars = '0123456789abcdef';
    return chars[Math.floor(Math.random() * chars.length)];
  }

  function randomDigit() {
    return String(Math.floor(Math.random() * 10));
  }

  function startDataGlitch(finalSha: string, finalPercent: string) {
    if (glitchTimer) {
      clearInterval(glitchTimer);
      glitchTimer = null;
    }
    glitchActive = true;
    const start = Date.now();
    const duration = 520;
    glitchTimer = setInterval(() => {
      const elapsed = Date.now() - start;
      if (elapsed >= duration) {
        if (glitchTimer) clearInterval(glitchTimer);
        glitchTimer = null;
        glitchSha = finalSha;
        glitchPercent = finalPercent;
        glitchActive = false;
        return;
      }
      glitchSha = finalSha
        .split('')
        .map((ch) => (/^[0-9a-f]$/i.test(ch) ? randomHexChar() : ch))
        .join('');
      glitchPercent = finalPercent
        .split('')
        .map((ch) => (/\d/.test(ch) ? randomDigit() : ch))
        .join('');
    }, 55);
  }

  function resetTelemetry() {
    stopIdleTelemetry();
    scanLogs = [];
    scanStep = 0;
    showResult = false;
    showResultModal = false;
    visualScanning = false;
    scanStartedAt = 0;
    if (telemetryTimer) {
      clearInterval(telemetryTimer);
      telemetryTimer = null;
    }
  }

  function startTelemetry(kind: 'document' | 'image') {
    stopIdleTelemetry();
    resetTelemetry();
    visualScanning = true;
    scanStartedAt = Date.now();
    const seq = kind === 'document' ? DOC_LOGS : IMG_LOGS;
    const keepAlive = kind === 'document' ? DOC_KEEPALIVE_LOGS : IMG_KEEPALIVE_LOGS;
    scanLogs = [seq[0]];
    scanStep = 1;
    telemetryTimer = setInterval(() => {
      if (scanStep < seq.length) {
        scanLogs = [...scanLogs, seq[scanStep]].slice(-MAX_LOG_LINES);
        scanStep += 1;
        return;
      }
      const dots = '.'.repeat((scanStep % 3) + 1);
      const msg = `${keepAlive[scanStep % keepAlive.length]}${dots}`;
      scanLogs = [...scanLogs, msg].slice(-MAX_LOG_LINES);
      scanStep += 1;
    }, 780);
  }

  function finishTelemetry() {
    if (telemetryTimer) {
      clearInterval(telemetryTimer);
      telemetryTimer = null;
    }
    const elapsed = scanStartedAt ? Date.now() - scanStartedAt : MIN_CINEMATIC_MS;
    const remaining = Math.max(0, MIN_CINEMATIC_MS - elapsed);
    window.setTimeout(() => {
      showResult = true;
      visualScanning = false;
      if (documentResult || imageResult) {
        showResultModal = true;
        if (mode === 'document' && documentResult) {
          const pct = documentResult.linguisticAi ? `${documentResult.linguisticAi.suspicionPercent.toFixed(0)}%` : 'N/D';
          startDataGlitch(documentHash, pct);
        } else if (mode === 'image' && imageResult) {
          const pct = imageResult.visualAi ? `${imageResult.visualAi.suspicionPercent.toFixed(0)}%` : 'N/D';
          startDataGlitch(imageHash, pct);
        }
        startIdleTelemetry();
      } else {
        startIdleTelemetry();
      }
    }, remaining);
  }

  function reopenResultModal() {
    if (!showResult) return;
    if (mode === 'document' && !documentResult) return;
    if (mode === 'image' && !imageResult) return;
    showResultModal = true;
  }

  function updateFooterClock() {
    const now = new Date();
    footerClock = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Local';
    const city = tz.split('/').pop()?.replace(/_/g, ' ') || 'Local';
    const locale = (navigator.language || 'es-ES').toUpperCase();
    const region = locale.includes('-') ? locale.split('-').pop() : locale;
    footerGeo = `${city} / ${region}`;
  }

  onMount(() => {
    updateFooterClock();
    footerTimer = setInterval(updateFooterClock, 1000);
    customCursorEnabled = !('ontouchstart' in window) && (navigator.maxTouchPoints ?? 0) === 0;
    startIdleTelemetry();
    const isInteractive = (el: EventTarget | null) =>
      el instanceof Element && Boolean(el.closest('button, a, input, [role="button"]'));
    const onMouseMove = (e: MouseEvent) => {
      if (!customCursorEnabled) return;
      cursorX = e.clientX;
      cursorY = e.clientY;
      cursorVisible = true;
      cursorHover = isInteractive(e.target);
    };
    const onMouseLeave = () => {
      cursorVisible = false;
      cursorHover = false;
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseout', onMouseLeave);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseout', onMouseLeave);
    };
  });

  onDestroy(() => {
    if (telemetryTimer) clearInterval(telemetryTimer);
    if (footerTimer) clearInterval(footerTimer);
    if (idleTelemetryTimer) clearInterval(idleTelemetryTimer);
    if (glitchTimer) clearInterval(glitchTimer);
    if (docPreviewPdfUrl) URL.revokeObjectURL(docPreviewPdfUrl);
  });

  function requestDocumentPreview(file: File) {
    const lower = file.name.toLowerCase();
    docPreviewHtml = '';
    docPreviewLoading = false;
    docPreviewError = '';
    if (docPreviewPdfUrl) URL.revokeObjectURL(docPreviewPdfUrl);
    docPreviewPdfUrl = '';
    pendingDocPreviewFile = file;
    if (lower.endsWith('.pdf')) {
      docPreviewKind = 'pdf';
      docPreviewPdfUrl = URL.createObjectURL(file);
      pendingDocPreviewFile = null;
      return;
    }
    if (lower.endsWith('.docx')) {
      docPreviewKind = 'docx';
      docPreviewLoading = true;
      return;
    }
    docPreviewKind = null;
    pendingDocPreviewFile = null;
  }

  $effect(() => {
    const f = pendingDocPreviewFile;
    const kind = docPreviewKind;
    void (async () => {
      if (!f || kind !== 'docx') return;
      try {
        await tick();
        const buf = await f.arrayBuffer();
        const converted = await mammoth.convertToHtml({ arrayBuffer: buf as any });
        const htmlBody = String(converted?.value ?? '').trim();
        const safeBody = htmlBody || '<p>Documento sin contenido extraible en vista previa.</p>';
        docPreviewHtml = `<!doctype html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root { color-scheme: light; }
    html, body {
      margin: 0;
      padding: 0;
      background: #0a1018;
      font-family: Inter, Arial, sans-serif;
    }
    .sheet-wrap {
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: flex-start;
      padding: 20px;
      box-sizing: border-box;
    }
    .sheet {
      width: min(820px, 100%);
      background: #fff;
      color: #111827;
      border-radius: 8px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.28);
      padding: 36px 44px;
      box-sizing: border-box;
      overflow-wrap: anywhere;
      line-height: 1.45;
      font-size: 14px;
    }
    p { margin: 0 0 0.8em; }
  </style>
</head>
<body>
  <div class="sheet-wrap">
    <article class="sheet">${safeBody}</article>
  </div>
</body>
</html>`;
      } catch {
        docPreviewError = 'No se pudo generar la vista previa del documento.';
        docPreviewHtml = '';
      } finally {
        docPreviewLoading = false;
        pendingDocPreviewFile = null;
      }
    })();
  });

  const verdictLabel: Record<Verdict, string> = {
    integro: 'Integro',
    anomalias_detectadas: 'Anomalias detectadas',
    no_concluyente: 'No concluyente'
  };

  function currentVerdict(): Verdict | null {
    if (mode === 'document') return documentResult?.verdict ?? null;
    return imageResult?.verdict ?? null;
  }

  function downloadToneClass() {
    const verdict = currentVerdict();
    if (verdict === 'integro') return 'is-clean';
    if (verdict === 'anomalias_detectadas') return 'is-suspicious';
    if (verdict === 'no_concluyente') return 'is-inconclusive';
    return '';
  }

  function panicCriticalActive() {
    const docCritical = (documentResult?.linguisticAi?.suspicionPercent ?? 0) >= 100;
    const imgCritical = (imageResult?.visualAi?.suspicionPercent ?? 0) >= 100;
    return docCritical || imgCritical;
  }

  async function hashSha256(file: File) {
    const data = await file.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', data);
    const arr = Array.from(new Uint8Array(digest));
    return arr.map((x) => x.toString(16).padStart(2, '0')).join('');
  }

  function onSelectDocument(event: Event) {
    const target = event.currentTarget as HTMLInputElement;
    documentFile = target.files?.[0] ?? null;
    documentResult = null;
    error = '';
    showResult = false;
    if (documentFile) requestDocumentPreview(documentFile);
    startIdleTelemetry();
  }

  function onSelectImage(event: Event) {
    const target = event.currentTarget as HTMLInputElement;
    imageFile = target.files?.[0] ?? null;
    imageResult = null;
    error = '';
    showResult = false;
    if (imagePreview) URL.revokeObjectURL(imagePreview);
    imagePreview = imageFile ? URL.createObjectURL(imageFile) : '';
    startIdleTelemetry();
  }

  function onDragOver(e: DragEvent) {
    e.preventDefault();
    dragActive = true;
  }
  function onDragLeave(e: DragEvent) {
    e.preventDefault();
    dragActive = false;
  }
  function onDrop(e: DragEvent) {
    e.preventDefault();
    dragActive = false;
    const file = e.dataTransfer?.files?.[0] ?? null;
    if (!file) return;
    if (mode === 'document') {
      if (!/\.(docx|pdf)$/i.test(file.name)) {
        error = 'Formato no soportado. Usa .docx o .pdf.';
        return;
      }
      documentFile = file;
      documentResult = null;
      showResult = false;
      error = '';
      requestDocumentPreview(file);
      startIdleTelemetry();
      return;
    }
    if (!file.type.startsWith('image/')) {
      error = 'Formato no soportado. Usa una imagen.';
      return;
    }
    imageFile = file;
    imageResult = null;
    showResult = false;
    error = '';
    if (imagePreview) URL.revokeObjectURL(imagePreview);
    imagePreview = URL.createObjectURL(file);
    startIdleTelemetry();
  }

  async function auditDocument() {
    if (!documentFile) return;
    busy = true;
    error = '';
    startTelemetry('document');
    try {
      scanLogs = [...scanLogs, 'Preparando hash SHA-256...'];
      documentHash = await hashSha256(documentFile);
      scanLogs = [...scanLogs, 'Enviando a extractor forense...'];
      const form = new FormData();
      form.append('file', documentFile);
      const response = await fetch('/api/audit-document', { method: 'POST', body: form });
      if (!response.ok) {
        let serverMsg = '';
        try {
          const body = await response.json();
          serverMsg = String(body?.error || body?.message || '').trim();
          if (body?.details)
            scanLogs = [...scanLogs, `Diagnostico: ${String(body.details).slice(0, 160)}`].slice(-MAX_LOG_LINES);
        } catch {
          serverMsg = (await response.text()).slice(0, 180);
        }
        throw new Error(serverMsg || 'No se pudo auditar el documento.');
      }
      scanLogs = [...scanLogs, 'Verificando consistencia de respuesta...'];
      documentResult = await response.json();
      if (documentResult?.extension === 'pdf') {
        const pages = documentResult.metrics?.pageCount;
        if (typeof pages === 'number' && pages > 0) {
          scanLogs = [...scanLogs, `Paginas detectadas: ${pages}`].slice(-MAX_LOG_LINES);
          scanLogs = [...scanLogs, `Extraccion de texto completada: ${pages}/${pages} paginas.`].slice(
            -MAX_LOG_LINES
          );
        }
      }
      if (documentResult?.linguisticAi) {
        scanLogs = [...scanLogs, 'Veredicto lingüistico (Groq) recibido...'];
        if (documentResult.linguisticAi.suspicionPercent >= 100) {
          scanLogs = [...scanLogs, 'ALERTA CRITICA: sospecha del 100% detectada.'].slice(-MAX_LOG_LINES);
        }
      } else {
        const reason =
          documentResult?.linguisticAiStatus?.reason ?? 'Analisis lingüistico opcional omitido en esta auditoria.';
        scanLogs = [...scanLogs, `Analisis lingüistico omitido: ${reason}`].slice(-MAX_LOG_LINES);
        const lowerReason = reason.toLowerCase();
        if (lowerReason.includes('dibujo') || lowerReason.includes('no textual') || lowerReason.includes('insuficiente')) {
          scanLogs = [...scanLogs, 'ERROR: Contenido no apto para auditoría académica.'].slice(-MAX_LOG_LINES);
        }
      }
      generatedAt = new Date().toISOString();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Error inesperado.';
    } finally {
      busy = false;
      finishTelemetry();
    }
  }

  async function auditImage() {
    if (!imageFile || !imagePreview) return;
    busy = true;
    error = '';
    startTelemetry('image');
    try {
      scanLogs = [...scanLogs, 'Preparando hash SHA-256...'];
      imageHash = await hashSha256(imageFile);
      scanLogs = [...scanLogs, 'Pre-validacion visual IA: tipo de evidencia...'].slice(-MAX_LOG_LINES);

      const form = new FormData();
      form.append('file', imageFile);

      let visualAi: {
        suspicionPercent: number;
        reasons: string[];
        origin: 'Origen: Dispositivo Digital (Captura)' | 'Origen: Captura Óptica (Cámara)';
      } | null = null;
      let visualAiStatus: { state: 'ok' | 'omitted' | 'error' | 'blocked'; reason: string } | null = null;
      let visualPrecheck:
        | { allowed: boolean; category: 'documento' | 'captura_software' | 'texto_academico' | 'irrelevante'; reason: string }
        | null = null;
      try {
        scanLogs = [...scanLogs, 'Enviando imagen al detective visual (Groq)...'].slice(-MAX_LOG_LINES);
        const aiResp = await fetch('/api/audit-image-ai', { method: 'POST', body: form });
        if (aiResp.ok) {
          const aiBody = await aiResp.json();
          visualPrecheck = aiBody?.precheck ?? null;
          visualAi = aiBody?.verdict ?? null;
          visualAiStatus = aiBody?.status ?? null;
        } else {
          visualAiStatus = { state: 'error', reason: 'No se pudo consultar el modulo visual IA.' };
        }
      } catch (e) {
        visualAiStatus = {
          state: 'error',
          reason: `Fallo de red en analisis visual IA: ${e instanceof Error ? e.message : String(e)}`
        };
      }

      if (visualAiStatus?.state === 'blocked') {
        scanLogs = [
          ...scanLogs,
          'ERROR: Contenido no apto para auditoría académica.',
          `Motivo tecnico: ${visualPrecheck?.reason ?? 'Contenido no documental o irrelevante.'}`
        ].slice(-MAX_LOG_LINES);
        error = 'Contenido no apto para auditoría académica. Sube una evidencia documental válida.';
        return;
      }

      scanLogs = [...scanLogs, 'Cargando imagen en visor...'];
      const img = await loadImage(imagePreview);
      scanLogs = [...scanLogs, 'Analizando posibles retoques locales...'];
      const ela = runEla(img, 0.76);
      scanLogs = [...scanLogs, 'Comprobando huella de captura de camara...'];
      const prnu = estimatePrnu(img);
      const anomalies: Anomaly[] = [];

      if (visualAi && visualAi.suspicionPercent >= 85) {
        anomalies.push({
          code: 'VISUAL_AI_VERY_HIGH',
          severity: 'red',
          message: `Sospecha visual IA muy alta (${visualAi.suspicionPercent.toFixed(0)}%).`
        });
      } else if (visualAi && visualAi.suspicionPercent >= 70) {
        anomalies.push({
          code: 'VISUAL_AI_HIGH',
          severity: 'amber',
          message: `Sospecha visual IA elevada (${visualAi.suspicionPercent.toFixed(0)}%).`
        });
      }

      const red = anomalies.filter((a) => a.severity === 'red').length;
      const amber = anomalies.filter((a) => a.severity === 'amber').length;
      let verdict: Verdict = 'no_concluyente';
      if (red > 0 || amber >= 2) verdict = 'anomalias_detectadas';
      else if (amber === 0 && prnu >= 0.15) verdict = 'integro';

      if (visualAi) {
        scanLogs = [
          ...scanLogs,
          `Veredicto visual IA recibido (${visualAi.suspicionPercent.toFixed(0)}%) - ${visualAi.origin}.`
        ].slice(-MAX_LOG_LINES);
        if (visualAi.suspicionPercent >= 100) {
          scanLogs = [...scanLogs, 'ALERTA CRITICA: sospecha del 100% detectada.'].slice(-MAX_LOG_LINES);
        }
      } else if (visualAiStatus?.reason) {
        scanLogs = [...scanLogs, `Analisis visual IA omitido: ${visualAiStatus.reason}`].slice(-MAX_LOG_LINES);
      }

      imageResult = {
        fileName: imageFile.name,
        width: img.width,
        height: img.height,
        elaScore: Number(ela.toFixed(2)),
        prnuScore: Number(prnu.toFixed(4)),
        anomalyIndex: red * 3 + amber,
        anomalies,
        verdict,
        visualAi,
        visualAiStatus,
        visualPrecheck
      };
      generatedAt = new Date().toISOString();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Error analizando imagen.';
    } finally {
      busy = false;
      finishTelemetry();
    }
  }

  async function loadImage(url: string) {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('No se pudo leer la imagen.'));
      img.src = url;
    });
  }

  function runEla(img: HTMLImageElement, quality: number) {
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas no disponible.');
    ctx.drawImage(img, 0, 0);
    const original = ctx.getImageData(0, 0, img.width, img.height);
    const recompressedDataUrl = canvas.toDataURL('image/jpeg', quality);
    const rec = new Image();
    rec.src = recompressedDataUrl;

    const c2 = document.createElement('canvas');
    c2.width = img.width;
    c2.height = img.height;
    const x2 = c2.getContext('2d');
    if (!x2) throw new Error('Canvas no disponible.');
    x2.drawImage(rec, 0, 0);
    const recompressed = x2.getImageData(0, 0, img.width, img.height);

    let sum = 0;
    for (let i = 0; i < original.data.length; i += 4) {
      sum +=
        Math.abs(original.data[i] - recompressed.data[i]) +
        Math.abs(original.data[i + 1] - recompressed.data[i + 1]) +
        Math.abs(original.data[i + 2] - recompressed.data[i + 2]);
    }
    const avg = sum / (img.width * img.height * 3);
    return avg;
  }

  function estimatePrnu(img: HTMLImageElement) {
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas no disponible.');
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, img.width, img.height).data;

    let highFreqEnergy = 0;
    let sampleCount = 0;
    const w = img.width;

    for (let y = 1; y < img.height - 1; y += 2) {
      for (let x = 1; x < img.width - 1; x += 2) {
        const i = (y * w + x) * 4;
        const n = ((y - 1) * w + x) * 4;
        const s = ((y + 1) * w + x) * 4;
        const e = (y * w + x + 1) * 4;
        const west = (y * w + x - 1) * 4;
        const gray = (data[i] + data[i + 1] + data[i + 2]) / 3;
        const laplace =
          4 * gray -
          (data[n] + data[n + 1] + data[n + 2]) / 3 -
          (data[s] + data[s + 1] + data[s + 2]) / 3 -
          (data[e] + data[e + 1] + data[e + 2]) / 3 -
          (data[west] + data[west + 1] + data[west + 2]) / 3;
        highFreqEnergy += Math.abs(laplace);
        sampleCount += 1;
      }
    }

    const normalized = sampleCount ? highFreqEnergy / sampleCount / 255 : 0;
    return Math.max(0, Math.min(1, normalized / 0.9));
  }

  function resetAll() {
    resetTelemetry();
    if (imagePreview) URL.revokeObjectURL(imagePreview);
    if (docPreviewPdfUrl) URL.revokeObjectURL(docPreviewPdfUrl);
    imagePreview = '';
    docPreviewPdfUrl = '';
    documentFile = null;
    imageFile = null;
    documentResult = null;
    imageResult = null;
    documentHash = '';
    imageHash = '';
    error = '';
    generatedAt = '';
    docPreviewKind = null;
    docPreviewHtml = '';
    docPreviewLoading = false;
    docPreviewError = '';
    pendingDocPreviewFile = null;
  }

  function downloadCertificate() {
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    const now = new Date(generatedAt || Date.now()).toLocaleString('es-ES');
    const left = 36;
    const right = 560;
    const bottom = 790;
    const BLACK: [number, number, number] = [20, 20, 20];
    const GRAY: [number, number, number] = [60, 60, 60];
    let y = 46;

    const ensure = (need = 14) => {
      if (y + need <= bottom) return;
      doc.addPage();
      y = 52;
    };

    const line = (text: string, color: [number, number, number] = BLACK, delta = 14, bold = false) => {
      ensure(delta + 2);
      doc.setFont('courier', bold ? 'bold' : 'normal');
      doc.setFontSize(10);
      doc.setTextColor(color[0], color[1], color[2]);
      // Mantiene acentos/ñ; limpia solo controles y algunos símbolos problemáticos para la fuente base.
      const safeText = text
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
        .replace(/[⚠️]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      const wrapped = doc.splitTextToSize(safeText, right - left);
      doc.text(wrapped, left, y);
      y += delta * Math.max(1, wrapped.length);
    };

    const separator = () => {
      line('--------------------------------------------------------------------------', BLACK);
    };

    const bar = (value: number, size = 20) => {
      const clamped = Math.max(0, Math.min(100, value));
      const filled = Math.round((clamped / 100) * size);
      return `[${'#'.repeat(filled)}${'-'.repeat(size - filled)}] ${clamped.toFixed(0)}%`;
    };

    // Cabecera terminal legible
    doc.setFillColor(245, 245, 245);
    doc.rect(28, 28, 540, 64, 'F');
    line('##  _JAMALAJAM_TERMINAL_FORENSE_v1', BLACK, 12, true);
    line('##  INFORME PERICIAL DE INTEGRIDAD ACADEMICA', BLACK, 14, true);
    line('> INFORME PERICIAL / TERMINAL FORENSE', BLACK);
    separator();

    line(`[+] Fecha de emision: ${now}`);
    line('[+] Naturaleza: Informe pericial tecnico');
    if (mode === 'document' && documentResult) {
      line(`[+] Archivo: ${documentResult.fileName}`);
      line(`[+] Veredicto final: ${verdictLabel[documentResult.verdict]}`, BLACK, 14, true);
      line(`[+] SHA-256: ${documentHash}`);
      line(
        `[+] Timeline: Creacion ${documentResult.timeline.created ?? 'N/D'} | Modificacion ${documentResult.timeline.modified ?? 'N/D'}`
      );
    } else if (mode === 'image' && imageResult) {
      line(`[+] Archivo: ${imageResult.fileName}`);
      line(`[+] Veredicto final: ${verdictLabel[imageResult.verdict]}`, BLACK, 14, true);
      line(`[+] SHA-256: ${imageHash}`);
      line(`[+] Resolucion: ${imageResult.width}x${imageResult.height}`);
    }
    separator();

    line('# INDICADORES');
    if (mode === 'document' && documentResult) {
      const anomalyPct = Math.max(0, Math.min(100, (documentResult.anomalyIndex / 10) * 100));
      const ratioRaw = documentResult.metrics.ratioWordsPerMinute ?? 0;
      const ratioPct = Math.max(0, Math.min(100, (ratioRaw / 120) * 100));
      line(`> Indice de Anomalias: ${bar(anomalyPct)}`, BLACK, 14, true);
      line(`> Ratio palabras/min: ${bar(ratioPct)}`, BLACK, 14, true);
      line(`> Ratio bruto: ${ratioRaw ? ratioRaw.toFixed(2) : 'N/D'}`);
      line(`> Entropia textual: ${documentResult.metrics.textEntropy}`);
      line(`> Uniformidad sintactica: ${documentResult.metrics.syntaxUniformityCoefficient ?? 'N/D'}`);
    } else if (mode === 'image' && imageResult) {
      const anomalyPct = Math.max(0, Math.min(100, (imageResult.anomalyIndex / 10) * 100));
      const visualPct = Math.max(0, Math.min(100, imageResult.visualAi?.suspicionPercent ?? 0));
      line(`> Indice de Anomalias: ${bar(anomalyPct)}`, BLACK, 14, true);
      line(`> Sospecha visual IA: ${bar(visualPct)}`, BLACK, 14, true);
      line(`> Huella de camara: ${imageResult.prnuScore}`);
      line(`> Riesgo de retoque local: ${imageResult.elaScore}`);
      line(`> Origen estimado: ${imageResult.visualAi?.origin ?? 'N/D'}`);
    }
    separator();

    line('# HALLAZGOS');
    if (mode === 'document' && documentResult) {
      line(`> Palabras: ${documentResult.metrics.wordCount}`);
      line(`> Tiempo de edicion (min): ${documentResult.metrics.editingMinutes ?? 'N/D'}`);
      line(`> Ratio palabras/min: ${documentResult.metrics.ratioWordsPerMinute?.toFixed(2) ?? 'N/D'}`);
      if (!documentResult.anomalies.length) line('[+] Sin anomalias relevantes');
      for (const a of documentResult.anomalies) {
        const prefix = a.severity === 'red' ? '[ALERTA ROJA] ' : '';
        line(`- ${prefix}[${a.severity}] ${a.message}`, BLACK, 14, a.severity === 'red');
      }
      separator();
      line('# INFORME EXTENDIDO (DETALLE TECNICO)');
      line(`> Total de palabras detectadas: ${documentResult.metrics.wordCount}`);
      line(`> Paginas analizadas: ${documentResult.metrics.pageCount ?? 'N/D'}`);
      line(`> Coeficiente sintactico: ${documentResult.metrics.syntaxUniformityCoefficient ?? 'N/D'}`);
      if (documentResult.linguisticAi) {
        line(`> Sospecha IA linguistica: ${documentResult.linguisticAi.suspicionPercent.toFixed(0)}%`);
        for (const r of documentResult.linguisticAi.reasons) line(`> Motivo tecnico: ${r}`);
      } else {
        line(`> Estado IA linguistica: ${documentResult.linguisticAiStatus?.reason ?? 'No disponible'}`);
      }
    } else if (mode === 'image' && imageResult) {
      line(`> Indice de anomalias: ${imageResult.anomalyIndex}`);
      line(`> Sospecha visual IA: ${imageResult.visualAi ? `${imageResult.visualAi.suspicionPercent.toFixed(0)}%` : 'N/D'}`);
      if (!imageResult.anomalies.length) line('[+] Sin anomalias relevantes');
      for (const a of imageResult.anomalies) {
        const prefix = a.severity === 'red' ? '[ALERTA ROJA] ' : '';
        line(`- ${prefix}[${a.severity}] ${a.message}`, BLACK, 14, a.severity === 'red');
      }
      separator();
      line('# INFORME EXTENDIDO (DETALLE VISUAL)');
      line(`> Resolucion analizada: ${imageResult.width}x${imageResult.height}`);
      line(`> Huella de camara (PRNU): ${imageResult.prnuScore}`);
      line(`> Riesgo de retoque local (ELA): ${imageResult.elaScore}`);
      line(`> Origen estimado: ${imageResult.visualAi?.origin ?? 'N/D'}`);
      if (imageResult.visualAi?.reasons?.length) {
        line('# DETECTIVE VISUAL (GROQ)', BLACK, 14, true);
        for (const r of imageResult.visualAi.reasons) line(`> ${r}`);
      }
    }
    separator();

    line('# GLOSARIO TECNICO');
    line('> SHA-256: huella criptografica unica del archivo.');
    line('> Timeline: marcas temporales de creacion y modificacion.');
    line('> Ratio palabras/min: densidad de escritura frente a tiempo reportado.');
    line('> Indice de anomalias: pondera alertas rojas y ambar.');
    line('> Politica Jamalajam: priorizar No concluyente ante evidencia insuficiente.');

    doc.save(`Jamalajam-Certificado-${Date.now()}.pdf`);
  }
</script>

<svelte:head>
  <title>{$seo.title}</title>
  <meta name="description" content={$seo.description} />
</svelte:head>

<main class="dashboard" class:panic-mode={panicCriticalActive()}>
  <section class="hero glass">
    <div class="hero-left">
      <p class="eyebrow">Academic Integrity Forensics Suite</p>
      <h1>Jamalajam</h1>
      <p class="subtitle">
        Evidencia tecnica, verificable y defendible. Disenado para institutos y universidades que exigen precision pericial.
      </p>
      <div class="hero-badges">
        <span>SHA-256 Chain</span>
        <span>Timeline Intelligence</span>
        <span>Zero Guessing Policy</span>
      </div>
    </div>
    <div class="hero-right">
      <div class="hero-actions">
        <button class="ghost ghost-info" onclick={() => (showScienceModal = true)}>Como funciona</button>
        <button class="ghost" onclick={resetAll}>Limpiar sesion</button>
      </div>
    </div>
  </section>

  <section class="workspace">
    <aside class="mode-rail glass">
      <p class="rail-title">Modulos</p>
      <button class:active={mode === 'document'} onclick={() => (mode = 'document')}>
        <span class="module-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none">
            <path d="M7 3.5h7l4 4V20a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z" />
            <path d="M14 3.5v4h4" />
            <path d="M9 12h6M9 16h6" />
          </svg>
        </span>
        <span>
          <strong>Auditar Documento</strong>
          <small>Word/PDF forensic intake</small>
        </span>
      </button>
      <button class:active={mode === 'image'} onclick={() => (mode = 'image')}>
        <span class="module-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none">
            <rect x="3.5" y="5.5" width="17" height="13" rx="2.5" />
            <path d="M8 15l2.2-2.2a1 1 0 0 1 1.4 0l1.2 1.2 2.4-2.4a1 1 0 0 1 1.4 0L19 14" />
            <circle cx="9" cy="9.5" r="1.4" />
          </svg>
        </span>
        <span>
          <strong>Certificar Captura</strong>
          <small>Foto real vs captura editada</small>
        </span>
      </button>
    </aside>

    <section class="panel glass">
      {#if mode === 'document'}
        <h2>Modulo de Documentos</h2>
        <p class="panel-sub">
          Extraccion profunda de metadatos, tiempo de edicion y patrones de inyeccion textual con criterio conservador.
        </p>
        <section class="scan-grid">
          <div
            class="viewer glass"
            class:active-zone={mode === 'document'}
            class:drag={dragActive}
            ondragover={onDragOver}
            ondragleave={onDragLeave}
            ondrop={onDrop}
            role="button"
            tabindex="0"
            aria-label="Zona de carga de documento"
            onclick={() => documentInputRef?.click()}
            onkeydown={(e) => e.key === 'Enter' && documentInputRef?.click()}
          >
            <div class="viewer-head">
              <div class="viewer-title">
                <span class="dot"></span>
                <span>Visor Forense</span>
              </div>
              <div class="viewer-meta">{documentFile ? documentFile.name : 'Arrastra un .docx o .pdf'}</div>
            </div>

            <input
              bind:this={documentInputRef}
              class="file-input-hidden"
              type="file"
              accept=".docx,.pdf"
              onchange={onSelectDocument}
            />

            <div class="viewer-body">
              <div class="doc-frame">
                {#if documentFile && docPreviewKind === 'pdf'}
                  <div class="pdf-frame">
                    {#if docPreviewPdfUrl}
                      <div class="pdf-viewport">
                        <iframe
                          class="pdf-canvas"
                          src={`${docPreviewPdfUrl}#view=FitH&zoom=page-fit&toolbar=0&navpanes=0&statusbar=0`}
                          title="Vista previa PDF"
                          loading="lazy"
                        ></iframe>
                      </div>
                    {:else}
                      <div class="pdf-fallback">No se pudo cargar la vista previa PDF.</div>
                    {/if}
                    <div class="pdf-neon"></div>
                  </div>
                {:else if documentFile && docPreviewKind === 'docx'}
                  <div class="docx-preview">
                    {#if docPreviewHtml}
                      <iframe class="docx-iframe" srcdoc={docPreviewHtml} title="Vista previa DOCX"></iframe>
                    {:else}
                      <div class="pdf-fallback">{docPreviewLoading ? 'Renderizando vista previa...' : 'No se pudo cargar la vista previa DOCX.'}</div>
                    {/if}
                  </div>
                {:else}
                  <div class="doc-icon">
                    <svg viewBox="0 0 24 24" fill="none">
                      <path d="M7 3.5h7l4 4V20a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z" />
                      <path d="M14 3.5v4h4" />
                      <path d="M9 12h6M9 16h6" />
                    </svg>
                  </div>
                {/if}
                <div class="doc-glow"></div>

                {#if documentFile && (docPreviewLoading || docPreviewError)}
                  <div class="preview-status" aria-live="polite">
                    {#if docPreviewLoading}Renderizando vista previa…{/if}
                    {#if docPreviewError}{docPreviewError}{/if}
                  </div>
                {/if}
              </div>

              {#if busy || visualScanning}
                <div class="scan-overlay" aria-hidden="true">
                  <div class="scan-line"></div>
                  <div class="particles"></div>
                </div>
              {/if}
            </div>
          </div>

          <aside class="telemetry glass" aria-label="Telemetria en vivo">
            <div class="telemetry-head">
              <span class="telemetry-title">Telemetria</span>
              <span class="telemetry-state">{busy || visualScanning ? 'EN PROCESO' : 'LISTO'}</span>
            </div>
            <div class="telemetry-action">
              {#if documentFile}
                <button class="cta cta-side" disabled={busy || visualScanning} onclick={auditDocument}>
                  {busy ? 'Auditando...' : 'Iniciar Auditoria Forense'}
                </button>
              {:else}
                <p class="telemetry-hint">Sube un archivo para iniciar la auditoria.</p>
              {/if}
              {#if documentResult && showResult && !busy && !visualScanning}
                <button class="ghost reopen-result" onclick={reopenResultModal}>Ver resultado</button>
                <button class={`download ${downloadToneClass()}`} onclick={downloadCertificate}>
                  Descargar Informe Completo
                </button>
              {/if}
            </div>
            <div class="telemetry-body">
              {#if scanLogs.length === 0}
                <p class="telemetry-empty">La consola aparecera aqui durante el escaneo.</p>
              {:else}
                {#each scanLogs as line, i (i)}
                  <p class={`telemetry-line ${line.startsWith('ERROR:') ? 'telemetry-line-error' : ''}`} in:fade={{ duration: 160 }}>
                    {line}
                  </p>
                {/each}
              {/if}
            </div>
            {#if error}
              <p class="error">{error}</p>
            {/if}
          </aside>
        </section>
      {:else}
        <h2>Modulo de Imagen</h2>
        <p class="panel-sub">
          Verifica si la evidencia viene de una foto real de camara y detecta posibles retoques o pegados.
        </p>
        <section class="scan-grid">
          <div
            class="viewer glass"
            class:active-zone={mode === 'image'}
            class:drag={dragActive}
            ondragover={onDragOver}
            ondragleave={onDragLeave}
            ondrop={onDrop}
            role="button"
            tabindex="0"
            aria-label="Zona de carga de imagen"
            onclick={() => imageInputRef?.click()}
            onkeydown={(e) => e.key === 'Enter' && imageInputRef?.click()}
          >
            <div class="viewer-head">
              <div class="viewer-title">
                <span class="dot"></span>
                <span>Visor de Evidencia</span>
              </div>
              <div class="viewer-meta">{imageFile ? imageFile.name : 'Arrastra una imagen'}</div>
            </div>

            <input
              bind:this={imageInputRef}
              class="file-input-hidden"
              type="file"
              accept="image/*"
              onchange={onSelectImage}
            />

            <div class="viewer-body">
              {#if imagePreview}
                <div class="img-frame">
                  <img class="img-preview" src={imagePreview} alt="Previsualizacion de evidencia" />
                </div>
              {:else}
                <div class="img-placeholder" aria-hidden="true">
                  <div class="doc-icon">
                    <svg viewBox="0 0 24 24" fill="none">
                      <rect x="3.5" y="5.5" width="17" height="13" rx="2.5" />
                      <path d="M8 15l2.2-2.2a1 1 0 0 1 1.4 0l1.2 1.2 2.4-2.4a1 1 0 0 1 1.4 0L19 14" />
                      <circle cx="9" cy="9.5" r="1.4" />
                    </svg>
                  </div>
                </div>
              {/if}

              {#if busy || visualScanning}
                <div class="scan-overlay" aria-hidden="true">
                  <div class="scan-line"></div>
                  <div class="particles"></div>
                </div>
              {/if}
            </div>
          </div>

          <aside class="telemetry glass" aria-label="Telemetria en vivo">
            <div class="telemetry-head">
              <span class="telemetry-title">Telemetria</span>
              <span class="telemetry-state">{busy || visualScanning ? 'EN PROCESO' : 'LISTO'}</span>
            </div>
            <div class="telemetry-action">
              {#if imageFile}
                <button class="cta cta-side" disabled={busy || visualScanning} onclick={auditImage}>
                  {busy ? 'Certificando...' : 'Iniciar Certificacion de Evidencia'}
                </button>
              {:else}
                <p class="telemetry-hint">Sube una imagen para iniciar la certificacion.</p>
              {/if}
              {#if imageResult && showResult && !busy && !visualScanning}
                <button class="ghost reopen-result" onclick={reopenResultModal}>Ver resultado</button>
                <button class={`download ${downloadToneClass()}`} onclick={downloadCertificate}>
                  Descargar Informe Completo
                </button>
              {/if}
            </div>
            <div class="telemetry-body">
              {#if scanLogs.length === 0}
                <p class="telemetry-empty">La consola aparecera aqui durante el escaneo.</p>
              {:else}
                {#each scanLogs as line, i (i)}
                  <p class={`telemetry-line ${line.startsWith('ERROR:') ? 'telemetry-line-error' : ''}`} in:fade={{ duration: 160 }}>
                    {line}
                  </p>
                {/each}
              {/if}
            </div>
            {#if error}
              <p class="error">{error}</p>
            {/if}
          </aside>
        </section>
      {/if}
    </section>
  </section>

  <footer class="kronos-footer glass" aria-label="Footer Jamalajam">
    <div class="kf-left">
      <a href="https://github.com/moisesvalero" target="_blank" rel="noopener noreferrer" aria-label="GitHub">
        <svg viewBox="0 0 24 24" fill="none">
          <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" />
        </svg>
      </a>
      <a href="https://www.linkedin.com/in/moisesvalero" target="_blank" rel="noopener noreferrer" aria-label="LinkedIn">
        <svg viewBox="0 0 24 24" fill="none">
          <path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-2-2 2 2 0 0 0-2 2v7h-4v-7a6 6 0 0 1 6-6z" />
          <rect x="2" y="9" width="4" height="12" />
          <circle cx="4" cy="4" r="2" />
        </svg>
      </a>
      <a href="https://www.malt.es/profile/moisesvalerosanchez" target="_blank" rel="noopener noreferrer" aria-label="Malt">
        <svg viewBox="0 0 24 24" fill="none">
          <path d="M4 6h16v12H4z" />
          <path d="M8 15V9l4 3 4-3v6" />
        </svg>
      </a>
    </div>
    <div class="kf-center">
      <span class="kf-dot" aria-hidden="true"></span>
      <span class="kf-clock">{footerGeo} — {footerClock}</span>
    </div>
    <div class="kf-right">
      <span class="kf-copy">© 2026 · Desarrollado por</span>
      <a class="kf-author" href="https://moisesvalero.es/" target="_blank" rel="noopener noreferrer">Moisés Valero</a>
    </div>
  </footer>

  {#if showScienceModal}
    <div
      class="science-modal-backdrop"
      role="button"
      tabindex="0"
      aria-label="Cerrar modal de metodologia"
      onclick={() => (showScienceModal = false)}
      onkeydown={(e) => e.key === 'Enter' && (showScienceModal = false)}
    >
      <div
        class="science-modal glass"
        role="dialog"
        aria-modal="true"
        aria-label="Como funciona Jamalajam"
        tabindex="0"
        onclick={(e) => e.stopPropagation()}
        onkeydown={(e) => e.key === 'Escape' && (showScienceModal = false)}
      >
        <div class="science-modal-head">
          <h3>Como funciona Jamalajam</h3>
          <button class="ghost science-close" onclick={() => (showScienceModal = false)}>Cerrar</button>
        </div>
        <div class="science-modal-body">
          <p>
            Jamalajam revisa el archivo en varias capas: metadatos, historial de creacion/modificacion, estructura del
            documento y patrones tecnicos del contenido. Tambien usa IA como apoyo para detectar incoherencias.
          </p>
          <p>
            El objetivo no es adivinar: es mostrar indicios tecnicos claros. Si la evidencia no es suficiente, el sistema
            prioriza <strong>No concluyente</strong> para evitar acusaciones injustas.
          </p>
          <p class="science-disclaimer">
            Jamalajam proporciona evidencias tecnicas. La decision final siempre debe ser humana.
          </p>
        </div>
      </div>
    </div>
  {/if}

  {#if showResultModal && showResult}
    <div
      class="science-modal-backdrop"
      role="button"
      tabindex="0"
      aria-label="Cerrar resultado"
      onclick={() => (showResultModal = false)}
      onkeydown={(e) => e.key === 'Enter' && (showResultModal = false)}
    >
      <div
        class="science-modal glass result-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Resultado pericial"
        tabindex="0"
        onclick={(e) => e.stopPropagation()}
        onkeydown={(e) => e.key === 'Escape' && (showResultModal = false)}
      >
        <div class="science-modal-head">
          <h3>Resultado pericial</h3>
          <button class="ghost science-close" onclick={() => (showResultModal = false)}>Cerrar</button>
        </div>
        <div class="science-modal-body">
          {#if mode === 'document' && documentResult}
            <p><strong>Veredicto:</strong> {verdictLabel[documentResult.verdict]}</p>
            <p><strong>SHA-256:</strong> <span class:glitching={glitchActive}>{glitchSha || documentHash}</span></p>
            <p><strong>Indice de anomalias:</strong> {documentResult.anomalyIndex}</p>
            <p><strong>Palabras / Min:</strong> {documentResult.metrics.ratioWordsPerMinute ? documentResult.metrics.ratioWordsPerMinute.toFixed(2) : 'N/D'}</p>
            <p>
              <strong>Sospecha linguistica IA:</strong>
              <span class:glitching={glitchActive}>{glitchPercent || (documentResult.linguisticAi ? `${documentResult.linguisticAi.suspicionPercent.toFixed(0)}%` : 'N/D')}</span>
            </p>
            <p>
              Resumen rapido: se detectaron {documentResult.anomalies.length} hallazgos tecnicos.
              Para ver detalle pericial completo, usa "Descargar Informe Completo".
            </p>
            <ul class="modal-list">
              {#if !documentResult.anomalies.length}
                <li>Sin anomalias de severidad relevante en el resumen.</li>
              {/if}
              {#each documentResult.anomalies.slice(0, 3) as anomaly}
                <li>[{anomaly.severity}] {anomaly.message}</li>
              {/each}
            </ul>
          {:else if mode === 'image' && imageResult}
            <p><strong>Veredicto:</strong> {verdictLabel[imageResult.verdict]}</p>
            <p><strong>SHA-256:</strong> <span class:glitching={glitchActive}>{glitchSha || imageHash}</span></p>
            <p><strong>Indice de anomalias:</strong> {imageResult.anomalyIndex}</p>
            <p><strong>Origen estimado:</strong> {imageResult.visualAi?.origin ?? 'N/D'}</p>
            <p>
              <strong>Sospecha visual IA:</strong>
              <span class:glitching={glitchActive}>{glitchPercent || (imageResult.visualAi ? `${imageResult.visualAi.suspicionPercent.toFixed(0)}%` : 'N/D')}</span>
            </p>
            <p>
              Resumen rapido: se detectaron {imageResult.anomalies.length} hallazgos tecnicos.
              Para ver el analisis visual completo, descarga el informe extendido.
            </p>
            <ul class="modal-list">
              {#if !imageResult.anomalies.length}
                <li>Sin anomalias de severidad relevante en el resumen.</li>
              {/if}
              {#each imageResult.anomalies.slice(0, 3) as anomaly}
                <li>[{anomaly.severity}] {anomaly.message}</li>
              {/each}
            </ul>
          {/if}
        </div>
        <button class={`download ${downloadToneClass()}`} onclick={downloadCertificate}>
          Descargar Informe Completo
        </button>
      </div>
    </div>
  {/if}
  {#if customCursorEnabled && cursorVisible}
    <div
      class={`custom-cursor ${cursorHover ? 'hover' : ''}`}
      style={`left:${cursorX}px; top:${cursorY}px;`}
      aria-hidden="true"
    ></div>
  {/if}
</main>

<style>
  .dashboard {
    box-sizing: border-box;
    min-height: 100vh;
    height: auto;
    max-height: none;
    max-width: 1420px;
    margin: 0 auto;
    padding: 0.55rem 0.7rem 0.7rem;
    position: relative;
    overflow: auto;
  }
  :global(body) {
    background:
      radial-gradient(900px 420px at 22% -10%, rgba(0, 229, 255, 0.16), rgba(0, 229, 255, 0) 60%),
      radial-gradient(780px 420px at 88% 10%, rgba(88, 115, 255, 0.16), rgba(88, 115, 255, 0) 62%),
      linear-gradient(180deg, #06070b 0%, #071122 38%, #050713 100%);
  }
  .glass {
    border: 1px solid rgba(0, 229, 255, 0.22);
    background:
      linear-gradient(155deg, rgba(19, 26, 42, 0.7), rgba(9, 12, 18, 0.62)),
      rgba(8, 11, 18, 0.44);
    backdrop-filter: blur(18px);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.05),
      0 30px 65px rgba(1, 8, 18, 0.56),
      0 0 0 1px rgba(0, 229, 255, 0.06),
      0 0 34px rgba(0, 229, 255, 0.08);
  }
  .dashboard.panic-mode .glass {
    border-color: rgba(255, 72, 72, 0.58);
    animation: panicPulse 1.8s ease-in-out infinite;
  }
  .dashboard.panic-mode::before {
    background: radial-gradient(circle, rgba(255, 60, 60, 0.4), rgba(255, 60, 60, 0));
  }
  .dashboard.panic-mode::after {
    background: radial-gradient(circle, rgba(255, 90, 90, 0.35), rgba(255, 90, 90, 0));
  }
  @keyframes panicPulse {
    0%,
    100% {
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.04),
        0 24px 52px rgba(22, 4, 8, 0.5),
        0 0 0 1px rgba(255, 92, 92, 0.18),
        0 0 20px rgba(255, 72, 72, 0.2);
    }
    50% {
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.05),
        0 28px 58px rgba(24, 2, 8, 0.56),
        0 0 0 1px rgba(255, 92, 92, 0.3),
        0 0 28px rgba(255, 72, 72, 0.34);
    }
  }
  .dashboard::before,
  .dashboard::after {
    content: '';
    position: fixed;
    pointer-events: none;
    z-index: -1;
    filter: blur(80px);
    opacity: 0.35;
  }
  .dashboard::before {
    top: -100px;
    left: -60px;
    width: 360px;
    height: 360px;
    background: radial-gradient(circle, rgba(0, 229, 255, 0.55), rgba(0, 229, 255, 0));
  }
  .dashboard::after {
    bottom: -120px;
    right: -90px;
    width: 420px;
    height: 420px;
    background: radial-gradient(circle, rgba(88, 115, 255, 0.5), rgba(88, 115, 255, 0));
  }
  .hero {
    display: flex;
    gap: 0.7rem;
    justify-content: space-between;
    align-items: center;
    border-radius: 14px;
    padding: 0.55rem 0.75rem;
    margin-bottom: 0.55rem;
  }
  .hero-left {
    max-width: 1000px;
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .hero-right {
    display: flex;
    align-items: flex-start;
  }
  .hero-actions {
    display: flex;
    align-items: center;
    gap: 0.45rem;
  }
  .ghost-info {
    border-color: rgba(0, 229, 255, 0.42);
    color: rgba(206, 234, 255, 0.96);
  }
  .eyebrow {
    color: var(--muted);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    font-size: 0.64rem;
    font-family: 'JetBrains Mono', monospace;
    margin: 0;
  }
  h1 {
    font-size: clamp(1.15rem, 1.9vw, 1.55rem);
    margin: 0;
    letter-spacing: -0.01em;
    background: linear-gradient(120deg, #f3f8ff 20%, #76dcff 55%, #4f74ff 100%);
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    text-shadow:
      0 0 28px rgba(0, 229, 255, 0.32),
      0 0 64px rgba(88, 115, 255, 0.18);
  }
  .subtitle {
    color: var(--muted);
    margin: 0;
    max-width: 58ch;
    font-size: 0.78rem;
    line-height: 1.2;
  }
  .hero-badges {
    margin-top: 0;
    display: flex;
    gap: 0.38rem;
    flex-wrap: wrap;
  }
  .hero-badges span {
    border-radius: 999px;
    border: 1px solid rgba(130, 152, 199, 0.28);
    background: rgba(20, 28, 40, 0.6);
    padding: 0.2rem 0.45rem;
    font-size: 0.62rem;
    color: #c6d5f3;
    letter-spacing: 0.02em;
  }
  .workspace {
    display: grid;
    grid-template-columns: 220px 1fr;
    gap: 0.95rem;
    height: auto;
    max-height: none;
  }
  .mode-rail {
    border-radius: 18px;
    padding: 0.9rem;
    display: grid;
    align-content: start;
    gap: 0.46rem;
    height: 100%;
  }
  .rail-title {
    color: #8da3cb;
    text-transform: uppercase;
    letter-spacing: 0.11em;
    font-size: 0.7rem;
    margin: 0.15rem 0 0.35rem;
  }
  .mode-rail button {
    position: relative;
    display: grid;
    grid-template-columns: 18px 1fr;
    align-items: start;
    gap: 0.62rem;
    border: 1px solid var(--line);
    background: linear-gradient(165deg, rgba(22, 27, 38, 0.82), rgba(15, 20, 31, 0.72));
    backdrop-filter: blur(12px);
    color: var(--text);
    border-radius: 12px;
    padding: 0.8rem 0.78rem;
    text-align: left;
    cursor: pointer;
    font-weight: 500;
    transition:
      transform 190ms ease,
      border-color 190ms ease,
      box-shadow 190ms ease,
      background 190ms ease;
    overflow: hidden;
  }
  .mode-rail button::after,
  .cta::after,
  .download::after {
    content: '';
    position: absolute;
    inset: 0;
    transform: translateX(-130%);
    background: linear-gradient(112deg, rgba(0, 229, 255, 0) 36%, rgba(0, 229, 255, 0.34) 50%, rgba(0, 229, 255, 0) 64%);
    opacity: 0.95;
    pointer-events: none;
  }
  .mode-rail button strong {
    font-size: 0.9rem;
    line-height: 1.2;
  }
  .mode-rail button small {
    display: block;
    font-size: 0.73rem;
    color: #8ea3cc;
    margin-top: 0.16rem;
    line-height: 1.3;
  }
  .mode-rail button::before {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(110deg, rgba(0, 229, 255, 0.08), rgba(0, 229, 255, 0.32), rgba(88, 115, 255, 0.22));
    opacity: 0.08;
    transition: opacity 190ms ease;
  }
  .mode-rail button.active {
    border-color: rgba(0, 229, 255, 0.9);
    box-shadow:
      inset 0 0 0 1px rgba(41, 211, 255, 0.35),
      0 0 0 1px rgba(41, 211, 255, 0.2),
      0 0 26px rgba(41, 211, 255, 0.18);
    background: linear-gradient(120deg, rgba(0, 229, 255, 0.26), rgba(89, 116, 255, 0.2));
  }
  .mode-rail button.active::before {
    opacity: 0.9;
  }
  .mode-rail button:hover {
    border-color: rgba(0, 229, 255, 0.85);
    transform: translateY(-1px);
    box-shadow:
      0 14px 34px rgba(2, 10, 22, 0.55),
      0 0 28px rgba(0, 229, 255, 0.16);
  }
  .mode-rail button:hover::before {
    opacity: 0.65;
  }
  .mode-rail button:hover::after,
  .cta:hover::after,
  .download:hover::after {
    opacity: 1;
    animation: buttonScan 1.05s linear;
  }
  .module-icon {
    width: 1rem;
    height: 1rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .module-icon svg {
    width: 100%;
    height: 100%;
    stroke: #9fd9ff;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
    filter: drop-shadow(0 0 8px rgba(41, 211, 255, 0.45));
  }
  .panel {
    border-radius: 16px;
    padding: 0.7rem;
    height: 100%;
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
  }
  .scan-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 360px;
    gap: 0.95rem;
    margin: 0.25rem 0 0;
    height: 100%;
    min-height: 0;
    flex: 1;
  }
  .viewer {
    border-radius: 16px;
    padding: 0.9rem;
    position: relative;
    overflow: hidden;
    cursor: pointer;
    transition: transform 180ms ease, box-shadow 180ms ease, border-color 180ms ease;
    min-height: 0;
    height: 100%;
  }
  .viewer.drag {
    border-color: rgba(0, 229, 255, 0.75);
    box-shadow: 0 0 0 1px rgba(0, 229, 255, 0.18), 0 0 38px rgba(0, 229, 255, 0.18);
    transform: translateY(-1px);
  }
  .viewer-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.75rem;
    padding-bottom: 0.65rem;
    border-bottom: 1px solid rgba(130, 152, 199, 0.18);
  }
  .viewer-title {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    font-family: 'JetBrains Mono', monospace;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    font-size: 0.72rem;
    color: rgba(232, 241, 255, 0.82);
  }
  .viewer-meta {
    font-size: 0.82rem;
    color: rgba(220, 235, 255, 0.72);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 58%;
  }
  .dot {
    width: 9px;
    height: 9px;
    border-radius: 999px;
    background: rgba(0, 229, 255, 0.92);
    box-shadow: 0 0 18px rgba(0, 229, 255, 0.55);
  }
  .viewer-body {
    position: relative;
    height: calc(100% - 44px);
    display: grid;
    place-items: start center;
    align-content: start;
    padding-top: 0.12rem;
  }
  .file-input-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    opacity: 0;
    pointer-events: none;
  }
  .doc-frame,
  .img-placeholder {
    width: min(740px, 96%);
    height: min(520px, 50vh);
    border-radius: 18px;
    border: 1px solid rgba(0, 229, 255, 0.42);
    background: linear-gradient(155deg, rgba(6, 10, 18, 0.72), rgba(3, 6, 12, 0.62));
    box-shadow:
      inset 0 0 0 1px rgba(255, 255, 255, 0.06),
      0 0 40px rgba(0, 229, 255, 0.14);
    display: grid;
    place-items: center;
    position: relative;
    overflow: hidden;
  }
  .pdf-frame {
    width: 100%;
    height: 100%;
    position: relative;
    display: grid;
    place-items: center;
    padding: 10px;
  }
  .pdf-viewport {
    width: 100%;
    height: 100%;
    border-radius: 14px;
    overflow: hidden;
    display: grid;
    place-items: center;
    background: rgba(0, 0, 0, 0.28);
  }
  .pdf-canvas {
    width: 100%;
    height: 100%;
    border-radius: 14px;
    border: 0;
    filter: contrast(1.02) saturate(1.05);
    opacity: 0.94;
    background: rgba(0, 0, 0, 0.2);
  }
  .pdf-fallback {
    width: 100%;
    height: 100%;
    border-radius: 14px;
    border: 1px dashed rgba(0, 229, 255, 0.36);
    display: grid;
    place-items: center;
    color: rgba(255, 255, 255, 0.92);
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.82rem;
    background: rgba(2, 6, 12, 0.62);
  }
  .pdf-neon {
    position: absolute;
    inset: 8px;
    border-radius: 14px;
    box-shadow:
      0 0 0 1px rgba(0, 229, 255, 0.22),
      0 0 34px rgba(0, 229, 255, 0.16);
    pointer-events: none;
  }
  .docx-preview {
    width: 100%;
    height: 100%;
    display: block;
    padding: 10px;
  }
  .docx-iframe {
    width: 100%;
    height: 100%;
    border: 0;
    border-radius: 14px;
    background: #0a1018;
  }
  .preview-status {
    position: absolute;
    left: 14px;
    right: 14px;
    bottom: 12px;
    border-radius: 12px;
    border: 1px solid rgba(0, 229, 255, 0.28);
    background: rgba(6, 10, 18, 0.62);
    backdrop-filter: blur(10px);
    padding: 0.55rem 0.7rem;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.78rem;
    color: rgba(255, 255, 255, 0.9);
    text-shadow: 0 0 14px rgba(0, 229, 255, 0.18);
  }
  .doc-icon svg {
    width: 88px;
    height: 88px;
    stroke: rgba(170, 225, 255, 0.96);
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
    filter: drop-shadow(0 0 14px rgba(0, 229, 255, 0.35));
  }
  .doc-glow {
    position: absolute;
    inset: -40%;
    background: radial-gradient(circle at 40% 35%, rgba(0, 229, 255, 0.18), rgba(0, 229, 255, 0));
    filter: blur(18px);
    opacity: 0.9;
  }
  .img-frame {
    width: min(520px, 92%);
    border-radius: 18px;
    border: 1px solid rgba(0, 229, 255, 0.55);
    background: rgba(3, 7, 14, 0.45);
    box-shadow:
      inset 0 0 0 1px rgba(255, 255, 255, 0.06),
      0 0 46px rgba(0, 229, 255, 0.16);
    overflow: hidden;
  }
  .img-preview {
    width: 100%;
    height: 100%;
    display: block;
    max-height: 48vh;
    object-fit: contain;
    background: rgba(0, 0, 0, 0.2);
  }
  .scan-overlay {
    position: absolute;
    inset: 58px 14px 14px;
    border-radius: 16px;
    pointer-events: none;
    overflow: hidden;
  }
  .scan-line {
    position: absolute;
    left: 0;
    right: 0;
    height: 2px;
    top: 0;
    background: linear-gradient(90deg, rgba(0, 229, 255, 0), rgba(0, 229, 255, 1), rgba(88, 115, 255, 0));
    box-shadow: 0 0 18px rgba(0, 229, 255, 0.9);
    animation: scanY 1.35s ease-in-out infinite alternate;
    opacity: 0.95;
  }
  @keyframes scanY {
    0% {
      transform: translateY(4px);
    }
    100% {
      transform: translateY(260px);
    }
  }
  .particles {
    position: absolute;
    inset: 0;
    background:
      radial-gradient(circle at 20% 30%, rgba(0, 229, 255, 0.12), rgba(0, 229, 255, 0) 42%),
      radial-gradient(circle at 70% 60%, rgba(88, 115, 255, 0.1), rgba(88, 115, 255, 0) 48%),
      repeating-linear-gradient(0deg, rgba(0, 229, 255, 0.06) 0 1px, rgba(0, 229, 255, 0) 1px 10px);
    opacity: 0.55;
    mix-blend-mode: screen;
    animation: glitchFloat 1.9s ease-in-out infinite alternate;
    filter: blur(0.2px);
  }
  @keyframes glitchFloat {
    0% {
      transform: translate3d(0, 0, 0);
      opacity: 0.45;
    }
    100% {
      transform: translate3d(0.6px, -0.8px, 0);
      opacity: 0.6;
    }
  }
  .telemetry {
    border-radius: 16px;
    padding: 0.62rem;
    display: flex;
    flex-direction: column;
    min-height: 0;
    height: 100%;
    overflow: hidden;
    gap: 0.4rem;
  }
  .telemetry-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.75rem;
    padding-bottom: 0.65rem;
    border-bottom: 1px solid rgba(130, 152, 199, 0.18);
  }
  .telemetry-title {
    font-family: 'JetBrains Mono', monospace;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    font-size: 0.72rem;
    color: rgba(232, 241, 255, 0.82);
  }
  .telemetry-state {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.72rem;
    color: rgba(0, 229, 255, 0.9);
  }
  .telemetry-body {
    padding-top: 0.45rem;
    flex: 1;
    min-height: 100px;
    overflow: auto;
    scrollbar-width: thin;
  }
  .telemetry-action {
    margin-top: 0.1rem;
    display: grid;
    gap: 0.35rem;
  }
  .telemetry-empty {
    color: rgba(220, 235, 255, 0.66);
    font-size: 0.9rem;
  }
  .telemetry-line {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.82rem;
    color: rgba(255, 255, 255, 0.92);
    line-height: 1.4;
    margin-top: 0.32rem;
  }
  .telemetry-line-error {
    color: #ff6b6b;
    text-shadow: 0 0 10px rgba(255, 0, 0, 0.45);
    animation: telemetryErrorBlink 0.82s step-end infinite;
  }
  @keyframes telemetryErrorBlink {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.2;
    }
  }
  .panel-sub {
    color: var(--muted);
    margin: 0.2rem 0 0.45rem;
    font-size: 0.82rem;
  }
  .cta-side {
    margin-top: 0;
    padding: 0.55rem 0.7rem;
    width: 100%;
  }
  .telemetry-hint {
    margin: 0.1rem 0 0;
    font-size: 0.76rem;
    color: rgba(186, 206, 238, 0.72);
    font-family: 'JetBrains Mono', monospace;
  }
  .reopen-result {
    margin-top: 0.2rem;
    width: 100%;
  }
  .side-result {
    margin-top: 0.45rem;
    overflow: auto;
    max-height: 42%;
  }
  input[type='file'] {
    width: 100%;
    border: 1px dashed var(--line);
    border-radius: 10px;
    padding: 0.75rem;
    background: rgba(9, 12, 18, 0.6);
    color: rgba(255, 255, 255, 0.92);
    margin-bottom: 0.75rem;
  }
  input[type='file']::file-selector-button {
    border: 1px solid rgba(0, 229, 255, 0.45);
    border-radius: 10px;
    padding: 0.55rem 0.75rem;
    margin-right: 0.75rem;
    background: linear-gradient(110deg, rgba(0, 229, 255, 0.22), rgba(88, 115, 255, 0.22));
    color: rgba(255, 255, 255, 0.95);
    cursor: pointer;
    box-shadow: 0 0 20px rgba(0, 229, 255, 0.14);
    transition: transform 170ms ease, box-shadow 170ms ease, border-color 170ms ease;
  }
  input[type='file']::file-selector-button:hover {
    transform: translateY(-1px);
    border-color: rgba(0, 229, 255, 0.7);
    box-shadow: 0 0 28px rgba(0, 229, 255, 0.22);
  }
  .cta,
  .download,
  .ghost {
    position: relative;
    overflow: hidden;
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 0.65rem 0.9rem;
    background: linear-gradient(165deg, rgba(23, 29, 43, 0.9), rgba(14, 19, 30, 0.9));
    color: var(--text);
    cursor: pointer;
    transition:
      transform 170ms ease,
      box-shadow 170ms ease,
      border-color 170ms ease;
  }
  .cta {
    border-color: rgba(0, 229, 255, 0.8);
    background: linear-gradient(110deg, rgba(0, 229, 255, 0.55), rgba(84, 111, 255, 0.55));
    font-weight: 700;
    letter-spacing: 0.02em;
    box-shadow:
      inset 0 0 0 1px rgba(255, 255, 255, 0.08),
      0 0 34px rgba(0, 229, 255, 0.28),
      0 18px 40px rgba(2, 10, 22, 0.55);
  }
  .cta:hover:not(:disabled) {
    transform: translateY(-1px);
    box-shadow:
      inset 0 0 0 1px rgba(255, 255, 255, 0.12),
      0 0 44px rgba(0, 229, 255, 0.38),
      0 24px 54px rgba(2, 10, 22, 0.6);
  }
  .cta:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
  .download {
    margin-top: 0.45rem;
    width: 100%;
    font-weight: 700;
  }
  .download.is-clean {
    border-color: rgba(30, 203, 131, 0.75);
    background: linear-gradient(110deg, rgba(30, 203, 131, 0.38), rgba(10, 132, 99, 0.38));
    box-shadow:
      inset 0 0 0 1px rgba(255, 255, 255, 0.08),
      0 0 24px rgba(30, 203, 131, 0.22);
  }
  .download.is-inconclusive {
    border-color: rgba(255, 170, 68, 0.8);
    background: linear-gradient(110deg, rgba(255, 170, 68, 0.42), rgba(204, 122, 16, 0.42));
    box-shadow:
      inset 0 0 0 1px rgba(255, 255, 255, 0.08),
      0 0 24px rgba(255, 170, 68, 0.24);
  }
  .download.is-suspicious {
    border-color: rgba(255, 78, 94, 0.85);
    background: linear-gradient(110deg, rgba(255, 78, 94, 0.44), rgba(168, 26, 50, 0.44));
    box-shadow:
      inset 0 0 0 1px rgba(255, 255, 255, 0.08),
      0 0 24px rgba(255, 78, 94, 0.28);
  }
  .download:hover {
    transform: translateY(-1px);
    filter: brightness(1.06);
  }
  .ghost {
    color: rgba(232, 241, 255, 0.78);
    border-color: rgba(130, 152, 199, 0.22);
    background: rgba(9, 12, 18, 0.18);
  }
  .ghost:hover {
    border-color: rgba(41, 211, 255, 0.4);
    color: #d4e7ff;
  }
  .result {
    margin-top: 1rem;
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 0.85rem;
    background: linear-gradient(150deg, rgba(10, 14, 22, 0.65), rgba(7, 11, 18, 0.75));
    backdrop-filter: blur(12px);
    box-shadow: inset 0 0 0 1px rgba(131, 151, 188, 0.08);
  }
  .result-reveal {
    animation: resultIn 260ms ease both;
  }
  @keyframes resultIn {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
  .result p,
  .result li {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.86rem;
    margin-top: 0.35rem;
    color: #d9e5ff;
    word-break: break-word;
  }
  .result h3 {
    color: #e9f2ff;
    letter-spacing: 0.02em;
    text-shadow: 0 0 16px rgba(41, 211, 255, 0.16);
  }
  .result ul {
    margin-top: 0.4rem;
    padding-left: 1.1rem;
  }
  .active-zone {
    animation: activeZonePulse 6.2s ease-in-out infinite;
  }
  @keyframes activeZonePulse {
    0%,
    100% {
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.05),
        0 30px 65px rgba(1, 8, 18, 0.56),
        0 0 0 1px rgba(0, 229, 255, 0.08),
        0 0 24px rgba(0, 229, 255, 0.1);
    }
    50% {
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.07),
        0 32px 68px rgba(1, 8, 18, 0.6),
        0 0 0 1px rgba(0, 229, 255, 0.22),
        0 0 34px rgba(0, 229, 255, 0.24);
    }
  }
  .glitching {
    font-family: 'JetBrains Mono', monospace;
    text-shadow: 0 0 10px rgba(0, 229, 255, 0.18);
  }
  @keyframes buttonScan {
    from {
      transform: translateX(-130%);
    }
    to {
      transform: translateX(130%);
    }
  }
  .custom-cursor {
    position: fixed;
    width: 22px;
    height: 22px;
    border: 1px solid rgba(0, 229, 255, 0.9);
    border-radius: 50%;
    pointer-events: none;
    transform: translate(-50%, -50%);
    z-index: 9999;
    box-shadow:
      0 0 0 1px rgba(0, 229, 255, 0.25) inset,
      0 0 18px rgba(0, 229, 255, 0.35);
  }
  .custom-cursor::before,
  .custom-cursor::after {
    content: '';
    position: absolute;
    background: rgba(0, 229, 255, 0.85);
  }
  .custom-cursor::before {
    left: 50%;
    top: 3px;
    width: 1px;
    height: 16px;
    transform: translateX(-50%);
  }
  .custom-cursor::after {
    top: 50%;
    left: 3px;
    width: 16px;
    height: 1px;
    transform: translateY(-50%);
  }
  .custom-cursor.hover {
    width: 26px;
    height: 26px;
    border-color: rgba(115, 244, 255, 1);
    border-radius: 6px;
    transform: translate(-50%, -50%) rotate(45deg);
    box-shadow:
      0 0 0 1px rgba(0, 229, 255, 0.4) inset,
      0 0 24px rgba(0, 229, 255, 0.48);
  }
  .custom-cursor.hover::before,
  .custom-cursor.hover::after {
    opacity: 0.95;
  }
  @media (hover: hover) and (pointer: fine) {
    :global(body) {
      cursor: none !important;
    }
    :global(a),
    :global(button),
    :global(input),
    :global(textarea),
    :global(select),
    :global([role='button']),
    :global([onclick]),
    :global(.viewer),
    :global(.mode-rail button),
    :global(.telemetry),
    :global(.science-modal-backdrop),
    :global(.science-modal) {
      cursor: none !important;
    }
  }
  @media (hover: none), (pointer: coarse) {
    .custom-cursor {
      display: none;
    }
  }
  .ai-box {
    margin-top: 0.85rem;
    border-radius: 12px;
    border: 1px solid rgba(0, 229, 255, 0.38);
    background: linear-gradient(120deg, rgba(0, 229, 255, 0.12), rgba(88, 115, 255, 0.09));
    box-shadow: 0 0 26px rgba(0, 229, 255, 0.14);
    padding: 0.8rem 0.85rem;
  }
  .ai-box h4 {
    margin: 0;
    font-family: 'JetBrains Mono', monospace;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    font-size: 0.72rem;
    color: rgba(232, 241, 255, 0.86);
  }
  .ai-score {
    margin-top: 0.45rem;
    font-family: 'JetBrains Mono', monospace;
    color: rgba(255, 255, 255, 0.92);
  }
  .ai-reasons {
    margin-top: 0.45rem;
    padding-left: 1.25rem;
    color: rgba(225, 238, 255, 0.88);
    font-size: 0.9rem;
  }
  .preview {
    margin-top: 0.8rem;
    max-width: 100%;
    max-height: 360px;
    border-radius: 10px;
    border: 1px solid var(--line);
    box-shadow: 0 16px 30px rgba(2, 8, 20, 0.4);
  }
  .error {
    color: var(--danger);
    margin-top: 0.7rem;
  }
  @media (max-width: 760px) {
    .workspace {
      grid-template-columns: 1fr;
      height: auto;
      max-height: none;
    }
    .hero {
      flex-direction: column;
      align-items: flex-start;
    }
    .hero-right {
      width: 100%;
    }
    .ghost {
      width: 100%;
    }
  }
  @media (max-width: 920px) {
    .scan-grid {
      grid-template-columns: 1fr;
      height: auto;
    }
    .panel {
      overflow: visible;
    }
  }
  @media (min-width: 1024px) {
    :global(html),
    :global(body) {
      height: 100%;
      overflow: hidden;
    }
    .dashboard {
      height: 100dvh;
      min-height: 100dvh;
      max-height: 100dvh;
      overflow: hidden;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr) auto;
      gap: 0.5rem;
    }
    .workspace {
      min-height: 0;
      height: 100%;
      max-height: 100%;
      overflow: hidden;
    }
    .panel {
      min-height: 0;
    }
    .scan-grid {
      min-height: 0;
      height: 100%;
    }
    .viewer,
    .telemetry {
      min-height: 0;
      height: 100%;
    }
    .viewer-body {
      place-items: center;
      align-content: center;
      padding-top: 0;
    }
    .doc-frame,
    .img-placeholder {
      width: min(860px, 98%);
      height: min(680px, 66vh);
    }
    .img-frame {
      width: min(820px, 96%);
      height: min(680px, 66vh);
    }
    .img-preview {
      max-height: none;
      height: 100%;
    }
    .telemetry-body,
    .side-result {
      overflow-y: auto;
      scrollbar-width: thin;
      scrollbar-color: rgba(0, 229, 255, 0.78) rgba(8, 14, 26, 0.55);
    }
    .side-result {
      min-height: 0;
      max-height: 40%;
    }
    .telemetry-body::-webkit-scrollbar,
    .side-result::-webkit-scrollbar {
      width: 7px;
      height: 7px;
    }
    .telemetry-body::-webkit-scrollbar-thumb,
    .side-result::-webkit-scrollbar-thumb {
      background: rgba(0, 229, 255, 0.75);
      border-radius: 999px;
    }
    .telemetry-body::-webkit-scrollbar-track,
    .side-result::-webkit-scrollbar-track {
      background: rgba(10, 16, 28, 0.5);
    }
  }
  @media (min-width: 768px) and (max-width: 1024px) {
    .dashboard {
      overflow: auto;
      height: auto;
      max-height: none;
      padding: 0.65rem 0.7rem 0.9rem;
    }
    .workspace {
      grid-template-columns: 180px minmax(0, 1fr);
      height: auto;
      max-height: none;
    }
    .scan-grid {
      grid-template-columns: 1fr;
      height: auto;
    }
    .telemetry {
      min-height: 260px;
      max-height: none;
    }
    .side-result {
      max-height: 300px;
    }
  }
  @media (max-width: 767px) {
    .dashboard {
      overflow: auto;
      height: auto;
      max-height: none;
      padding: 0.55rem 0.55rem 0.9rem;
    }
    .hero {
      padding: 0.5rem 0.55rem;
      gap: 0.5rem;
    }
    .hero-left {
      width: 100%;
      gap: 0.45rem;
      flex-wrap: wrap;
    }
    .subtitle {
      max-width: 100%;
      font-size: 0.74rem;
    }
    .workspace {
      grid-template-columns: 1fr;
      gap: 0.55rem;
      height: auto;
      max-height: none;
    }
    .mode-rail {
      display: grid;
      grid-template-columns: 1fr 1fr;
      align-items: stretch;
      gap: 0.45rem;
      padding: 0.55rem;
      border-radius: 14px;
    }
    .rail-title {
      grid-column: 1 / -1;
      margin: 0 0 0.1rem;
      font-size: 0.62rem;
    }
    .mode-rail button {
      grid-template-columns: 16px 1fr;
      padding: 0.62rem 0.55rem;
      min-height: 54px;
      border-radius: 10px;
    }
    .mode-rail button strong {
      font-size: 0.8rem;
    }
    .mode-rail button small {
      font-size: 0.67rem;
    }
    .panel {
      padding: 0.55rem;
      height: auto;
      overflow: visible;
    }
    .scan-grid {
      grid-template-columns: 1fr;
      gap: 0.55rem;
      height: auto;
      margin-top: 0.2rem;
    }
    .viewer {
      min-height: 280px;
      height: auto;
      padding: 0.62rem;
    }
    .viewer-body {
      min-height: 210px;
    }
    .doc-frame,
    .img-placeholder {
      width: 100%;
      height: min(52vh, 360px);
    }
    .img-frame {
      width: 100%;
    }
    .img-preview {
      width: 100%;
      height: 100%;
      max-height: min(46vh, 320px);
      object-fit: contain;
    }
    .telemetry {
      padding: 0.55rem;
      min-height: 220px;
      height: auto;
      border-radius: 14px;
    }
    .telemetry-line {
      font-size: 0.78rem;
    }
    .cta,
    .cta-side,
    .download,
    .ghost {
      width: 100%;
      min-height: 46px;
      padding: 0.72rem 0.8rem;
      font-size: 0.92rem;
    }
    .side-result {
      max-height: none;
    }
    .kronos-footer {
      flex-direction: column;
      align-items: stretch;
      gap: 0.45rem;
    }
    .kf-left,
    .kf-center,
    .kf-right {
      justify-content: center;
    }
  }
  .kronos-footer {
    margin-top: 0.5rem;
    border-radius: 12px;
    min-height: 40px;
    padding: 0.42rem 0.62rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }
  .science-modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(3, 8, 18, 0.72);
    backdrop-filter: blur(5px);
    z-index: 60;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
  }
  .science-modal {
    width: min(760px, 100%);
    max-height: min(82vh, 740px);
    border-radius: 14px;
    padding: 0.8rem 0.9rem;
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
  }
  .science-modal-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.6rem;
  }
  .science-modal-head h3 {
    margin: 0;
    font-size: 0.95rem;
    letter-spacing: 0.04em;
    color: rgba(223, 241, 255, 0.93);
  }
  .science-modal-body {
    overflow: auto;
    padding-right: 0.2rem;
  }
  .science-modal-body p {
    margin: 0.35rem 0;
    font-size: 0.82rem;
    line-height: 1.48;
    color: rgba(203, 221, 244, 0.88);
  }
  .science-close {
    min-height: 34px;
    padding: 0.4rem 0.7rem;
    font-size: 0.78rem;
  }
  .result-modal {
    max-width: 680px;
  }
  .modal-list {
    margin: 0.45rem 0 0.2rem;
    padding-left: 1.15rem;
    color: rgba(216, 231, 249, 0.9);
    font-size: 0.84rem;
  }
  .science-disclaimer {
    margin-top: 0.4rem;
    color: rgba(255, 218, 173, 0.92);
    font-weight: 600;
  }
  .kf-left {
    display: flex;
    align-items: center;
    gap: 0.45rem;
  }
  .kf-center {
    display: flex;
    align-items: center;
    gap: 0.42rem;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.62rem;
    color: rgba(221, 236, 255, 0.76);
  }
  .kf-dot {
    width: 6px;
    height: 6px;
    border-radius: 999px;
    background: #34c759;
    box-shadow: 0 0 10px rgba(52, 199, 89, 0.7);
    animation: kfPulse 1.6s ease-in-out infinite;
  }
  .kf-clock {
    color: rgba(208, 230, 255, 0.82);
    letter-spacing: 0.02em;
  }
  @keyframes kfPulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.32;
    }
  }
  .kf-copy {
    color: rgba(176, 198, 232, 0.58);
    font-size: 0.58rem;
    letter-spacing: 0.01em;
    line-height: 1;
  }
  .kf-author {
    color: rgba(228, 245, 255, 0.94);
    text-decoration: none;
    font-weight: 600;
    font-size: 0.62rem;
    line-height: 1;
  }
  .kf-author:hover {
    color: #9be8ff;
  }
  .kf-right {
    display: flex;
    align-items: center;
    gap: 0.28rem;
    white-space: nowrap;
  }
  .kf-left a {
    width: 24px;
    height: 24px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: rgba(203, 226, 255, 0.86);
    border: 1px solid rgba(130, 152, 199, 0.28);
    border-radius: 8px;
    background: rgba(9, 14, 26, 0.36);
  }
  .kf-left a svg {
    width: 13px;
    height: 13px;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .kf-left a:hover {
    border-color: rgba(0, 229, 255, 0.56);
    color: #e9f6ff;
  }
</style>