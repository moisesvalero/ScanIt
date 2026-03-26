<script lang="ts">
  import { onDestroy } from 'svelte';
  import { fade, fly } from 'svelte/transition';
  import * as faceapi from 'face-api.js';
  import exifr from 'exifr';
  import mediaInfoFactory from 'mediainfo.js';
  import mediaInfoWasmUrl from 'mediainfo.js/MediaInfoModule.wasm?url';
  import { jsPDF } from 'jspdf';
  import Radar from '$lib/components/Scanner/Radar.svelte';
  import ReportModal from '$lib/components/ui/ReportModal.svelte';
  import { t } from '$lib/i18n/index.js';
  import { EnsembleManager, formatEnsembleVotes } from '$lib/ensemble/EnsembleManager';
  import { scanMp4Container, analyzeRppgGreenSeries, meanGreenCheekRoi } from '$lib/forensics/AdvancedForensicSuite';
  import { analyzePrnuResidualProxy } from '$lib/forensics/prnuResidualProxy';
  import { analyzeDctDoubleQuantization } from '$lib/forensics/dctDoubleQuantProxy';

  /** Nombre de archivo que el usuario puede usar para marcar contenido dudoso (también dispara ALERTA dura). */
  const NOMINAL_MANIPULATION_FILE_RE =
    /fake|deep\s*fake|deepfake|manipul|editad|montaje|faceswap|face\s*swap|sint[eé]tic|generad[oa]|\bfalso\b/i;

  /**
   * Patrones de export típicos (Kling, Sora, Runway, etc.) sin coincidir “kling” dentro de palabras (p. ej. rankling).
   * Dispara ALERTA en análisis de vídeo/imagen junto a hardAlert.
   */
  const KNOWN_AI_GENERATOR_EXPORT_FILE_RE =
    /^(?:kling|sora)(?=[_\s\-.]|$|\d)|[\\/][\s_-]*(?:kling|sora)(?=[_\s\-.]|$|\d)|[_\s-](?:kling|sora)(?=[_\s\-.]|$|\d)|runway[_\s-]?(?:gen|ml|ai)|\bgen-?3\b|google[_\s.-]*veo|\bveo[_\s]?[23]\b|\bvidu\b|pika[_\s-]?(?:labs|art)?[_\s\d-]|pixverse|minimax[_\s-]?video|dreamina|haiper|luma[_\s-]?dream|framepack|wan[_\s-]?video|klingai|kling[_\s.-]?ai/i;
  import {
    ANALYSIS_DURATION_MS,
    MAX_SCAN_SIZE_BYTES,
    appendLog,
    beginScanKind,
    completeScan,
    resetScanner,
    scannerState,
    setScores,
    setAnalyzing,
    tickScan
  } from '$lib/stores/scanner';

  let isDragActive = $state(false);
  let selectedFile: File | null = $state(null);
  let activeTab = $state<'video' | 'image' | 'audio' | 'text' | 'link'>('video');
  let mediaKind = $state<'video' | 'image' | 'audio' | 'text' | null>(null);
  let videoUrl = $state('');
  let videoRef: HTMLVideoElement | null = $state(null);
  let imageUrl = $state('');
  let imageRef: HTMLImageElement | null = $state(null);
  let audioSummary = $state('');
  /** Último análisis de vídeo serializable (replay / benchmark / captura). */
  let videoExportFeatures = $state<{
    forensic: Record<string, unknown>;
    biometric: Record<string, number | boolean>;
    advanced?: Record<string, unknown>;
  } | null>(null);

  /** PRNU/DCT en imagen (export JSON / Playwright). */
  let imageLowLevelForensic = $state<Record<string, unknown> | null>(null);
  let textInput = $state('');
  let textPreview = $state('');
  let linkInput = $state('');
  let linkNormalized = $derived(normalizeUrl(linkInput));
  let linkKind = $derived(classifyLink(linkNormalized));
  let linkError = $derived(linkInput.trim().length > 0 && !linkNormalized ? $t('scanner.link.invalid') : null);
  let canvasRef: HTMLCanvasElement | null = $state(null);
  let showReport = $state(false);
  let isBusy = $state(false);
  let raf = $state(0);
  let heartbeatId: ReturnType<typeof setInterval> | null = null;
  let auditWorker: Worker | null = $state(null);
  const auditPending = new Map<
    string,
    {
      resolve: (v: { hashHex: string; mi: { thirdParty: boolean; encoderHints: string[] } }) => void;
      reject: (e: unknown) => void;
    }
  >();

  let scan = $derived($scannerState);
  let hasVideo = $derived(Boolean(videoUrl));
  let hasImage = $derived(Boolean(imageUrl));
  let hasPreview = $derived(Boolean(videoUrl || imageUrl));
  let displayMillis = $derived(Math.min(scan.millis, ANALYSIS_DURATION_MS));
  let laserProgress = $derived(Math.min(100, (displayMillis / ANALYSIS_DURATION_MS) * 100));
  let riskScoreTarget = $derived(Number.isFinite(scan.riskScore) ? scan.riskScore : 0);
  let confidenceTarget = $derived(Number.isFinite(scan.confidence) ? scan.confidence : 0);

  // Suavizado de números (para evitar “saltos” visuales)
  let riskScoreSmooth = $state(0);
  let confidenceSmooth = $state(0);
  let scoreTweenRaf = 0;
  let confTweenRaf = 0;
  function tweenTo(target: number, kind: 'score' | 'conf') {
    const startRaf = kind === 'score' ? scoreTweenRaf : confTweenRaf;
    if (startRaf) cancelAnimationFrame(startRaf);

    const step = () => {
      const cur = kind === 'score' ? riskScoreSmooth : confidenceSmooth;
      const next = cur + (target - cur) * 0.18;
      if (kind === 'score') riskScoreSmooth = next;
      else confidenceSmooth = next;

      if (Math.abs(target - next) < 0.08) {
        if (kind === 'score') riskScoreSmooth = target;
        else confidenceSmooth = target;
        if (kind === 'score') scoreTweenRaf = 0;
        else confTweenRaf = 0;
        return;
      }
      const id = requestAnimationFrame(step);
      if (kind === 'score') scoreTweenRaf = id;
      else confTweenRaf = id;
    };

    const id = requestAnimationFrame(step);
    if (kind === 'score') scoreTweenRaf = id;
    else confTweenRaf = id;
  }

  $effect(() => {
    const t = riskScoreTarget;
    if (!t && scan.phase === 'IDLE') {
      riskScoreSmooth = 0;
      return;
    }
    tweenTo(Math.max(0, Math.min(100, t)), 'score');
  });

  $effect(() => {
    const t = confidenceTarget;
    if (!t && scan.phase === 'IDLE') {
      confidenceSmooth = 0;
      return;
    }
    tweenTo(Math.max(0, Math.min(100, t)), 'conf');
  });

  let confidenceBarTone = $derived(riskScoreTarget > 70 ? 'danger' : riskScoreTarget <= 40 ? 'safe' : 'warn');

  const ensemble = new EnsembleManager();

  function buildVideoFeaturesForExport(
    frameResult: {
      roiPerfectPts?: number;
      roiNoiseMismatchPts?: number;
      roiNoiseFace?: number;
      roiNoiseBg?: number;
      roiEdgeFace?: number;
      roiEdgeBg?: number;
      blinkWarning?: boolean;
      suspiciousJitter?: boolean;
      suspiciousLowConfidence?: boolean;
      maskJitterWarning?: boolean;
      reliableFaceFrames?: number;
      minScore?: number;
      maxJitter?: number;
      blinkCount?: number;
      maskJitterMaxScore?: number;
    },
    exportExtras?: {
      rppgPrecomputed?: import('$lib/forensics/rppgSignal').RppgAnalysisResult | null;
      containerPrecomputed?: import('$lib/forensics/mp4BoxForensics').Mp4ForensicResult | null;
      lowLevelForensic?: {
        prnuResidualRisk0to100: number;
        prnuResidualMetrics: unknown;
        prnuResidualNotes: string[];
        dctDoubleQuantRisk0to100: number;
        dctDoubleQuantMetrics: unknown;
        dctDoubleQuantNotes: string[];
      } | null;
    }
  ) {
    const rf = Number(frameResult.reliableFaceFrames ?? 0);
    const bc = Number(frameResult.blinkCount ?? 0);
    const minC = Number(frameResult.minScore ?? 0);
    const maxJ = Number(frameResult.maxJitter ?? 0);
    const rpp = Number(frameResult.roiPerfectPts ?? 0);
    const rnm = Number(frameResult.roiNoiseMismatchPts ?? 0);
    const roiStrong = rpp >= 40 || rnm >= 20;

    const portraitHintStrict =
      rf >= 14 &&
      bc === 0 &&
      !frameResult.blinkWarning &&
      minC >= 0.9 &&
      maxJ <= 0.021 &&
      !frameResult.suspiciousLowConfidence;

    // Kling/Sora con “parpadeos” sintéticos: no cumplen bc===0 pero siguen ROI + tracking demasiado limpios.
    const portraitHintPolishedRoi =
      !portraitHintStrict &&
      rf >= 14 &&
      bc >= 1 &&
      bc <= 10 &&
      !frameResult.blinkWarning &&
      minC >= 0.91 &&
      maxJ <= 0.026 &&
      !frameResult.suspiciousLowConfidence &&
      !frameResult.suspiciousJitter &&
      roiStrong;

    const forensic: Record<string, unknown> = {
      roiPerfectPts: rpp,
      roiNoiseMismatchPts: rnm,
      roiNoiseFace: Number(frameResult.roiNoiseFace ?? 0),
      roiNoiseBg: Number(frameResult.roiNoiseBg ?? 0),
      roiEdgeFace: Number(frameResult.roiEdgeFace ?? 0),
      roiEdgeBg: Number(frameResult.roiEdgeBg ?? 0),
      videoPortraitSyntheticHint: portraitHintStrict,
      videoPolishedRoiSyntheticHint: portraitHintPolishedRoi
    };
    const L = exportExtras?.lowLevelForensic;
    if (L) {
      forensic.prnuResidualRisk0to100 = L.prnuResidualRisk0to100;
      forensic.prnuResidualMetrics = L.prnuResidualMetrics;
      forensic.prnuResidualNotes = L.prnuResidualNotes;
      forensic.dctDoubleQuantRisk0to100 = L.dctDoubleQuantRisk0to100;
      forensic.dctDoubleQuantMetrics = L.dctDoubleQuantMetrics;
      forensic.dctDoubleQuantNotes = L.dctDoubleQuantNotes;
    }
    const base = {
      forensic,
      biometric: {
        blinkWarning: Boolean(frameResult.blinkWarning),
        suspiciousJitter: Boolean(frameResult.suspiciousJitter),
        suspiciousLowConfidence: Boolean(frameResult.suspiciousLowConfidence),
        maskJitterWarning: Boolean(frameResult.maskJitterWarning),
        reliableFaceFrames: rf,
        minFaceConfidence: minC,
        maxLandmarkJitter: maxJ,
        blinkCount: bc,
        maskJitterMaxScore: Number(frameResult.maskJitterMaxScore ?? 0)
      }
    };
    if (!exportExtras) return base;
    const adv: Record<string, unknown> = {};
    if (exportExtras.rppgPrecomputed)
      adv.rppg = { precomputed: exportExtras.rppgPrecomputed };
    if (exportExtras.containerPrecomputed)
      adv.container = { precomputed: exportExtras.containerPrecomputed };
    if (Object.keys(adv).length) return { ...base, advanced: adv };
    return base;
  }

  function toEnsembleVotesExport(votes: unknown) {
    const arr = Array.isArray(votes) ? (votes as any[]) : [];
    return arr.map((v) => {
      const fake = Math.max(0, Math.min(100, Number(v?.fakeScore0to100 ?? v?.fake ?? 0)));
      const real = Math.max(0, Math.min(100, 100 - fake));
      return {
        key: String(v?.key ?? ''),
        label: String(v?.label ?? v?.key ?? 'unknown'),
        fake,
        real,
        weight: Number(v?.weight ?? 0),
        applicable: Boolean(v?.applicable ?? true),
        notes: Array.isArray(v?.notes) ? v.notes.map(String) : []
      };
    });
  }

  function downloadJsonFile(filename: string, payload: unknown) {
    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function exportAnalysisJson() {
    if (!selectedFile) return;
    if (scan.phase !== 'COMPLETED') return;

    const payload = {
      schema: 'kronos.analysis.v1',
      generatedAt: new Date().toISOString(),
      file: {
        name: selectedFile.name,
        sizeBytes: selectedFile.size,
        kind: mediaKind ?? 'unknown',
        mime: selectedFile.type || null
      },
      verdict: scan.verdict,
      confidence: scan.confidence,
      riskScore: scan.riskScore,
      reason: scan.reason,
      warnings: scan.warnings ?? [],
      completedAt: scan.completedAt ?? null,
      ensembleVotes: Array.isArray((scan as any).ensembleVotes) ? (scan as any).ensembleVotes : [],
      features:
        mediaKind === 'image'
          ? {
              forensic: {
                elaMean: Number(imageElaMean ?? 0),
                elaUniformity: Number(imageElaUniformity ?? 0),
                textureRepeatScore: Number(imageTextureRepeatScore ?? 0),
                freqPeakiness: Number(imageFreqPeakiness ?? 0),
                freqRadialVar: Number(imageFreqRadialVar ?? 0),
                edgeSharpnessMean: Number(imageEdgeSharpness ?? 0),
                noiseMean: Number(imageNoiseMean ?? 0),
                noiseUniformity: Number(imageNoiseUniformity ?? 0),
                lightingInconsistencyScore: Number(imageLightingInconsistency ?? 0),
                edgePerfectionScore: Number(imageEdgePerfection ?? 0),
                renderSignatureScore: Number(imageRenderSignature ?? 0),
                roiFaceScore: Number(imageRoiFaceScore ?? 0),
                roiPerfectPts: Number(imageRoiPerfectPts ?? 0),
                roiNoiseMismatchPts: Number(imageRoiNoiseMismatchPts ?? 0),
                localElaCv: Number(imageLocalElaCv ?? 0),
                localElaPeakRatio: Number(imageLocalElaPeakRatio ?? 0),
                localEditLikely: Boolean(imageLocalEditLikely),
                vectorGraphicLike: Boolean(imageVectorGraphicLike),
                elaSynthetic: Boolean(imageElaSynthetic),
                frequencySynthetic: Boolean(imageFrequencySynthetic),
                textureSynthetic: Boolean(imageTextureSynthetic),
                edgesSmoothedSynthetic: Boolean(imageEdgesSmoothedSynthetic),
                ...(imageLowLevelForensic ?? {})
              }
            }
          : mediaKind === 'video' && videoExportFeatures
            ? videoExportFeatures
            : null
    };

    downloadJsonFile(`${selectedFile.name}.kronos.json`, payload);
  }

  function __kronosGetExportPayload() {
    if (!selectedFile) return null;
    if (scan.phase !== 'COMPLETED') return null;
    // Reuse the exact same payload shape as the export button.
    const payload = {
      schema: 'kronos.analysis.v1',
      generatedAt: new Date().toISOString(),
      file: {
        name: selectedFile.name,
        sizeBytes: selectedFile.size,
        kind: mediaKind ?? 'unknown',
        mime: selectedFile.type || null
      },
      verdict: scan.verdict,
      confidence: scan.confidence,
      riskScore: scan.riskScore,
      reason: scan.reason,
      warnings: scan.warnings ?? [],
      completedAt: scan.completedAt ?? null,
      ensembleVotes: Array.isArray((scan as any).ensembleVotes) ? (scan as any).ensembleVotes : [],
      features:
        mediaKind === 'image'
          ? {
              forensic: {
                elaMean: Number(imageElaMean ?? 0),
                elaUniformity: Number(imageElaUniformity ?? 0),
                textureRepeatScore: Number(imageTextureRepeatScore ?? 0),
                freqPeakiness: Number(imageFreqPeakiness ?? 0),
                freqRadialVar: Number(imageFreqRadialVar ?? 0),
                edgeSharpnessMean: Number(imageEdgeSharpness ?? 0),
                noiseMean: Number(imageNoiseMean ?? 0),
                noiseUniformity: Number(imageNoiseUniformity ?? 0),
                lightingInconsistencyScore: Number(imageLightingInconsistency ?? 0),
                edgePerfectionScore: Number(imageEdgePerfection ?? 0),
                renderSignatureScore: Number(imageRenderSignature ?? 0),
                roiFaceScore: Number(imageRoiFaceScore ?? 0),
                roiPerfectPts: Number(imageRoiPerfectPts ?? 0),
                roiNoiseMismatchPts: Number(imageRoiNoiseMismatchPts ?? 0),
                localElaCv: Number(imageLocalElaCv ?? 0),
                localElaPeakRatio: Number(imageLocalElaPeakRatio ?? 0),
                localEditLikely: Boolean(imageLocalEditLikely),
                vectorGraphicLike: Boolean(imageVectorGraphicLike),
                elaSynthetic: Boolean(imageElaSynthetic),
                frequencySynthetic: Boolean(imageFrequencySynthetic),
                textureSynthetic: Boolean(imageTextureSynthetic),
                edgesSmoothedSynthetic: Boolean(imageEdgesSmoothedSynthetic),
                ...(imageLowLevelForensic ?? {})
              }
            }
          : mediaKind === 'video' && videoExportFeatures
            ? videoExportFeatures
            : null
    };
    return payload;
  }

  $effect(() => {
    if (typeof window === 'undefined') return;
    (window as any).__kronosGetExportPayload = __kronosGetExportPayload;
  });

  function isAutomationRun() {
    return typeof window !== 'undefined' && Boolean((window as any).__kronosAutomation);
  }

  let animatedLogIndex = $derived(
    scan.phase === 'ANALYZING'
      ? Math.min(
          scan.logs.length,
          Math.floor((displayMillis / ANALYSIS_DURATION_MS) * scan.logs.length) + 1
        )
      : scan.phase === 'COMPLETED'
        ? scan.logs.length
        : Math.max(2, Math.min(3, scan.logs.length))
  );

  let telemetry = $derived(scan.logs.slice(0, Math.max(2, animatedLogIndex)));
  let verdictClass = $derived(
    scan.verdict === 'VERIFICADO' ? 'safe' : scan.verdict === 'SOSPECHOSO' ? 'warn' : scan.verdict === 'ALERTA ROJA' ? 'danger' : 'safe'
  );
  let badgeLabel = $derived(scan.verdict ?? scan.phase);

  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

  const MODEL_BASE_URL = '/models';
  let modelsReady = $state(false);
  let modelLoading = $state(false);
  let modelProgress = $state(0);
  let modelStatusText = $state('Cargando Redes Neuronales...');
  let lastLandmarks = $state<{ x: number; y: number }[] | null>(null);
  let jitterSeries = $state<number[]>([]);
  let scoreSeries = $state<number[]>([]);
  let lastFrameScore = $state<number>(0);
  let lastFrameJitter = $state<number>(0);

  // Métricas UI (estilo Linear): simples, legibles, no “demasiado técnicas”
  let isAudioModeUi = $derived(mediaKind === 'audio');
  let isVideoModeUi = $derived(mediaKind === 'video');

  // Indicadores (siempre en inglés, look de “system report”)
  let metric1Label = $derived(isAudioModeUi ? 'Continuity' : 'Liveness Pattern');
  let metric2Label = $derived(isAudioModeUi ? 'Naturalness' : 'Neural Mesh');
  let metric3Label = $derived('Hash Integrity');

  let metric1Ok = $derived(isAudioModeUi ? !scan.warnings?.includes('Posible edición por cortes (Audio Continuidad)') : !scan.warnings?.includes('Patrón de Parpadeo Sintético'));
  let metric2Ok = $derived(isAudioModeUi ? !scan.warnings?.includes('Naturalidad acústica atípica (posible TTS)') : true);

  let metric1ScoreUi = $derived(metric1Ok ? 0.9 : 0.35);
  let metric2ScoreUi = $derived(
    isAudioModeUi ? (metric2Ok ? 0.88 : 0.42) : clamp01((isVideoModeUi ? lastFrameScore : 0.85) - (isVideoModeUi ? lastFrameJitter * 2.2 : 0.05))
  );

  let dataScoreUi = $derived(
    clamp01(
      0.92 -
        (scan.warnings?.includes('Origen Digital No Verificado') ? 0.28 : 0) -
        (scan.warnings?.includes('Origen: Software de Terceros detectado. Integridad de Cámara: Comprometida') ? 0.24 : 0) -
        (scan.warnings?.includes('Auditoría en segundo plano no disponible (hash)') ? 0.18 : 0)
    )
  );

  // Cache para el overlay de bordes (solo se actualiza durante el escaneo)
  let edgeOverlayCanvas: HTMLCanvasElement | null = null;
  let neckEdgeCanvas: HTMLCanvasElement | null = null;
  let roiTmpCanvas: HTMLCanvasElement | null = null;
  let edgeOverlayRect: { x: number; y: number; w: number; h: number } | null = null;
  let lastMaskJitterScore = 0;

  // Overlay ELA para imagen (solo durante escaneo)
  let elaOverlayCanvas: HTMLCanvasElement | null = null;

  // Métricas para PDF (imagen)
  let imageElaMean = $state(0);
  let imageElaUniformity = $state(0);
  let imageTextureRepeatScore = $state(0);
  let imageFreqPeakiness = $state(0);
  let imageFreqRadialVar = $state(0);
  let imageEdgeSharpness = $state(0);
  let imageNoiseMean = $state(0);
  let imageNoiseUniformity = $state(0);
  let imageLightingInconsistency = $state(0);
  let imageEdgePerfection = $state(0);
  let imageRenderSignature = $state(0);
  let imageRoiFaceScore = $state(0);
  let imageRoiPerfectPts = $state(0);
  let imageRoiNoiseMismatchPts = $state(0);
  let imageLocalElaCv = $state(0);
  let imageLocalElaPeakRatio = $state(0);
  let imageLocalEditLikely = $state(false);
  let imageVectorGraphicLike = $state(false);
  let imageElaSynthetic = $state(false);
  let imageFrequencySynthetic = $state(false);
  let imageTextureSynthetic = $state(false);
  let imageEdgesSmoothedSynthetic = $state(false);

  // Métricas para PDF (texto)
  let textConnectorScore = $state(0);
  let textTopConnectors = $state<string[]>([]);

  // Métricas para PDF (audio)
  let audioDurationSec = $state(0);
  let audioSampleRate = $state(0);
  let audioChannels = $state(0);
  let audioClipRatio = $state(0);
  let audioBandlimitScore = $state(0);
  let audioEditCuts = $state(0);

  let mediaInfoReady = $state(false);
  let mediaInfoLoading = $state(false);
  let mediaInfoInstance: { analyzeData: Function; close: Function } | null = null;

  function normalizeUrl(raw: string) {
    const s = (raw ?? '').trim();
    if (!s) return '';
    try {
      // Permitimos que peguen sin protocolo (ej: youtube.com/...)
      const hasProto = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s);
      const u = new URL(hasProto ? s : `https://${s}`);
      if (!/^https?:$/.test(u.protocol)) return '';
      return u.toString();
    } catch {
      return '';
    }
  }

  function classifyLink(url: string) {
    if (!url) return { type: 'EMPTY' as const, label: '-', host: '' };
    let host = '';
    let path = '';
    try {
      const u = new URL(url);
      host = (u.hostname ?? '').toLowerCase();
      path = (u.pathname ?? '').toLowerCase();
    } catch {
      return { type: 'INVALID' as const, label: $t('scanner.link.invalidShort'), host: '' };
    }

    const isYouTube = /(^|\.)youtube\.com$/.test(host) || host === 'youtu.be';
    const isTikTok = /(^|\.)tiktok\.com$/.test(host) || host === 'vm.tiktok.com';
    const isVimeo = /(^|\.)vimeo\.com$/.test(host) || /(^|\.)player\.vimeo\.com$/.test(host);
    const isDirectMedia = /\.(mp4|webm|mov|mkv|avi|m4v|3gp|mp3|wav|m4a|jpg|jpeg|png|webp|gif|bmp|tif|tiff)(\?|#|$)/i.test(
      path
    );

    if (isYouTube) return { type: 'PLATFORM' as const, label: 'YouTube', host };
    if (isTikTok) return { type: 'PLATFORM' as const, label: 'TikTok', host };
    if (isVimeo) return { type: 'PLATFORM' as const, label: 'Vimeo', host };
    if (isDirectMedia) return { type: 'DIRECT' as const, label: $t('scanner.link.directFile'), host };
    return { type: 'GENERIC' as const, label: host || 'Enlace', host };
  }

  function pushSeries(series: number[], next: number, max = 64) {
    const arr = [...series, next];
    if (arr.length > max) arr.splice(0, arr.length - max);
    return arr;
  }

  async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    let t: ReturnType<typeof setTimeout> | null = null;
    try {
      const timeout = new Promise<never>((_, reject) => {
        t = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
      });
      return await Promise.race([p, timeout]);
    } finally {
      if (t) clearTimeout(t);
    }
  }

  async function smoothProgressUntil(done: Promise<unknown>, minMs: number, fromProgress = 22, toProgress = 86) {
    const startedAt = performance.now();
    let last = 0;
    while (true) {
      const elapsed = performance.now() - startedAt;
      const clamped = Math.min(minMs, elapsed);
      if (clamped - last >= 70) {
        last = clamped;
        const t = minMs > 0 ? clamped / minMs : 1;
        const p = Math.min(98, fromProgress + t * (toProgress - fromProgress));
        tickScan(Math.floor(clamped), p);
      }
      if (elapsed >= minMs) break;
      // Yield corto para que se vea "trabajando"
      await new Promise((r) => setTimeout(r, 60));
    }
    await done;
  }

  async function ensureMinimumPremiumTime(startedAt: number, minMs: number, fromProgress = 24, toProgress = 92) {
    const elapsed = performance.now() - startedAt;
    const remaining = Math.max(0, Math.floor(minMs - elapsed));
    if (remaining <= 0) return;
    await smoothProgressUntil(Promise.resolve(), remaining, fromProgress, toProgress);
  }

  function startTelemetryHeartbeat() {
    stopTelemetryHeartbeat();
    const startedAt = performance.now();
    heartbeatId = setInterval(() => {
      const elapsed = performance.now() - startedAt;
      // Solo necesitamos "movimiento" en UI mientras se resuelven tareas largas previas
      const cappedMillis = Math.min(ANALYSIS_DURATION_MS, elapsed);
      const cappedProgress = Math.min(98, 15 + (cappedMillis / ANALYSIS_DURATION_MS) * 83);
      tickScan(Math.floor(cappedMillis), cappedProgress);
    }, 220);
  }

  function stopTelemetryHeartbeat() {
    if (heartbeatId) {
      clearInterval(heartbeatId);
      heartbeatId = null;
    }
  }

  function ensureAuditWorker() {
    if (auditWorker) return auditWorker;
    auditWorker = new Worker(new URL('$lib/workers/kronosAudit.worker.ts', import.meta.url), { type: 'module' });
    auditWorker.onmessage = (ev: MessageEvent<any>) => {
      const msg = ev.data;
      if (!msg?.id) return;

      if (msg.type === 'progress') {
        if (msg.stage === 'HASHING') appendLog('HASHING_EVIDENCE_SHA256...');
        if (msg.stage === 'MEDIAINFO') appendLog('AUDITING_MEDIAINFO_WASM...');
        if (msg.stage === 'DONE') appendLog('AUDIT_CHAIN_READY');
        return;
      }

      const pending = auditPending.get(msg.id);
      if (!pending) return;

      if (msg.type === 'result') {
        auditPending.delete(msg.id);
        pending.resolve({ hashHex: msg.hashHex ?? '', mi: msg.mi ?? { thirdParty: false, encoderHints: [] } });
      } else if (msg.type === 'error') {
        auditPending.delete(msg.id);
        pending.reject(new Error(msg.message ?? 'Worker audit error'));
      }
    };
    auditWorker.onerror = (e) => {
      for (const [, p] of auditPending) p.reject(e);
      auditPending.clear();
    };
    return auditWorker;
  }

  async function runWorkerAudit(file: File, doMediaInfo: boolean) {
    const w = ensureAuditWorker();
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const p = new Promise<{ hashHex: string; mi: { thirdParty: boolean; encoderHints: string[] } }>((resolve, reject) => {
      auditPending.set(id, { resolve, reject });
    });
    w.postMessage({ type: 'audit', id, file, doMediaInfo });
    return await p;
  }

  function sparklinePoints(values: number[], w: number, h: number, clampMax: number) {
    if (!values.length) return '';
    const min = 0;
    const max = clampMax || Math.max(1e-6, ...values);
    const usable = values.slice(-64);
    const step = usable.length > 1 ? w / (usable.length - 1) : w;
    return usable
      .map((v, i) => {
        const vv = Number.isFinite(v) ? v : 0;
        const t = Math.max(0, Math.min(1, (vv - min) / (max - min)));
        const x = i * step;
        const y = h - t * h;
        return `${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(' ');
  }

  async function ensureModelsLoaded() {
    if (modelsReady || modelLoading) return;
    modelLoading = true;
    modelProgress = 0;
    try {
      modelStatusText = 'Cargando Redes Neuronales...';
      // Empuja progreso/millis para que la Telemetría no se quede "congelada"
      // mientras se cargan modelos (client-side).
      tickScan(0, 15);
      await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_BASE_URL);
      modelProgress = 55;
      tickScan(Math.floor((modelProgress / 100) * 9000), 15 + Math.floor(modelProgress * 0.24));
      await faceapi.nets.faceLandmark68TinyNet.loadFromUri(MODEL_BASE_URL);
      modelProgress = 100;
      modelsReady = true;
      tickScan(9000, 45);
    } finally {
      modelLoading = false;
    }
  }

  let fileHashHex = $state<string>('');

  const yieldToUI = () =>
    new Promise<void>((resolve) => {
      // Permite al navegador repintar (evita sensación de "colgado")
      requestAnimationFrame(() => resolve());
    });

  async function sha256Hex(file: File) {
    // En archivos grandes, `arrayBuffer()` + digest puede bloquear el repintado.
    // Forzamos yields para mantener telemetría/animaciones fluidas.
    await yieldToUI();
    const buffer = await file.arrayBuffer();
    await yieldToUI();
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    await yieldToUI();
    const bytes = new Uint8Array(digest);
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  function verdictLabel(v: typeof scan.verdict) {
    if (v === 'ALERTA ROJA') return 'MANIPULADO';
    if (v === 'SOSPECHOSO') return 'SOSPECHOSO';
    if (v === 'VERIFICADO') return 'AUTÉNTICO';
    return 'PENDIENTE';
  }

  function verdictLabelUi(v: typeof scan.verdict) {
    if (v === 'ALERTA ROJA') return 'ALERTA DE DEEPFAKE';
    if (v === 'SOSPECHOSO') return 'SOSPECHOSO';
    if (v === 'VERIFICADO') return 'VERIFICADO';
    return '-';
  }

  function verdictFromScore(score0to100: number): 'VERIFICADO' | 'SOSPECHOSO' | 'ALERTA ROJA' {
    const s = Math.max(0, Math.min(100, score0to100));
    if (s > 70) return 'ALERTA ROJA';
    if (s >= 40) return 'SOSPECHOSO';
    return 'VERIFICADO';
  }

  function confidenceFromScore(score0to100: number) {
    // “Nivel de confianza” como confianza del veredicto (no “probabilidad IA”).
    // Alto cuando el score está lejos del umbral, más moderado cerca.
    const s = Math.max(0, Math.min(100, score0to100));
    if (s > 70) return Math.max(72, Math.min(99, 70 + (s - 70) * 0.95));
    if (s >= 40) return Math.max(60, Math.min(90, 58 + (s - 40) * 0.75));
    return Math.max(86, Math.min(99.5, 98 - s * 0.22));
  }

  async function decodeAudioBufferFromFile(file: File) {
    // decodeAudioData soporta muchos formatos típicos según navegador (mp3/wav/aac/m4a/ogg).
    const arrayBuffer = await file.arrayBuffer();
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    try {
      const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
      return audioBuffer;
    } finally {
      try {
        await ctx.close();
      } catch {
        // ignore
      }
    }
  }

  function analyzeAudioQuick(audioBuffer: AudioBuffer) {
    const sr = audioBuffer.sampleRate;
    const ch = audioBuffer.numberOfChannels;
    const len = audioBuffer.length;
    const dur = audioBuffer.duration || (len ? len / sr : 0);

    // Mezcla mono (promedio) para análisis rápido
    const data0 = audioBuffer.getChannelData(0);
    const data1 = ch > 1 ? audioBuffer.getChannelData(1) : null;
    const mono = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      const v = data1 ? (data0[i] + data1[i]) * 0.5 : data0[i];
      mono[i] = v;
    }

    // Clipping ratio
    let clip = 0;
    for (let i = 0; i < len; i++) if (Math.abs(mono[i]) > 0.985) clip++;
    const clipRatio = len ? clip / len : 0;

    // Energía RMS por ventanas y proxy de “banda alta” por diferencia
    const win = 2048;
    const hop = 1024;
    const rms: number[] = [];
    const hf: number[] = [];
    const zcr: number[] = [];
    for (let o = 0; o + win < len; o += hop) {
      let s2 = 0;
      let d2 = 0;
      let z = 0;
      let prev = mono[o];
      for (let i = 0; i < win; i++) {
        const x = mono[o + i];
        s2 += x * x;
        const dx = x - prev;
        d2 += dx * dx;
        if ((x >= 0 && prev < 0) || (x < 0 && prev >= 0)) z++;
        prev = x;
      }
      const r = Math.sqrt(s2 / win);
      rms.push(r);
      hf.push(Math.sqrt(d2 / win));
      zcr.push(z / win);
    }

    const median = (arr: number[]) => {
      if (!arr.length) return 0;
      const s = [...arr].sort((a, b) => a - b);
      return s[Math.floor(s.length / 2)];
    };

    const rmsMed = median(rms);
    const hfMed = median(hf);

    // “Bandlimit/codec agresivo” proxy: muy poca alta frecuencia relativo a energía
    const bandlimitScore = rmsMed > 0 ? Math.max(0, Math.min(1, 1 - hfMed / (rmsMed + 1e-6))) : 0;

    // Discontinuidades (cortes/edición): saltos abruptos de RMS + proxy HF
    let cuts = 0;
    const cutTimes: number[] = [];
    for (let i = 1; i < rms.length; i++) {
      const dr = Math.abs(rms[i] - rms[i - 1]);
      const dh = Math.abs(hf[i] - hf[i - 1]);
      const threshR = Math.max(0.02, rmsMed * 0.85);
      const threshH = Math.max(0.008, hfMed * 0.85);
      if (dr > threshR && dh > threshH) {
        cuts++;
        const t = (i * hop) / sr;
        if (cutTimes.length < 6) cutTimes.push(t);
      }
    }

    // “Naturalidad” proxy (muy aproximado): ZCR extremadamente estable + bandlimit muy alto
    const zMed = median(zcr);
    let zVar = 0;
    if (zcr.length) {
      let m = 0;
      for (const v of zcr) m += v;
      m /= zcr.length;
      for (const v of zcr) zVar += (v - m) * (v - m);
      zVar /= zcr.length;
    }
    const ttsLike = bandlimitScore > 0.72 && zVar < 0.000015 && rmsMed > 0.01;

    // “Silencio digital absoluto” entre palabras (proxy):
    // buscamos gaps largos con amplitud casi cero entre segmentos con energía.
    const absEps = 1e-4;
    const minGapSamples = Math.floor(sr * 0.08); // 80ms
    const minVoiceSamples = Math.floor(sr * 0.06);
    const voiceThresh = Math.max(0.008, rmsMed * 0.6);
    let gapCount = 0;
    let i = 0;
    const maxGaps = 6;
    while (i < len) {
      // localizar voz (energía sostenida)
      let voiceRun = 0;
      while (i < len) {
        const v = Math.abs(mono[i]);
        if (v > voiceThresh) voiceRun++;
        else voiceRun = 0;
        i++;
        if (voiceRun >= minVoiceSamples) break;
      }
      if (i >= len) break;

      // tras voz, medir gap casi cero
      let gapRun = 0;
      while (i < len) {
        const v = Math.abs(mono[i]);
        if (v < absEps) gapRun++;
        else break;
        i++;
        if (gapRun >= minGapSamples) break;
      }
      if (gapRun >= minGapSamples) {
        gapCount++;
        if (gapCount >= maxGaps) break;
      }
      // avanzar un poco para evitar loops
      i += 64;
    }

    return {
      durationSec: dur,
      sampleRate: sr,
      channels: ch,
      clipRatio,
      bandlimitScore,
      editCuts: cuts,
      cutTimes,
      ttsLike,
      digitalSilenceGaps: gapCount
    };
  }

  function auditStatus(label: string, status: 'OK' | 'ALERTA' | 'NA', detail: string) {
    return { label, status, detail };
  }

  function buildAuditTable(warnings: string[]) {
    const w = warnings ?? [];
    const isImageMode = mediaKind === 'image';
    const isAudioMode = mediaKind === 'audio';
    const isTextMode = mediaKind === 'text';

    const biometriaOk =
      !w.includes('Patrón de Parpadeo Sintético') &&
      !w.includes('Inconsistencia de Bordes (Mask Jitter)') &&
      !w.some((x) => x.toLowerCase().includes('confianza de deteccion facial'));

    const bordesOk = !w.includes('Inconsistencia de Bordes (Mask Jitter)');

    const hasSyntheticGeneration = w.includes('Generada sintéticamente');
    const hasEdgeSoftening = w.includes('Bordes Suavizados Artificialmente (Edge Softening)');
    const hasLlmTextPattern = w.includes('Patrón de Conectores Lógicos Repetitivos (LLM)');

    // Política anti-falsos-positivos:
    // - En vídeo/imagen/audio es normal que falten EXIF o que plataformas recorten metadatos.
    // - Solo marcamos "ALERTA" en metadatos cuando hay huella fuerte de software de edición/transcodificación,
    //   o cuando el pipeline offthread falló.
    const metadatosOk = isTextMode
      ? !hasLlmTextPattern
      : !w.includes('Origen: Software de Terceros detected. Integridad de Cámara: Comprometida') &&
          !w.some((x) => x.startsWith('Auditoría en segundo plano no disponible'));

    // Coherencia lumínica:
    // - Video: reutiliza el proxy de bordes (Mask Jitter).
    // - Imagen: ELA/frecuencia y softening de bordes indican inestabilidad.
    // - Texto: repetición de conectores lógicos indica estilo LLM estereotipado.
    const luminicaOk = isImageMode
      ? !hasSyntheticGeneration && !hasEdgeSoftening
      : isTextMode
        ? !hasLlmTextPattern
        : !w.includes('Inconsistencia de Bordes (Mask Jitter)');

    const biometriaStatus = isImageMode || isTextMode || isAudioMode ? 'NA' : biometriaOk ? 'OK' : 'ALERTA';
    const bordesStatus = isImageMode || isTextMode || isAudioMode ? 'NA' : bordesOk ? 'OK' : 'ALERTA';
    const luminicaStatus = luminicaOk ? 'OK' : 'ALERTA';

    return [
      auditStatus(
        'Biometría',
        biometriaStatus,
        isImageMode
          ? 'No evaluado en modo imagen (EAR/landmarks no aplica)'
          : isAudioMode
            ? 'No evaluado en modo audio (biometría facial no aplica)'
            : isTextMode
              ? 'No evaluado en modo texto'
              : biometriaOk
                ? 'Landmarks/EAR estables'
                : 'Señales biométricas anómalas'
      ),
      auditStatus(
        'Integridad de Bordes',
        bordesStatus,
        isImageMode
          ? 'No evaluado en modo imagen (ELA/ruido)'
          : isAudioMode
            ? 'No evaluado en modo audio (bordes no aplica)'
          : isTextMode
            ? 'No evaluado en modo texto'
            : bordesOk ? 'Sobel sin halos detectables' : 'Halo/ruido diferencial en mandíbula/frente'
      ),
      auditStatus(
        'Metadatos',
        metadatosOk ? 'OK' : 'ALERTA',
        isTextMode
          ? metadatosOk
            ? 'Patrones discursivos no estereotipados'
            : 'Se detectaron patrones LLM en conectores lógicos'
          : isAudioMode
            ? metadatosOk
              ? 'Codificación consistente'
              : 'Rastros de software o metadatos incompletos'
          : metadatosOk
            ? 'Cámara consistente'
            : 'Rastros de software o metadatos incompletos'
      ),
      auditStatus(
        'Coherencia Lumínica',
        luminicaStatus,
        luminicaStatus === 'OK'
          ? 'Gradiente consistente'
          : isTextMode
            ? 'Estilo y estructura compatibles con redacción LLM'
            : isAudioMode
              ? 'Señales de edición/compresión compatibles con síntesis o manipulación'
            : 'Señales ELA/frecuencia/ruido compatibles con síntesis o bordes suavizados'
      )
    ];
  }

  function downloadForensicPdf() {
    if (!selectedFile) return;
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    const pageW = doc.internal.pageSize.getWidth();
    const margin = 48;
    let y = 56;
    const pageH = doc.internal.pageSize.getHeight();

    const ensureSpace = (need: number) => {
      if (y + need <= pageH - 56) return;
      doc.addPage();
      y = 56;
    };

    // Header
    doc.setFillColor(2, 2, 2);
    doc.rect(0, 0, pageW, 90, 'F');
    doc.setTextColor(240, 240, 240);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(22);
    doc.text('KRONOS', margin, 54);
    doc.setFontSize(11);
    doc.setTextColor(240, 240, 240);
    doc.setFont('helvetica', 'normal');
    doc.text('KRONOS Certificado de Validación de Integridad', margin, 74);

    // Seal (coloreado por veredicto)
    const vLabel = verdictLabel(scan.verdict);
    const seal =
      vLabel === 'AUTÉNTICO'
        ? { r: 34, g: 197, b: 94 }
        : vLabel === 'SOSPECHOSO'
          ? { r: 245, g: 158, b: 11 }
          : vLabel === 'MANIPULADO'
            ? { r: 230, g: 57, b: 70 }
            : { r: 0, g: 229, b: 255 };

    doc.setDrawColor(seal.r, seal.g, seal.b);
    doc.setLineWidth(2);
    const sealCx = pageW - margin - 62;
    const sealCy = 50;
    doc.circle(sealCx, sealCy, 28, 'S');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(seal.r, seal.g, seal.b);
    const sealTop = vLabel === 'MANIPULADO' ? 'ALERTA' : vLabel === 'SOSPECHOSO' ? 'SOSPECHA' : 'VALIDADO';
    // Centrado premium dentro del sello (horizontal + vertical)
    doc.text(sealTop, sealCx, sealCy - 4, { align: 'center', baseline: 'middle' });
    doc.setFontSize(7);
    doc.text('INTEGRIDAD', sealCx, sealCy + 8, { align: 'center', baseline: 'middle' });

    y = 120;
    doc.setTextColor(20, 20, 20);
    doc.setFontSize(12);
    doc.setFont('helvetica', 'bold');
    doc.text('Archivo', margin, y);
    doc.setFont('helvetica', 'normal');
    {
      const nameLines = doc.splitTextToSize(selectedFile.name, pageW - margin * 2 - 70);
      doc.text(nameLines, margin + 70, y);
      y += Math.max(0, (nameLines.length - 1) * 12);
    }
    y += 22;

    doc.setFont('helvetica', 'bold');
    doc.text('SHA-256', margin, y);
    doc.setFont('courier', 'normal');
    doc.setFontSize(9);
    const hash = fileHashHex || '-';
    {
      const hashLines = doc.splitTextToSize(hash, pageW - margin * 2 - 70);
      doc.text(hashLines, margin + 70, y);
      y += Math.max(0, (hashLines.length - 1) * 10);
    }
    doc.setFontSize(12);
    doc.setFont('helvetica', 'normal');
    y += 26;

    // Divider
    doc.setDrawColor(235, 235, 235);
    doc.setLineWidth(1);
    doc.line(margin, y - 14, pageW - margin, y - 14);

    // Tipo de evidencia
    const evidenceType =
      mediaKind === 'video'
        ? 'VIDEO'
        : mediaKind === 'image'
          ? 'IMAGEN'
          : mediaKind === 'audio'
            ? 'AUDIO'
            : mediaKind === 'text'
              ? 'TEXTO'
              : '-';
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.text('Tipo de Evidencia', margin, y);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(11);
    doc.text(evidenceType, margin + 150, y);
    y += 18;

    // Verdict
    doc.setFont('helvetica', 'bold');
    doc.text('Veredicto Final', margin, y);
    const badgeX = margin + 110;
    // Badge ajustado al texto (más premium, sin invadir líneas)
    doc.setFontSize(11);
    const badgeTextW = doc.getTextWidth(vLabel);
    const badgeW = Math.min(220, Math.max(112, badgeTextW + 28));
    const badgeH = 18;
    if (vLabel === 'MANIPULADO') doc.setFillColor(230, 57, 70);
    else if (vLabel === 'SOSPECHOSO') doc.setFillColor(245, 158, 11);
    else doc.setFillColor(34, 197, 94);
    const badgeMidY = y - 4;
    const badgeY = badgeMidY - badgeH / 2;
    doc.roundedRect(badgeX, badgeY, badgeW, badgeH, 9, 9, 'F');
    doc.setTextColor(2, 2, 2);
    doc.text(vLabel, badgeX + badgeW / 2, badgeMidY, { align: 'center', baseline: 'middle' });
    doc.setTextColor(20, 20, 20);
    doc.setFontSize(12);
    y += 30;

    // Bloque de métricas (tipo-específico)
    if (mediaKind === 'image') {
      ensureSpace(120);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10);
      doc.text('Métricas de Imagen', margin, y);
      doc.setFont('courier', 'normal');
      doc.setFontSize(8.5);
      y += 14;
      if ((scan.warnings ?? []).includes('Evidencia de edición o contenido gráfico (UI/CGI)')) {
        doc.text('PROBABLE_TIPO: CONTENIDO_GRAFICO_UI_CGI', margin, y);
        y += 12;
      }
      if ((scan.warnings ?? []).includes('Posible edición local / composición (ELA por regiones)')) {
        doc.text('PROBABLE_TIPO: EDICION_LOCAL_COMPOSITE', margin, y);
        y += 12;
      }
      doc.text(`ELA_MEAN: ${(imageElaMean * 100).toFixed(1)}`, margin, y);
      y += 12;
      doc.text(`ELA_UNIFORMITY: ${(imageElaUniformity * 100).toFixed(1)}`, margin, y);
      y += 12;
      doc.text(`TEXTURE_REPEAT_SCORE: ${(imageTextureRepeatScore * 100).toFixed(1)}`, margin, y);
      y += 12;
      doc.text(`FREQ_PEAKINESS: ${imageFreqPeakiness.toFixed(4)}`, margin, y);
      y += 12;
      doc.text(`FREQ_RADIAL_VAR: ${imageFreqRadialVar.toFixed(4)}`, margin, y);
      y += 12;
      doc.text(`EDGE_SHARPNESS: ${imageEdgeSharpness.toFixed(4)}`, margin, y);
      y += 12;
      doc.text(`NOISE_MEAN: ${imageNoiseMean.toFixed(4)}`, margin, y);
      y += 12;
      doc.text(`NOISE_UNIFORMITY: ${(imageNoiseUniformity * 100).toFixed(1)}`, margin, y);
      y += 12;
      doc.text(`LIGHTING_INCONSISTENCY: ${imageLightingInconsistency.toFixed(3)}`, margin, y);
      y += 12;
      doc.text(`EDGE_PERFECTION: ${imageEdgePerfection.toFixed(3)}`, margin, y);
      y += 12;
      doc.text(`RENDER_SIGNATURE: ${imageRenderSignature.toFixed(3)}`, margin, y);
      y += 18;
    } else if (mediaKind === 'audio') {
      ensureSpace(120);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10);
      doc.text('Métricas de Audio', margin, y);
      doc.setFont('courier', 'normal');
      doc.setFontSize(8.5);
      y += 14;
      doc.text(`DURATION_SEC: ${audioDurationSec.toFixed(2)}`, margin, y);
      y += 12;
      doc.text(`SAMPLE_RATE: ${audioSampleRate || 0}`, margin, y);
      y += 12;
      doc.text(`CHANNELS: ${audioChannels || 0}`, margin, y);
      y += 12;
      doc.text(`CLIP_RATIO: ${(audioClipRatio * 100).toFixed(2)}%`, margin, y);
      y += 12;
      doc.text(`BANDLIMIT_SCORE: ${audioBandlimitScore.toFixed(3)}`, margin, y);
      y += 12;
      doc.text(`EDIT_CUTS: ${audioEditCuts}`, margin, y);
      y += 18;
    } else if (mediaKind === 'text') {
      ensureSpace(80);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10);
      doc.text('Métricas de Texto', margin, y);
      doc.setFont('courier', 'normal');
      doc.setFontSize(8.5);
      y += 14;
      doc.text(`CONNECTOR_SCORE: ${textConnectorScore.toFixed(4)}`, margin, y);
      y += 12;
      const preview = (textTopConnectors ?? []).slice(0, 6).join(' | ');
      const textW = pageW - margin * 2;
      const connectorLines = doc.splitTextToSize(`TOP_CONNECTORS: ${preview || '-'}`, textW);
      doc.text(connectorLines, margin, y);
      y += Math.max(0, (connectorLines.length - 1) * 12);
      y += 18;
    }

    // Table (4 niveles)
    ensureSpace(18 + 32 * 5 + 24);
    doc.setFont('helvetica', 'bold');
    doc.text('Niveles de Auditoría', margin, y);
    y += 18;

    const tableX = margin;
    const tableW = pageW - margin * 2;
    const rowH = 32;
    const col1 = 150;
    const col2 = 90;
    const col3 = tableW - col1 - col2;

    const rows = buildAuditTable(scan.warnings ?? []);
    doc.setDrawColor(26, 26, 26);
    doc.setLineWidth(1);
    doc.setFillColor(10, 10, 10);
    doc.rect(tableX, y, tableW, rowH, 'F');
    doc.setTextColor(240, 240, 240);
    doc.setFontSize(10);
    doc.text('Área', tableX + 12, y + 20);
    doc.text('Estado', tableX + col1 + 12, y + 20);
    doc.text('Detalle', tableX + col1 + col2 + 12, y + 20);
    y += rowH;

    for (const r of rows) {
      // Zebra suave
      const idx = rows.indexOf(r);
      if (idx % 2 === 0) {
        doc.setFillColor(248, 248, 248);
        doc.rect(tableX, y, tableW, rowH, 'F');
      }
      doc.setDrawColor(230, 230, 230);
      doc.rect(tableX, y, tableW, rowH, 'S');
      doc.setTextColor(20, 20, 20);
      doc.setFont('helvetica', 'bold');
      doc.text(r.label, tableX + 12, y + 20);
      doc.setFont('helvetica', 'bold');
      const tableStatus = r.status;
      if (tableStatus === 'OK') doc.setTextColor(20, 140, 60);
      else if (tableStatus === 'ALERTA') doc.setTextColor(230, 57, 70);
      else doc.setTextColor(130, 130, 130);
      doc.text(r.status, tableX + col1 + 12, y + 20);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(20, 20, 20);
      doc.setFontSize(9.5);
      doc.text(r.detail, tableX + col1 + col2 + 12, y + 20, { maxWidth: col3 - 18 });
      doc.setFontSize(10);
      y += rowH;
    }

    // Warnings block
    y += 18;
    ensureSpace(80);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(20, 20, 20);
    doc.text('Avisos', margin, y);
    y += 14;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    const warn = (scan.warnings ?? []).length ? scan.warnings ?? [] : ['Ninguno'];
    for (const w of warn) {
      const lines = doc.splitTextToSize(`- ${w}`, tableW);
      doc.text(lines, margin, y);
      y += lines.length * 14;
      ensureSpace(28);
    }

    // Footer
    doc.setFontSize(9);
    doc.setTextColor(120, 120, 120);
    doc.text('KRONOS v1.0 - Secured by Neural Encryption', margin, pageH - 28);

    doc.save(`KRONOS-Forensic-Report-${Date.now()}.pdf`);
  }

  async function readCameraMetadata(file: File) {
    try {
      const meta = await exifr.parse(file as unknown as Blob);
      const make = (meta?.Make ?? meta?.make ?? '').toString();
      const model = (meta?.Model ?? meta?.model ?? '').toString();
      const iso = Number(meta?.ISO ?? meta?.iso ?? NaN);
      const fNumber = Number(meta?.FNumber ?? meta?.fNumber ?? meta?.ApertureValue ?? NaN);
      const combined = `${make} ${model}`.trim();
      return { make, model, combined, iso: Number.isFinite(iso) ? iso : null, fNumber: Number.isFinite(fNumber) ? fNumber : null };
    } catch {
      return { make: '', model: '', combined: '', iso: null, fNumber: null };
    }
  }

  function isKnownCamera(makeOrModel: string) {
    return /(apple|samsung|sony)/i.test(makeOrModel);
  }

  async function ensureMediaInfoLoaded() {
    if (mediaInfoReady || mediaInfoLoading) return;
    mediaInfoLoading = true;
    try {
      mediaInfoInstance = (await mediaInfoFactory({
        format: 'object',
        full: true,
        // Vite necesita que le indiquemos el URL real del WASM para evitar 404 en /node_modules/.vite/...
        locateFile: () => mediaInfoWasmUrl
      })) as unknown as { analyzeData: Function; close: Function };
      mediaInfoReady = true;
    } finally {
      mediaInfoLoading = false;
    }
  }

  function flattenStrings(input: unknown, out: string[] = []) {
    if (input == null) return out;
    if (typeof input === 'string') {
      out.push(input);
      return out;
    }
    if (typeof input === 'number' || typeof input === 'boolean') return out;
    if (Array.isArray(input)) {
      for (const v of input) flattenStrings(v, out);
      return out;
    }
    if (typeof input === 'object') {
      for (const v of Object.values(input as Record<string, unknown>)) flattenStrings(v, out);
    }
    return out;
  }

  async function scanMediaInfoHints(result: unknown) {
    const encoderHints: string[] = [];
    const pushHint = (label: string) => {
      if (!encoderHints.includes(label)) encoderHints.push(label);
    };

    let visited = 0;
    const maxVisited = 18_000;
    const maxStringLen = 14_000;

    const walk = (v: unknown) => {
      if (visited++ > maxVisited) return;
      if (v == null) return;

      if (typeof v === 'string') {
        const s = v.length > maxStringLen ? v.slice(0, maxStringLen) : v;
        if (/lavf/i.test(s)) pushHint('Lavf');
        if (/ffmpeg/i.test(s)) pushHint('FFmpeg');
        if (/handbrake/i.test(s)) pushHint('HandBrake');

        if (
          /(encoded_?application|writing_?library|encoder)/i.test(s) &&
          (/adobe|premiere|after effects|davinci|resolve|capcut|final cut|kinemaster|vlc/i.test(s) || encoderHints.length === 0)
        ) {
          pushHint('Editor');
        }

        return;
      }

      if (typeof v === 'number' || typeof v === 'boolean') return;

      if (Array.isArray(v)) {
        for (const x of v) walk(x);
        return;
      }

      if (typeof v === 'object') {
        for (const x of Object.values(v as Record<string, unknown>)) walk(x);
      }
    };

    // Primer pase sin bloquear el repintado.
    await yieldToUI();
    walk(result);
    await yieldToUI();

    return { thirdParty: encoderHints.length > 0, encoderHints };
  }

  async function auditMediaInfo(file: File) {
    await ensureMediaInfoLoaded();
    if (!mediaInfoInstance) return { thirdParty: false, encoderHints: [] as string[] };

    const readChunk = async (chunkSize: number, offset: number) => {
      const buffer = await file.slice(offset, offset + chunkSize).arrayBuffer();
      return new Uint8Array(buffer);
    };

    const result = await (mediaInfoInstance.analyzeData as any)(file.size, readChunk);
    // Evita `join()` masivo (puede congelar el hilo en resultados grandes)
    return await scanMediaInfoHints(result);
  }

  function meanLandmarkJitter(prev: { x: number; y: number }[], next: { x: number; y: number }[], norm: number) {
    const n = Math.min(prev.length, next.length);
    if (!n || !norm) return 0;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const dx = next[i].x - prev[i].x;
      const dy = next[i].y - prev[i].y;
      sum += Math.hypot(dx, dy);
    }
    return (sum / n) / norm;
  }

  function dist(a: { x: number; y: number }, b: { x: number; y: number }) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  // Eye Aspect Ratio (EAR) usando 6 puntos por ojo (landmarks 68)
  // EAR = (||p2-p6|| + ||p3-p5||) / (2 * ||p1-p4||)
  function earForEye(pts: { x: number; y: number }[], start: number) {
    const p1 = pts[start + 0];
    const p2 = pts[start + 1];
    const p3 = pts[start + 2];
    const p4 = pts[start + 3];
    const p5 = pts[start + 4];
    const p6 = pts[start + 5];
    if (!p1 || !p2 || !p3 || !p4 || !p5 || !p6) return 0;
    const vertical = dist(p2, p6) + dist(p3, p5);
    const horizontal = 2 * dist(p1, p4);
    return horizontal ? vertical / horizontal : 0;
  }

  function mean(values: number[]) {
    if (!values.length) return 0;
    return values.reduce((a, b) => a + b, 0) / values.length;
  }

  function std(values: number[]) {
    if (values.length < 2) return 0;
    const m = mean(values);
    const v = values.reduce((acc, x) => acc + (x - m) * (x - m), 0) / (values.length - 1);
    return Math.sqrt(v);
  }

  function roiTextureContrastPointsFromGray(
    gray: Float32Array,
    w: number,
    h: number,
    box: { x: number; y: number; width: number; height: number }
  ) {
    const x0 = Math.max(1, Math.floor(box.x));
    const y0 = Math.max(1, Math.floor(box.y));
    const x1 = Math.min(w - 2, Math.floor(box.x + box.width));
    const y1 = Math.min(h - 2, Math.floor(box.y + box.height));
    if (x1 <= x0 + 6 || y1 <= y0 + 6) {
      return { pts40: 0, pts20: 0, roiNoise: 0, bgNoise: 0, roiEdge: 0, bgEdge: 0 };
    }

    const isIn = (x: number, y: number) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
    const idx = (x: number, y: number) => y * w + x;

    let roiNoiseSum = 0;
    let roiNoiseCount = 0;
    let bgNoiseSum = 0;
    let bgNoiseCount = 0;

    let roiEdgeSum = 0;
    let roiEdgeCount = 0;
    let bgEdgeSum = 0;
    let bgEdgeCount = 0;

    // Submuestreo para CPU
    for (let y = 1; y < h - 1; y += 2) {
      for (let x = 1; x < w - 1; x += 2) {
        const i = idx(x, y);
        const c = gray[i];
        const lap = Math.abs(-4 * c + gray[i - 1] + gray[i + 1] + gray[i - w] + gray[i + w]);

        const tl = gray[idx(x - 1, y - 1)];
        const tc = gray[idx(x, y - 1)];
        const tr = gray[idx(x + 1, y - 1)];
        const ml = gray[idx(x - 1, y)];
        const mr = gray[idx(x + 1, y)];
        const bl = gray[idx(x - 1, y + 1)];
        const bc = gray[idx(x, y + 1)];
        const br = gray[idx(x + 1, y + 1)];
        const gx = -tl + tr - 2 * ml + 2 * mr - bl + br;
        const gy = tl + 2 * tc + tr - bl - 2 * bc - br;
        const edge = Math.abs(gx) + Math.abs(gy);

        if (isIn(x, y)) {
          roiNoiseSum += lap;
          roiNoiseCount += 1;
          roiEdgeSum += edge;
          roiEdgeCount += 1;
        } else {
          bgNoiseSum += lap;
          bgNoiseCount += 1;
          bgEdgeSum += edge;
          bgEdgeCount += 1;
        }
      }
    }

    const roiNoise = roiNoiseCount ? roiNoiseSum / roiNoiseCount : 0;
    const bgNoise = bgNoiseCount ? bgNoiseSum / bgNoiseCount : 0;
    const roiEdge = roiEdgeCount ? roiEdgeSum / roiEdgeCount : 0;
    const bgEdge = bgEdgeCount ? bgEdgeSum / bgEdgeCount : 0;

    const pts40 = roiNoise < bgNoise * 0.7 && roiEdge < bgEdge * 0.86 ? 40 : 0;
    const rel = bgNoise > 1e-6 ? Math.abs(roiNoise - bgNoise) / bgNoise : Math.abs(roiNoise - bgNoise);
    const pts20 = rel > 0.35 ? 20 : 0;

    return { pts40, pts20, roiNoise, bgNoise, roiEdge, bgEdge };
  }

  async function seekTo(video: HTMLVideoElement, time: number) {
    const t = Math.max(0, Math.min(time, Number.isFinite(video.duration) ? Math.max(0, video.duration - 0.001) : time));
    if (Math.abs(video.currentTime - t) < 0.02) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        video.removeEventListener('seeked', done);
        resolve();
      };
      video.addEventListener('seeked', done, { once: true });
      video.currentTime = t;
      setTimeout(() => {
        video.removeEventListener('seeked', done);
        resolve();
      }, 800);
    });
  }

  async function analyzeImageElaAndTexture(file: File) {
    // ELA (Error Level Analysis) + heurística de repetición de texturas.
    // Todo es client-side y se mantiene liviano limitando el tamaño.
    const maxAnalysisDim = 440;
    const thresholdElaHigh = 20; // diff típico (0..255)
    const emptyLowLevel = {
      prnuResidualRisk0to100: 0,
      prnuResidualMetrics: { excessKurtosis: 0, lag1CorrAbs: 0, blockVarianceCv: 0, residualStd: 0 },
      prnuResidualNotes: [] as string[],
      dctDoubleQuantRisk0to100: 0,
      dctDoubleQuantMetrics: { acHistPeakRatio: 0, acHistAutocorrMax: 0, blocksSampled: 0 },
      dctDoubleQuantNotes: [] as string[]
    };

    const objUrl = URL.createObjectURL(file);
    try {
      if (!canvasRef) {
        return {
          elaMean: 0,
          elaStd: 0,
          elaUniformity: 0,
          elaSynthetic: false,
          textureRepeatScore: 0,
          textureSynthetic: false,
          ...emptyLowLevel
        };
      }

      // Cargar imagen
      const img = new Image();
      img.decoding = 'async';
      img.src = objUrl;
      await img.decode();

      // Ajustar para CPU razonable
      const naturalW = img.naturalWidth || 0;
      const naturalH = img.naturalHeight || 0;
      if (!naturalW || !naturalH) {
        return {
          elaMean: 0,
          elaStd: 0,
          elaUniformity: 0,
          elaSynthetic: false,
          textureRepeatScore: 0,
          textureSynthetic: false,
          ...emptyLowLevel
        };
      }

      const scale = Math.min(1, maxAnalysisDim / Math.max(naturalW, naturalH));
      const w = Math.max(96, Math.floor(naturalW * scale));
      const h = Math.max(96, Math.floor(naturalH * scale));

      tickScan(350, 38);

      // Dibujar a canvas para comparar con recomprensión JPEG
      const work = document.createElement('canvas');
      work.width = w;
      work.height = h;
      const workCtx = work.getContext('2d', { willReadFrequently: true });
      if (!workCtx) {
        return {
          elaMean: 0,
          elaStd: 0,
          elaUniformity: 0,
          elaSynthetic: false,
          textureRepeatScore: 0,
          textureSynthetic: false,
          ...emptyLowLevel
        };
      }
      workCtx.drawImage(img, 0, 0, w, h);

      // Recomprensión JPEG con calidad baja (sirve como "segundo término" de la ELA)
      // Nota: la ELA real requiere normalizar por el factor de re-compresión;
      // aquí hacemos un proxy robusto por uniformidad estadística.
      const recompressedDataUrl = work.toDataURL('image/jpeg', 0.48);
      const reImg = new Image();
      reImg.decoding = 'async';
      reImg.src = recompressedDataUrl;
      await reImg.decode();

      const work2 = document.createElement('canvas');
      work2.width = w;
      work2.height = h;
      const ctx2 = work2.getContext('2d', { willReadFrequently: true });
      if (!ctx2) {
        return {
          elaMean: 0,
          elaStd: 0,
          elaUniformity: 0,
          elaSynthetic: false,
          textureRepeatScore: 0,
          textureSynthetic: false,
          ...emptyLowLevel
        };
      }
      ctx2.drawImage(reImg, 0, 0, w, h);

      const dataA = workCtx.getImageData(0, 0, w, h).data;
      const dataB = ctx2.getImageData(0, 0, w, h).data;

      const n = w * h;
      const diffs = new Uint8Array(n);
      const grayA = new Float32Array(n);
      // Señal "contenido gráfico/UI/CGI": paleta pequeña + bordes muy nítidos + ruido bajo
      // Se calcula con muestreo para mantener CPU baja.
      const colorKeys = new Set<number>();
      let graySum = 0;
      let graySumSq = 0;
      let grayCount = 0;

      // Estadísticos sin convertir diffs a arrays (más eficiente)
      let sum = 0;
      let sumSq = 0;
      let highCount = 0;
      for (let i = 0; i < n; i++) {
        const j = i * 4;
        const rA = dataA[j + 0];
        const gA = dataA[j + 1];
        const bA = dataA[j + 2];
        const g = (0.299 * rA + 0.587 * gA + 0.114 * bA) / 255;
        grayA[i] = g;

        const dr = Math.abs(rA - dataB[j + 0]);
        const dg = Math.abs(gA - dataB[j + 1]);
        const db = Math.abs(bA - dataB[j + 2]);
        // Promedio de diferencias por canal
        const d = (dr + dg + db) / 3;
        const di = d > 255 ? 255 : d;
        diffs[i] = di;
        sum += di;
        sumSq += di * di;
        if (di > thresholdElaHigh) highCount++;

        // Muestreo 1/16 píxeles aprox para paleta/varianza
        if ((i & 15) === 0) {
          const key = ((rA >> 3) << 10) | ((gA >> 3) << 5) | (bA >> 3);
          if (colorKeys.size < 1200) colorKeys.add(key);
          graySum += g;
          graySumSq += g * g;
          grayCount++;
        }
      }

      const elaMeanRaw = sum / n;
      const variance = n > 1 ? Math.max(0, (sumSq - (sum * sum) / n) / (n - 1)) : 0;
      const stdDev = Math.sqrt(variance);
      const uniformity = stdDev / (elaMeanRaw + 1e-6);
      const highRatio = highCount / n;

      // Proxy: "sintético" si el error es alto y bastante uniforme
      const elaSynthetic = elaMeanRaw > 6 && highRatio > 0.22 && uniformity < 0.9;

      // ELA por regiones (composite / edición local):
      // Si hay tiles con error significativamente mayor que el resto, suele indicar composición/inpainting.
      // Usamos la misma `diffs` ya calculada (barato).
      const tiles = 6; // 6x6 = 36 regiones
      const tileW = Math.max(1, Math.floor(w / tiles));
      const tileH = Math.max(1, Math.floor(h / tiles));
      const tileMeans: number[] = [];
      for (let ty = 0; ty < tiles; ty++) {
        for (let tx = 0; tx < tiles; tx++) {
          const x0 = tx * tileW;
          const y0 = ty * tileH;
          const x1 = tx === tiles - 1 ? w : Math.min(w, (tx + 1) * tileW);
          const y1 = ty === tiles - 1 ? h : Math.min(h, (ty + 1) * tileH);
          let s = 0;
          let c = 0;
          for (let yy = y0; yy < y1; yy += 2) {
            const row = yy * w;
            for (let xx = x0; xx < x1; xx += 2) {
              s += diffs[row + xx];
              c++;
            }
          }
          tileMeans.push(c ? s / c : 0);
        }
      }
      const tileMean = mean(tileMeans);
      const tileStd = std(tileMeans);
      const localElaCv = tileStd / (tileMean + 1e-6);
      const localElaMax = tileMeans.length ? Math.max(...tileMeans) : 0;
      const localElaPeakRatio = localElaMax / (tileMean + 1e-6);
      const localEditLikely =
        // Variación regional alta + un "pico" local claro
        localElaCv > 0.55 && localElaPeakRatio > 1.75 && localElaMax > 8;

      // ---- NUEVO: Noise Analysis (ruido de fondo) + Render Signature ----
      // Idea: muchas imágenes IA (Grok/Flux) son excesivamente "limpias" y con suavidad muy uniforme.
      // Usamos un proxy ligero: energía de alta frecuencia (Laplacian) por tiles + suavidad adyacente.
      let noiseMean = 0;
      let noiseUniformity = 0;
      let renderSignatureScore = 0;
      try {
        const tilesN = 6;
        const tW = Math.max(8, Math.floor(w / tilesN));
        const tH = Math.max(8, Math.floor(h / tilesN));
        const tileNoise: number[] = [];

        // Laplacian |∇²| aprox sobre gris (0..1). Submuestreo para CPU.
        for (let ty = 0; ty < tilesN; ty++) {
          for (let tx = 0; tx < tilesN; tx++) {
            const x0 = tx * tW;
            const y0 = ty * tH;
            const x1 = tx === tilesN - 1 ? w - 1 : Math.min(w - 1, (tx + 1) * tW);
            const y1 = ty === tilesN - 1 ? h - 1 : Math.min(h - 1, (ty + 1) * tH);
            let s = 0;
            let c = 0;
            for (let yy = y0 + 1; yy < y1; yy += 2) {
              const row = yy * w;
              for (let xx = x0 + 1; xx < x1; xx += 2) {
                const i = row + xx;
                const center = grayA[i];
                const lap =
                  -4 * center +
                  grayA[i - 1] +
                  grayA[i + 1] +
                  grayA[i - w] +
                  grayA[i + w];
                s += Math.abs(lap);
                c++;
              }
            }
            tileNoise.push(c ? s / c : 0);
          }
        }

        noiseMean = mean(tileNoise); // ~0..0.3 (proxy)
        const noiseStd = std(tileNoise);
        const noiseCv = noiseStd / (noiseMean + 1e-6);
        // Uniformidad alta = CV bajo
        noiseUniformity = 1 - Math.max(0, Math.min(1, noiseCv / 0.9));

        // Render signature: fracción de píxeles con gradiente muy bajo y curvatura muy baja (excesivamente suave)
        let smoothCount = 0;
        let sampleCount = 0;
        for (let yy = 1; yy < h - 1; yy += 2) {
          for (let xx = 1; xx < w - 1; xx += 2) {
            const i = yy * w + xx;
            const gx = grayA[i + 1] - grayA[i - 1];
            const gy = grayA[i + w] - grayA[i - w];
            const gmag = Math.abs(gx) + Math.abs(gy);
            const lap =
              -4 * grayA[i] +
              grayA[i - 1] +
              grayA[i + 1] +
              grayA[i - w] +
              grayA[i + w];
            const curv = Math.abs(lap);
            // Umbrales conservadores (para no penalizar cielos/ paredes): pedimos ambos muy bajos
            if (gmag < 0.018 && curv < 0.02) smoothCount++;
            sampleCount++;
          }
        }
        renderSignatureScore = sampleCount ? smoothCount / sampleCount : 0;
      } catch {
        noiseMean = 0;
        noiseUniformity = 0;
        renderSignatureScore = 0;
      }

      // ---- NUEVO: ROI universal (cara vs fondo) usando face-api.js ----
      // Seguridad: solo aplicamos puntos si la cara es clara (>=90%).
      let roiFaceScore = 0;
      let roiPerfectPts = 0;
      let roiNoiseMismatchPts = 0;
      let roiNoiseFace = 0;
      let roiNoiseBg = 0;
      let roiEdgeFace = 0;
      let roiEdgeBg = 0;
      try {
        await withTimeout(ensureModelsLoaded(), 12000, 'FACE_MODELS_IMG');
        const options = new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.2 });
        const det = await faceapi.detectSingleFace(work, options);
        const score = det?.score ?? 0;
        roiFaceScore = score;
        if (det && score >= 0.9) {
          // Expandimos un poco el ROI para cubrir piel/borde facial
          const padX = det.box.width * 0.08;
          const padY = det.box.height * 0.08;
          const mapped = {
            x: clamp(det.box.x - padX, 0, w - 1),
            y: clamp(det.box.y - padY, 0, h - 1),
            width: clamp(det.box.width + padX * 2, 12, w - (det.box.x - padX)),
            height: clamp(det.box.height + padY * 2, 12, h - (det.box.y - padY))
          };
          const roiRes = roiTextureContrastPointsFromGray(grayA, w, h, mapped);
          roiPerfectPts = roiRes.pts40;
          roiNoiseMismatchPts = roiRes.pts20;
          roiNoiseFace = roiRes.roiNoise;
          roiNoiseBg = roiRes.bgNoise;
          roiEdgeFace = roiRes.roiEdge;
          roiEdgeBg = roiRes.bgEdge;
        }
      } catch {
        roiFaceScore = 0;
        roiPerfectPts = 0;
        roiNoiseMismatchPts = 0;
      }

      tickScan(600, 58);

      // Heatmap de ELA (overlay)
      const heat = document.createElement('canvas');
      heat.width = w;
      heat.height = h;
      const heatCtx = heat.getContext('2d');
      if (heatCtx) {
        const heatImg = heatCtx.createImageData(w, h);
        const gold = { r: 212, g: 175, b: 55 };
        const red = { r: 230, g: 57, b: 70 };
        // Normalización aproximada: "d" ~ 0..60 suele ser útil en este dominio
        const norm = 70;
        for (let i = 0; i < n; i++) {
          const di = diffs[i];
          const t = Math.max(0, Math.min(1, di / norm));
          const r = Math.floor(gold.r + (red.r - gold.r) * t);
          const g = Math.floor(gold.g + (red.g - gold.g) * t);
          const b = Math.floor(gold.b + (red.b - gold.b) * t);
          const a = Math.floor(25 + t * 220);
          const k = i * 4;
          heatImg.data[k + 0] = r;
          heatImg.data[k + 1] = g;
          heatImg.data[k + 2] = b;
          heatImg.data[k + 3] = a;
        }
        heatCtx.putImageData(heatImg, 0, 0);
      }
      // Guardar overlay (drawOverlay lo pintará solo durante ANALYZING)
      elaOverlayCanvas = heat;

      tickScan(780, 72);

      // Heurística: patrones repetitivos en texturas (tipo Stable Diffusion)
      // Proxy por similitud entre parches: si muchos parches del mismo "tipo" son demasiado parecidos,
      // hay alta probabilidad de generación / rejillas repetitivas.
      const grid = 4; // 4x4 => 16 parches (equilibrio CPU/precisión)
      const blockW = Math.floor(w / grid);
      const blockH = Math.floor(h / grid);
      const featureSize = 8; // 8x8 => 64 valores por parche

      const features: Float32Array[] = [];
      const grayAt = (x: number, y: number) => {
        const xx = clamp(x, 0, w - 1);
        const yy = clamp(y, 0, h - 1);
        return grayA[yy * w + xx];
      };

      for (let by = 0; by < grid; by++) {
        for (let bx = 0; bx < grid; bx++) {
          const fv = new Float32Array(featureSize * featureSize);
          for (let fy = 0; fy < featureSize; fy++) {
            for (let fx = 0; fx < featureSize; fx++) {
              const u = (fx + 0.5) / featureSize;
              const v = (fy + 0.5) / featureSize;
              const sx = bx * blockW + u * blockW;
              const sy = by * blockH + v * blockH;
              fv[fy * featureSize + fx] = grayAt(Math.floor(sx), Math.floor(sy));
            }
          }
          features.push(fv);
        }
      }

      const totalPairs = (features.length * (features.length - 1)) / 2;
      let similarPairs = 0;
      const mseSimilarThreshold = 0.0022; // sintonizar si hace falta
      for (let i = 0; i < features.length; i++) {
        for (let j = i + 1; j < features.length; j++) {
          let mse = 0;
          const a = features[i];
          const b = features[j];
          for (let k = 0; k < a.length; k++) {
            const diff = a[k] - b[k];
            mse += diff * diff;
          }
          mse /= a.length;
          if (mse < mseSimilarThreshold) similarPairs++;
        }
      }

      const textureRepeatScore = totalPairs ? similarPairs / totalPairs : 0;
      const textureSynthetic = textureRepeatScore > 0.17 && highRatio > 0.14;

      // Análisis en dominio frecuencia (proxy FFT/DCT) y suavizado artificial.
      // DCT-II 2D sobre un recorte central pequeño para mantener el coste en CPU.
      const minDim = Math.min(w, h);
      const freqMinDim = 20;
      let frequencySynthetic = false;
      let freqPeakiness = 0;
      let freqRadialVar = 0;

      if (minDim >= freqMinDim) {
        const N = Math.min(32, Math.floor(minDim));
        const startX = Math.max(0, Math.floor((w - N) / 2));
        const startY = Math.max(0, Math.floor((h - N) / 2));

        const f = new Float32Array(N * N);
        let fSum = 0;
        for (let y = 0; y < N; y++) {
          for (let x = 0; x < N; x++) {
            const v = grayA[(startY + y) * w + (startX + x)];
            f[y * N + x] = v;
            fSum += v;
          }
        }
        const fMean = fSum / (N * N);
        for (let i = 0; i < f.length; i++) f[i] -= fMean;

        const alpha = (k: number) => (k === 0 ? Math.sqrt(1 / N) : Math.sqrt(2 / N));

        // Cos tablas para DCT separable
        const cosX = new Float32Array(N * N);
        const cosY = new Float32Array(N * N);
        const factor = Math.PI / (2 * N);
        for (let u = 0; u < N; u++) {
          for (let x = 0; x < N; x++) {
            cosX[u * N + x] = Math.cos((2 * x + 1) * u * factor);
            cosY[u * N + x] = Math.cos((2 * x + 1) * u * factor);
          }
        }

        // Paso 1: DCT sobre filas/columnas (a lo largo de x)
        const temp = new Float32Array(N * N); // [u, y]
        for (let u = 0; u < N; u++) {
          for (let y = 0; y < N; y++) {
            let sum = 0;
            const rowBase = y * N;
            for (let x = 0; x < N; x++) {
              sum += f[rowBase + x] * cosX[u * N + x];
            }
            temp[u * N + y] = sum;
          }
        }

        // Paso 2: transform sobre y y métricas del espectro
        const radiusBuckets = new Float32Array(N);
        const radiusCounts = new Uint32Array(N);
        let maxP = 0;
        let totalP = 0;

        const maxRadius = Math.floor(Math.sqrt((N - 1) * (N - 1) + (N - 1) * (N - 1)));

        for (let u = 0; u < N; u++) {
          for (let v = 0; v < N; v++) {
            let sum = 0;
            for (let y = 0; y < N; y++) {
              sum += temp[u * N + y] * cosY[v * N + y];
            }
            const coeff = alpha(u) * alpha(v) * sum;
            const p = coeff * coeff;
            totalP += p;
            if (p > maxP) maxP = p;

            const rad = Math.floor(Math.sqrt(u * u + v * v));
            if (rad > 0 && rad < radiusBuckets.length && rad <= maxRadius) {
              radiusBuckets[rad] += p;
              radiusCounts[rad] += 1;
            }
          }
        }

        freqPeakiness = maxP / (totalP + 1e-9);

        // Varianza radial (normalizada)
        const energies: number[] = [];
        for (let r = 1; r < radiusBuckets.length; r++) {
          if (!radiusCounts[r]) continue;
          energies.push(radiusBuckets[r] / radiusCounts[r]);
        }
        if (energies.length > 2) {
          const m = energies.reduce((a, b) => a + b, 0) / energies.length;
          const v = energies.reduce((acc, x) => acc + (x - m) * (x - m), 0) / (energies.length - 1);
          const s = Math.sqrt(v);
          freqRadialVar = s / (m + 1e-9);
        }

        // Heurística: síntesis tiende a concentrar energía en patrones discretos + espectro menos "suave"
        frequencySynthetic = freqPeakiness > 0.014 && freqRadialVar > 0.55;
      }

      tickScan(880, 82);

      // Detección de bordes suavizados (edge softening) por "sharpness" de gradientes.
      let edgesSmoothedSynthetic = false;
      let edgeSharpnessMean = 0;
      let edgePerfectionScore = 0;
      let lightingInconsistencyScore = 0;
      let vectorGraphicLike = false;
      try {
        const edgeW = Math.max(120, Math.min(200, Math.floor(w * 0.65)));
        const edgeH = Math.max(120, Math.min(200, Math.floor(h * 0.65)));

        const edgeCanvas = document.createElement('canvas');
        edgeCanvas.width = edgeW;
        edgeCanvas.height = edgeH;
        const edgeCtx = edgeCanvas.getContext('2d', { willReadFrequently: true });
        if (edgeCtx) {
          edgeCtx.drawImage(work, 0, 0, w, h, 0, 0, edgeW, edgeH);
          const edgeImg = edgeCtx.getImageData(0, 0, edgeW, edgeH);

          const edgeGray = new Float32Array(edgeW * edgeH);
          const ed = edgeImg.data;
          for (let i = 0; i < edgeW * edgeH; i++) {
            const j = i * 4;
            edgeGray[i] = (0.299 * ed[j] + 0.587 * ed[j + 1] + 0.114 * ed[j + 2]) / 255;
          }

          // Sobel (aprox por |Gx|+|Gy|)
          let sumMag = 0;
          let sumSq = 0;
          let count = 0;
          let edgeCount = 0;
          let perfectCount = 0;
          // Lighting proxy: dirección de gradiente por tiles (solo para señal débil)
          const orientBuckets: number[] = [];

          for (let y = 1; y < edgeH - 1; y++) {
            for (let x = 1; x < edgeW - 1; x++) {
              const i = y * edgeW + x;
              const tl = edgeGray[(y - 1) * edgeW + (x - 1)];
              const tc = edgeGray[(y - 1) * edgeW + x];
              const tr = edgeGray[(y - 1) * edgeW + (x + 1)];
              const ml = edgeGray[y * edgeW + (x - 1)];
              const mr = edgeGray[y * edgeW + (x + 1)];
              const bl = edgeGray[(y + 1) * edgeW + (x - 1)];
              const bc = edgeGray[(y + 1) * edgeW + x];
              const br = edgeGray[(y + 1) * edgeW + (x + 1)];

              const gx = -tl + tr - 2 * ml + 2 * mr - bl + br;
              const gy = tl + 2 * tc + tr - bl - 2 * bc - br;
              const mag = Math.abs(gx) + Math.abs(gy); // rango aprox 0..4
              sumMag += mag;
              sumSq += mag * mag;
              count++;

              // Bordes de alta frecuencia "demasiado perfectos":
              // si el borde es muy fuerte pero no hay variación cromática (sin fringing) y el contorno es ultra nítido.
              if (mag > 1.25) {
                edgeCount++;
                const j = i * 4;
                const r = ed[j] / 255;
                const g = ed[j + 1] / 255;
                const b = ed[j + 2] / 255;
                const chroma = Math.abs(r - g) + Math.abs(b - g);
                if (chroma < 0.035) perfectCount++;
              }

              // Acumulamos una orientación discretizada para un proxy de coherencia de iluminación
              if ((x & 7) === 0 && (y & 7) === 0) {
                const angle = Math.atan2(gy, gx); // -pi..pi
                // bin 0..15
                const bin = Math.floor(((angle + Math.PI) / (2 * Math.PI)) * 16) % 16;
                orientBuckets[bin] = (orientBuckets[bin] ?? 0) + 1;
              }
            }
          }

          edgeSharpnessMean = sumMag / (count + 1e-9);
          const edgeStd = Math.sqrt(Math.max(0, sumSq / (count + 1e-9) - edgeSharpnessMean * edgeSharpnessMean));

          edgePerfectionScore = edgeCount ? perfectCount / edgeCount : 0;
          // Coherencia de iluminación (proxy): si no hay una dirección dominante de gradiente, sube inconsistencia.
          const totalO = orientBuckets.reduce((a, b) => a + (b ?? 0), 0);
          const maxO = orientBuckets.length ? Math.max(...orientBuckets.map((x) => x ?? 0)) : 0;
          const dominance = totalO ? maxO / totalO : 0; // 0..1
          lightingInconsistencyScore = 1 - dominance;

          // Proxy: imágenes sintéticas suelen ser menos "agudas" en bordes.
          edgesSmoothedSynthetic = edgeSharpnessMean < 0.34 && (frequencySynthetic || elaSynthetic) && edgeStd < 0.22;

          // Señal de "mockup/UI/CGI": paleta limitada + bordes muy nítidos + baja varianza de luminancia.
          const grayMean = grayCount ? graySum / grayCount : 0;
          const grayVar = grayCount ? Math.max(0, graySumSq / grayCount - grayMean * grayMean) : 0;
          const grayStd = Math.sqrt(grayVar);
          const palette = colorKeys.size;
          vectorGraphicLike =
            palette > 0 &&
            palette < 90 &&
            grayStd < 0.16 &&
            edgeSharpnessMean > 0.52 &&
            // Evita disparar por ruido "IA" real: esto es más bien edición/CGI.
            !textureSynthetic;
        }
      } catch {
        edgesSmoothedSynthetic = false;
        edgeSharpnessMean = 0;
        vectorGraphicLike = false;
      }

      const prnuRes = analyzePrnuResidualProxy(grayA, w, h);
      const dctRes = analyzeDctDoubleQuantization(grayA, w, h);

      return {
        elaMean: elaMeanRaw / 255,
        elaStd: stdDev / 255,
        elaUniformity: uniformity,
        elaSynthetic,
        textureRepeatScore,
        textureSynthetic,
        frequencySynthetic,
        freqPeakiness,
        freqRadialVar,
        edgeSharpnessMean,
        edgesSmoothedSynthetic,
        vectorGraphicLike,
        paletteScore: colorKeys.size,
        localElaCv,
        localElaPeakRatio,
        localEditLikely,
        noiseMean,
        noiseUniformity,
        lightingInconsistencyScore,
        edgePerfectionScore,
        renderSignatureScore,
        roiFaceScore,
        roiPerfectPts,
        roiNoiseMismatchPts,
        roiNoiseFace,
        roiNoiseBg,
        roiEdgeFace,
        roiEdgeBg,
        prnuResidualRisk0to100: prnuRes.risk0to100,
        prnuResidualMetrics: prnuRes.metrics,
        prnuResidualNotes: prnuRes.notes,
        dctDoubleQuantRisk0to100: dctRes.risk0to100,
        dctDoubleQuantMetrics: dctRes.metrics,
        dctDoubleQuantNotes: dctRes.notes
      };
    } finally {
      URL.revokeObjectURL(objUrl);
    }
  }

  function sampleVideoLowLevelForensic(video: HTMLVideoElement | null) {
    if (!video || typeof document === 'undefined') return null;
    const nw = video.videoWidth;
    const nh = video.videoHeight;
    if (!nw || !nh) return null;
    const maxDim = 440;
    const scale = Math.min(1, maxDim / Math.max(nw, nh));
    const w = Math.max(96, Math.floor(nw * scale));
    const h = Math.max(96, Math.floor(nh * scale));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    try {
      ctx.drawImage(video, 0, 0, w, h);
    } catch {
      return null;
    }
    const img = ctx.getImageData(0, 0, w, h);
    const grayA = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const j = i * 4;
      grayA[i] = (0.299 * img.data[j] + 0.587 * img.data[j + 1] + 0.114 * img.data[j + 2]) / 255;
    }
    const prnuRes = analyzePrnuResidualProxy(grayA, w, h);
    const dctRes = analyzeDctDoubleQuantization(grayA, w, h);
    return {
      prnuResidualRisk0to100: prnuRes.risk0to100,
      prnuResidualMetrics: prnuRes.metrics,
      prnuResidualNotes: prnuRes.notes,
      dctDoubleQuantRisk0to100: dctRes.risk0to100,
      dctDoubleQuantMetrics: dctRes.metrics,
      dctDoubleQuantNotes: dctRes.notes
    };
  }

  function normalizeTextForConnectors(input: string) {
    return input
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/[“”"']/g, '')
      .trim();
  }

  function countRegexOccurrences(text: string, rx: RegExp) {
    let m: RegExpExecArray | null = null;
    let c = 0;
    // eslint-disable-next-line no-cond-assign
    while ((m = rx.exec(text))) {
      c++;
      if (rx.lastIndex === m.index) rx.lastIndex++;
    }
    return c;
  }

  async function analyzeTextLLM(text: string) {
    const raw = text ?? '';
    const clean = normalizeTextForConnectors(raw);
    const empty = clean.length < 20;
    const sentenceLens = (clean.match(/[^.!?]+[.!?]?/g) ?? [])
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.split(/\s+/).filter(Boolean).length)
      .filter((n) => n > 0);
    const sentCount = sentenceLens.length;
    const sentMean = sentCount ? sentenceLens.reduce((a, b) => a + b, 0) / sentCount : 0;
    const sentVar =
      sentCount > 1
        ? sentenceLens.reduce((acc, x) => acc + (x - sentMean) * (x - sentMean), 0) / (sentCount - 1)
        : 0;
    const sentStd = Math.sqrt(Math.max(0, sentVar));
    const sentenceLenCv = sentMean > 0 ? sentStd / sentMean : 0;

    if (empty) {
      return {
        connectorScore: 0,
        topConnectors: [] as string[],
        llmPattern: false,
        sentenceLenCv,
        sentCount
      };
    }

    // Conectores lógicos típicos (con variantes sin acentos)
    const connectorCatalog: { label: string; variants: string[] }[] = [
      { label: 'En conclusión', variants: ['en conclusión', 'en conclusion'] },
      { label: 'Por otro lado', variants: ['por otro lado'] },
      { label: 'Es importante destacar', variants: ['es importante destacar', 'importante destacar'] },
      { label: 'Por consiguiente', variants: ['por consiguiente'] },
      { label: 'En primer lugar', variants: ['en primer lugar'] },
      { label: 'En segundo lugar', variants: ['en segundo lugar'] },
      { label: 'Por último', variants: ['por último', 'por ultimo'] },
      { label: 'Además', variants: ['ademas', 'además'] },
      { label: 'Asimismo', variants: ['asimismo'] },
      { label: 'Del mismo modo', variants: ['del mismo modo'] }
    ];

    const sentenceCount = Math.max(1, clean.split(/[.!?]+/).filter((s) => s.trim().length).length);

    const counts = new Map<string, number>();
    for (const c of connectorCatalog) counts.set(c.label, 0);

    for (const c of connectorCatalog) {
      for (const v of c.variants) {
        const esc = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
        const rx = new RegExp(`${esc}`, 'gi');
        const add = countRegexOccurrences(clean, rx);
        if (add) counts.set(c.label, (counts.get(c.label) ?? 0) + add);
      }
    }

    const entries = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const uniqueHits = entries.filter(([, v]) => v > 0).length;
    const totalHits = entries.reduce((acc, [, v]) => acc + v, 0);
    const maxHit = entries[0]?.[1] ?? 0;

    const connectorPerSentence = totalHits / sentenceCount;
    const uniqueRatio = uniqueHits / connectorCatalog.length;
    const repetitionBoost = maxHit >= 3 ? 1 : maxHit === 2 ? 0.5 : 0;

    // Score 0..~1.5 (proxy)
    const connectorScore = Math.max(0, Math.min(1.6, connectorPerSentence * 10 * (0.4 + uniqueRatio) + repetitionBoost * 0.25));

    const topConnectors = entries
      .filter(([, v]) => v > 0)
      .slice(0, 6)
      .map(([k, v]) => `${k}(${v})`);

    // Heurística: LLM suele usar conectores con frecuencia y diversidad.
    const llmPattern = connectorScore > 0.9 || (totalHits >= 6 && uniqueHits >= 3) || (maxHit >= 4);

    return { connectorScore, topConnectors, llmPattern, sentenceLenCv, sentCount };
  }

  function getVideoToCanvasTransform() {
    const preview = videoRef ?? imageRef;
    if (!preview || !canvasRef) return null;
    const vw = 'videoWidth' in preview ? preview.videoWidth || 0 : preview.naturalWidth || 0;
    const vh = 'videoHeight' in preview ? preview.videoHeight || 0 : preview.naturalHeight || 0;
    const cw = canvasRef.width || 0;
    const ch = canvasRef.height || 0;
    if (!vw || !vh || !cw || !ch) return null;

    // CSS: object-fit: cover (ver en estilos del componente)
    const scale = Math.max(cw / vw, ch / vh);
    const displayedW = vw * scale;
    const displayedH = vh * scale;
    const offsetX = (cw - displayedW) / 2;
    const offsetY = (ch - displayedH) / 2;

    return { scale, offsetX, offsetY };
  }

  function clamp(n: number, min: number, max: number) {
    return Math.max(min, Math.min(max, n));
  }

  function sobelFaceStatsAndMag2(
    imageData: ImageData,
    topBandFrac: number,
    bottomBandFrac: number
  ) {
    const { data, width: w, height: h } = imageData;
    const gray = new Float32Array(w * h);

    // Grayscale
    for (let i = 0; i < w * h; i++) {
      const r = data[i * 4 + 0];
      const g = data[i * 4 + 1];
      const b = data[i * 4 + 2];
      gray[i] = r * 0.299 + g * 0.587 + b * 0.114;
    }

    const mag2 = new Float32Array(w * h);
    let maxMag2 = 0;

    const topBand = Math.floor(h * topBandFrac);
    const bottomBandStart = Math.floor(h * (1 - bottomBandFrac));

    let bSum = 0;
    let bSumSq = 0;
    let bCount = 0;

    let iSum = 0;
    let iSumSq = 0;
    let iCount = 0;

    const idx = (x: number, y: number) => y * w + x;

    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const tl = gray[idx(x - 1, y - 1)];
        const tc = gray[idx(x, y - 1)];
        const tr = gray[idx(x + 1, y - 1)];

        const ml = gray[idx(x - 1, y)];
        const mr = gray[idx(x + 1, y)];

        const bl = gray[idx(x - 1, y + 1)];
        const bc = gray[idx(x, y + 1)];
        const br = gray[idx(x + 1, y + 1)];

        const gx = -tl + tr - 2 * ml + 2 * mr - bl + br;
        const gy = tl + 2 * tc + tr - bl - 2 * bc - br;

        const m2 = gx * gx + gy * gy;
        mag2[idx(x, y)] = m2;
        if (m2 > maxMag2) maxMag2 = m2;

        const isBoundary = y < topBand || y >= bottomBandStart;
        if (isBoundary) {
          bSum += m2;
          bSumSq += m2 * m2;
          bCount += 1;
        } else {
          iSum += m2;
          iSumSq += m2 * m2;
          iCount += 1;
        }
      }
    }

    const bMean = bCount ? bSum / bCount : 0;
    const iMean = iCount ? iSum / iCount : 0;

    const bVar = bCount ? bSumSq / bCount - bMean * bMean : 0;
    const iVar = iCount ? iSumSq / iCount - iMean * iMean : 0;

    return {
      mag2,
      maxMag2,
      boundaryMean: bMean,
      interiorMean: iMean,
      boundaryStd: Math.sqrt(Math.max(0, bVar)),
      interiorStd: Math.sqrt(Math.max(0, iVar))
    };
  }

  function sobelStatsOnly(imageData: ImageData) {
    const { data, width: w, height: h } = imageData;
    const gray = new Float32Array(w * h);

    for (let i = 0; i < w * h; i++) {
      const r = data[i * 4 + 0];
      const g = data[i * 4 + 1];
      const b = data[i * 4 + 2];
      gray[i] = r * 0.299 + g * 0.587 + b * 0.114;
    }

    const idx = (x: number, y: number) => y * w + x;

    let sum = 0;
    let sumSq = 0;
    let count = 0;
    let maxMag2 = 0;

    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const tl = gray[idx(x - 1, y - 1)];
        const tc = gray[idx(x, y - 1)];
        const tr = gray[idx(x + 1, y - 1)];

        const ml = gray[idx(x - 1, y)];
        const mr = gray[idx(x + 1, y)];

        const bl = gray[idx(x - 1, y + 1)];
        const bc = gray[idx(x, y + 1)];
        const br = gray[idx(x + 1, y + 1)];

        const gx = -tl + tr - 2 * ml + 2 * mr - bl + br;
        const gy = tl + 2 * tc + tr - bl - 2 * bc - br;

        const m2 = gx * gx + gy * gy;
        if (m2 > maxMag2) maxMag2 = m2;

        sum += m2;
        sumSq += m2 * m2;
        count += 1;
      }
    }

    const mean = count ? sum / count : 0;
    const var_ = count ? sumSq / count - mean * mean : 0;

    return {
      mean,
      std: Math.sqrt(Math.max(0, var_)),
      maxMag2
    };
  }

  function analyzeMaskEdgesAndHalo(video: HTMLVideoElement, pts: { x: number; y: number }[]) {
    if (!pts.length) return { halo: false, score: 0, boundaryMean: 0, neckMean: 0 };
    const vw = video.videoWidth || 0;
    const vh = video.videoHeight || 0;
    if (!vw || !vh) return { halo: false, score: 0, boundaryMean: 0, neckMean: 0 };

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of pts) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }

    const faceW = Math.max(30, maxX - minX);
    const faceH = Math.max(30, maxY - minY);
    const padX = faceW * 0.12;
    const padY = faceH * 0.12;

    const roiX = clamp(minX - padX, 0, vw - 1);
    const roiY = clamp(minY - padY, 0, vh - 1);
    const roiW = clamp(faceW + padX * 2, 30, vw - roiX);
    const roiH = clamp(faceH + padY * 2, 30, vh - roiY);

    const neckX = roiX;
    const neckW = roiW;
    const neckY = clamp(roiY + roiH * 0.86, 0, vh - 1);
    const neckH = clamp(roiH * 0.45, 18, vh - neckY);

    // Tamaño reducido para CPU razonable
    const targetW = clamp(Math.floor(roiW * 0.85), 96, 160);
    const targetH = clamp(Math.floor((roiH / roiW) * targetW), 72, 140);

    const neckTargetW = targetW;
    const neckTargetH = clamp(Math.floor((neckH / neckW) * neckTargetW), 56, 120);

    const edgeCanvas =
      edgeOverlayCanvas ?? (typeof document !== 'undefined' ? document.createElement('canvas') : null);
    if (!edgeCanvas) return { halo: false, score: 0, boundaryMean: 0, neckMean: 0 };

    // Face ROI
    edgeCanvas.width = targetW;
    edgeCanvas.height = targetH;
    const edgeCtx = edgeCanvas.getContext('2d', { willReadFrequently: true });
    if (!edgeCtx) return { halo: false, score: 0, boundaryMean: 0, neckMean: 0 };
    edgeCtx.clearRect(0, 0, targetW, targetH);
    edgeCtx.drawImage(video, roiX, roiY, roiW, roiH, 0, 0, targetW, targetH);
    const faceImg = edgeCtx.getImageData(0, 0, targetW, targetH);

    const faceStats = sobelFaceStatsAndMag2(faceImg, 0.22, 0.18);

    // Neck ROI (stats only)
    const neckCanvas =
      neckEdgeCanvas ?? (typeof document !== 'undefined' ? document.createElement('canvas') : null);
    if (!neckCanvas) {
      return { halo: false, score: 0, boundaryMean: faceStats.boundaryMean, neckMean: 0 };
    }
    neckEdgeCanvas = neckCanvas;
    neckCanvas.width = neckTargetW;
    neckCanvas.height = neckTargetH;
    const neckCtx = neckCanvas.getContext('2d', { willReadFrequently: true });
    if (!neckCtx) {
      return { halo: false, score: 0, boundaryMean: faceStats.boundaryMean, neckMean: 0 };
    }
    neckCtx.drawImage(video, neckX, neckY, neckW, neckH, 0, 0, neckTargetW, neckTargetH);
    const neckImg = neckCtx.getImageData(0, 0, neckTargetW, neckTargetH);
    const neckStats = sobelStatsOnly(neckImg);

    const eps = 1e-6;
    const ratioFaceInterior = faceStats.boundaryMean / (faceStats.interiorMean + eps);
    const ratioFaceNeck = faceStats.boundaryMean / (neckStats.mean + eps);
    const ratioStd = faceStats.boundaryStd / (neckStats.std + eps);

    const halo =
      ratioFaceInterior > 1.45 &&
      ratioFaceNeck > 1.7 &&
      ratioStd > 1.15 &&
      faceStats.boundaryMean > 15;

    const score = ratioFaceNeck + ratioStd + ratioFaceInterior;

    // Visualización del filtro de bordes
    const ctx = edgeCanvas.getContext('2d');
    if (ctx) {
      const img = ctx.createImageData(targetW, targetH);
      const baseGold = { r: 212, g: 175, b: 55 };
      const baseRed = { r: 230, g: 57, b: 70 };
      const base = halo ? baseRed : baseGold;

      const max = faceStats.maxMag2 + eps;
      for (let i = 0; i < targetW * targetH; i++) {
        const y = Math.floor(i / targetW);
        const isBoundary = y < Math.floor(targetH * 0.22) || y >= Math.floor(targetH * (1 - 0.18));

        const v = faceStats.mag2[i] / max; // 0..1 aprox.
        const intensity = isBoundary ? Math.min(1, v * 1.2) : Math.min(1, v * 0.35);
        const a = Math.floor(20 + intensity * 210 * (isBoundary ? 1 : 0.6));
        img.data[i * 4 + 0] = Math.floor(base.r * intensity);
        img.data[i * 4 + 1] = Math.floor(base.g * intensity);
        img.data[i * 4 + 2] = Math.floor(base.b * intensity);
        img.data[i * 4 + 3] = clamp(a, 0, 255);
      }
      ctx.putImageData(img, 0, 0);
    }

    edgeOverlayCanvas = edgeCanvas;
    edgeOverlayRect = { x: roiX, y: roiY, w: roiW, h: roiH };
    lastMaskJitterScore = score;

    return {
      halo,
      score,
      boundaryMean: faceStats.boundaryMean,
      neckMean: neckStats.mean
    };
  }

  async function analyzeFramesReal() {
    if (!videoRef)
      return {
        suspicious: true,
        minScore: 0,
        maxJitter: 0,
        suspiciousLowConfidence: true,
        suspiciousJitter: false,
        blinkWarning: false,
        blinkCount: 0,
        maskJitterWarning: false,
        maskJitterMaxScore: 0,
        rppgGreenSamples: [] as number[],
        rppgSampleRateHz: 0
      };

    // Ajustes de rendimiento:
    // - Para clips cortos, reducimos inputSize + muestreamos más rápido para que el análisis termine pronto.
    const duration = Number.isFinite(videoRef.duration) ? Math.max(0, videoRef.duration) : 0;
    const isShortClip = duration > 0 && duration <= 8;
    const options = new faceapi.TinyFaceDetectorOptions({
      inputSize: isShortClip ? 160 : 224,
      scoreThreshold: 0.2
    });

    const start = performance.now();
    let prevPoints: { x: number; y: number }[] | null = null;
    let minScore = 1;
    let maxJitter = 0;
    let suspiciousLowConfidence = false;
    let suspiciousJitter = false;
    let blinkCount = 0;
    let blinkWarning = false;
    let blinkStartTs: number | null = null;
    let blinkMinEar = 1;
    const blinkDurationsMs: number[] = [];
    const blinkDepths: number[] = [];
    let reliableFaceFrames = 0;
    let lastReliableFaceMs = 0;

    let maskJitterWarning = false;
    let maskJitterMaxScore = 0;

    lastLandmarks = null;
    jitterSeries = [];
    scoreSeries = [];
    lastFrameScore = 0;
    lastFrameJitter = 0;
    edgeOverlayRect = null;
    lastMaskJitterScore = 0;
    lastLandmarks = null;
    jitterSeries = [];
    scoreSeries = [];
    lastFrameScore = 0;
    lastFrameJitter = 0;

    // Reproducimos en client-side para analizar una ventana sin seeks costosos.
    // Importante: para videos cortos analizamos su duración real y aceleramos el pipeline.
    const windowSeconds = duration > 0 ? Math.min(20, duration) : 20;
    const windowMs = Math.max(800, windowSeconds * 1000);
    const maxWallMs = isShortClip ? 20000 : 45000;
    const sampleDelayMs = isShortClip ? 120 : 220; // muestreo temporal (EAR/jitter/bordes)

    let detectCount = 0;
    let roiPerfectPts = 0;
    let roiNoiseMismatchPts = 0;
    let roiNoiseFace = 0;
    let roiNoiseBg = 0;
    let roiEdgeFace = 0;
    let roiEdgeBg = 0;

    // Importante: NO basamos progreso en currentTime (si hay loop, vuelve a 0 y "reinicia" la UI).
    // Usamos reloj monótono para que telemetría/barra nunca retrocedan ni repitan logs.
    let analyzedMs = 0;
    let lastStepTs = performance.now();
    let uiMillis = 0;
    let uiProgress = 15;
    try {
      videoRef.muted = true;
      videoRef.loop = true;
      (videoRef as HTMLVideoElement & { playsInline?: boolean }).playsInline = true;
      // Reinicia desde el inicio para cubrir consistentemente los primeros 20s.
      videoRef.currentTime = 0;
      await seekTo(videoRef, 0);
      await videoRef.play();
    } catch {
      suspiciousLowConfidence = true;
    }

    const rppgSampleMs = 70;
    const rppgGreenSamples: number[] = [];
    const rppgGate: {
      ok: boolean;
      box: { x: number; y: number; width: number; height: number } | null;
    } = { ok: false, box: null };
    let rppgTimer: ReturnType<typeof setInterval> | null = null;
    const rppgCanvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
    const rppgCtx2d = rppgCanvas?.getContext?.('2d', { willReadFrequently: true }) ?? null;
    if (rppgCanvas && rppgCtx2d && videoRef) {
      rppgTimer = setInterval(() => {
        try {
          if (!rppgGate.ok || !rppgGate.box || !videoRef) return;
          const vw = videoRef.videoWidth;
          const vh = videoRef.videoHeight;
          if (!vw || !vh) return;
          const tw = 160;
          const th = Math.max(90, Math.round((vh / vw) * tw));
          rppgCanvas.width = tw;
          rppgCanvas.height = th;
          rppgCtx2d.drawImage(videoRef, 0, 0, tw, th);
          const sx = tw / vw;
          const sy = th / vh;
          const b = rppgGate.box;
          const mapped = { x: b.x * sx, y: b.y * sy, width: b.width * sx, height: b.height * sy };
          const img = rppgCtx2d.getImageData(0, 0, tw, th);
          rppgGreenSamples.push(meanGreenCheekRoi(img, mapped));
        } catch {
          /* ignore */
        }
      }, rppgSampleMs);
    }

    try {
    while (analyzedMs < windowMs && performance.now() - start < maxWallMs) {
      const now = performance.now();
      const dt = Math.max(0, Math.min(400, now - lastStepTs));
      lastStepTs = now;
      analyzedMs = Math.min(windowMs, analyzedMs + dt);

      const progress = Math.min(98, 15 + (analyzedMs / windowMs) * 83);
      uiMillis = Math.max(uiMillis, Math.floor(analyzedMs));
      uiProgress = Math.max(uiProgress, progress);
      tickScan(uiMillis, uiProgress);

      const result = await faceapi
        .detectSingleFace(videoRef, options)
        .withFaceLandmarks(true);
      detectCount += 1;

      if (!result) {
        rppgGate.ok = false;
        suspiciousLowConfidence = true;
        minScore = Math.min(minScore, 0);
        lastFrameScore = 0;
        lastFrameJitter = 0;
        scoreSeries = pushSeries(scoreSeries, 0);
        jitterSeries = pushSeries(jitterSeries, 0);
      } else {
        const score = result.detection.score ?? 0;
        minScore = Math.min(minScore, score);
        // Más conservador: si cae por debajo del 90% en cualquier frame, marcamos sospecha.
        if (score < 0.9) suspiciousLowConfidence = true;
        lastFrameScore = score;
        scoreSeries = pushSeries(scoreSeries, score);

        const box = result.detection.box;
        const norm = Math.max(80, box.width);
        const pts = result.landmarks.positions.map((p) => ({ x: p.x, y: p.y }));

        // Fiabilidad de cara (anti-falsos positivos en vídeos sin cara humana clara).
        const vw = videoRef.videoWidth || 0;
        const vh = videoRef.videoHeight || 0;
        const faceLargeEnough = vw ? box.width >= vw * 0.12 : box.width >= 90;
        const reliableFace = score >= 0.9 && faceLargeEnough;
        if (reliableFace && vw && vh) {
          rppgGate.ok = true;
          rppgGate.box = { x: box.x, y: box.y, width: box.width, height: box.height };
        } else {
          rppgGate.ok = false;
        }
        if (reliableFace) {
          reliableFaceFrames += 1;
          lastReliableFaceMs = analyzedMs;
        } else {
          // Evita “inventar” cierres/aberturas cuando el tracking es inestable.
          blinkStartTs = null;
          blinkMinEar = 1;
        }

        // ROI contraste de textura (cara vs fondo). Seguridad: solo si face-api está >= 90%.
        if (reliableFace && detectCount % 3 === 0) {
          if (vw && vh) {
            const tmpCanvas =
              roiTmpCanvas ?? (typeof document !== 'undefined' ? document.createElement('canvas') : null);
            if (tmpCanvas) {
              roiTmpCanvas = tmpCanvas;
              const targetW = 176;
              const targetH = Math.max(96, Math.floor((vh / vw) * targetW));
              tmpCanvas.width = targetW;
              tmpCanvas.height = targetH;
              const ctx = tmpCanvas.getContext('2d', { willReadFrequently: true });
              if (ctx) {
                ctx.drawImage(videoRef, 0, 0, targetW, targetH);
                const img = ctx.getImageData(0, 0, targetW, targetH);
                const gray = new Float32Array(targetW * targetH);
                for (let i = 0; i < targetW * targetH; i++) {
                  const r = img.data[i * 4 + 0];
                  const g = img.data[i * 4 + 1];
                  const b = img.data[i * 4 + 2];
                  gray[i] = r * 0.299 + g * 0.587 + b * 0.114;
                }

                const sx = targetW / vw;
                const sy = targetH / vh;
                const mapped = {
                  x: box.x * sx,
                  y: box.y * sy,
                  width: box.width * sx,
                  height: box.height * sy
                };
                const roiRes = roiTextureContrastPointsFromGray(gray, targetW, targetH, mapped);
                roiPerfectPts = Math.max(roiPerfectPts, roiRes.pts40);
                roiNoiseMismatchPts = Math.max(roiNoiseMismatchPts, roiRes.pts20);
                roiNoiseFace = roiRes.roiNoise;
                roiNoiseBg = roiRes.bgNoise;
                roiEdgeFace = roiRes.roiEdge;
                roiEdgeBg = roiRes.bgEdge;
              }
            }
          }
        }

        // Blink detection (EAR)
        if (reliableFace) {
          const leftEar = earForEye(pts, 36);
          const rightEar = earForEye(pts, 42);
          const ear = (leftEar + rightEar) / 2;
          const blinkClosedThreshold = 0.21;
          const blinkOpenThreshold = 0.25;

          if (ear > 0 && ear < blinkClosedThreshold) {
            if (blinkStartTs === null) blinkStartTs = performance.now();
            blinkMinEar = Math.min(blinkMinEar, ear);
          } else if (blinkStartTs !== null && ear > blinkOpenThreshold) {
            const dur = performance.now() - blinkStartTs;
            // filtros para evitar falsos positivos
            if (dur >= 60 && dur <= 800) {
              blinkCount += 1;
              blinkDurationsMs.push(dur);
              blinkDepths.push(1 - Math.max(0, Math.min(1, blinkMinEar)));
            }
            blinkStartTs = null;
            blinkMinEar = 1;
          }
        }

        if (prevPoints) {
          const jitter = meanLandmarkJitter(prevPoints, pts, norm);
          maxJitter = Math.max(maxJitter, jitter);
          // Más conservador para deepfakes "limpios"
          if (jitter > 0.02) suspiciousJitter = true;
          lastFrameJitter = jitter;
          jitterSeries = pushSeries(jitterSeries, jitter);
        } else {
          lastFrameJitter = 0;
          jitterSeries = pushSeries(jitterSeries, 0);
        }

        // Mask Jitter (bordes/halo entre cara y cuello)
        if (detectCount % 2 === 0) {
          const edgeRes = analyzeMaskEdgesAndHalo(videoRef, pts);
          if (edgeRes.halo) {
            maskJitterWarning = true;
            maskJitterMaxScore = Math.max(maskJitterMaxScore, edgeRes.score);
          }
        }

        prevPoints = pts;
        lastLandmarks = pts;
      }

      // Actualización en “tiempo real” (provisional) de Score/Confianza mientras analizamos.
      // Nota: el veredicto final sigue resolviéndose al terminar el pipeline.
      const liveBlinkPts = reliableFaceFrames >= 12 && analyzedMs > 10000 && blinkCount === 0 ? 30 : 0;
      const liveScore = clamp(roiPerfectPts + roiNoiseMismatchPts + liveBlinkPts, 0, 100);
      setScores({ riskScore: liveScore, confidence: confidenceFromScore(liveScore) });

      await new Promise<void>((resolve) => setTimeout(resolve, sampleDelayMs));
    }
    } finally {
      if (rppgTimer) clearInterval(rppgTimer);
    }

    try {
      videoRef.pause();
    } catch {
      // ignore
    }

    // Blink warnings:
    // - No blink in 20s
    // - Mechanically identical blink (muy baja variación)
    const hasEnoughReliableFace = reliableFaceFrames >= 12 && lastReliableFaceMs >= Math.min(windowMs, 9000);
    if (hasEnoughReliableFace && blinkCount === 0) {
      blinkWarning = true;
    } else if (hasEnoughReliableFace && blinkCount >= 3) {
      const durMean = mean(blinkDurationsMs);
      const durStd = std(blinkDurationsMs);
      const depthMean = mean(blinkDepths);
      const depthStd = std(blinkDepths);
      const durCv = durMean ? durStd / durMean : 0;
      const depthCv = depthMean ? depthStd / depthMean : 0;
      if (durCv < 0.08 && depthCv < 0.12) {
        blinkWarning = true;
      }
    }

    const rppgSampleRateHz = 1000 / rppgSampleMs;
    return {
      suspicious: suspiciousLowConfidence || suspiciousJitter,
      suspiciousLowConfidence,
      suspiciousJitter,
      minScore,
      maxJitter,
      blinkWarning,
      blinkCount,
      maskJitterWarning,
      maskJitterMaxScore,
      roiPerfectPts,
      roiNoiseMismatchPts,
      roiNoiseFace,
      roiNoiseBg,
      roiEdgeFace,
      roiEdgeBg,
      reliableFaceFrames,
      rppgGreenSamples,
      rppgSampleRateHz
    };
  }

  function onDragOver(event: DragEvent) {
    event.preventDefault();
    isDragActive = true;
  }

  function onDragLeave(event: DragEvent) {
    event.preventDefault();
    isDragActive = false;
  }

  async function onDrop(event: DragEvent) {
    event.preventDefault();
    isDragActive = false;

    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    await loadFile(file);
  }

  async function onFileInput(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    await loadFile(file);
  }

  async function onLinkFileInput(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    // En modo enlace, el usuario aporta el archivo: auto-enrutamos a la pestaña correcta.
    const name = file.name.toLowerCase();
    const isImage =
      file.type?.startsWith('image/') ||
      /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(name);
    const isVideo =
      file.type?.startsWith('video/') || /\.(mp4|webm|mov|mkv|avi|m4v|3gp)$/i.test(name);
    const isAudio =
      file.type?.startsWith('audio/') || /\.(mp3|wav|m4a|aac|ogg|opus|flac)$/i.test(name);

    if (isImage) activeTab = 'image';
    else if (isVideo) activeTab = 'video';
    else if (isAudio) activeTab = 'audio';
    else return;

    await loadFile(file);
  }

  async function runTextAnalysis() {
    if (isBusy) return;
    const text = textInput?.trim() ?? '';
    if (!text) return;

    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }

    // Texto se trata como "evidencia" serializada en un File temporal
    const file = new File([text], 'texto.txt', { type: 'text/plain' });
    selectedFile = file;
    mediaKind = 'text';
    textPreview = text.length > 420 ? `${text.slice(0, 420)}...` : text;

    showReport = false;
    resetScanner();
    fileHashHex = '';
    elaOverlayCanvas = null;
    edgeOverlayCanvas = null;
    neckEdgeCanvas = null;
    roiTmpCanvas = null;
    edgeOverlayRect = null;
    lastMaskJitterScore = 0;

    imageElaMean = 0;
    imageElaUniformity = 0;
    imageTextureRepeatScore = 0;
    imageFreqPeakiness = 0;
    imageFreqRadialVar = 0;
    imageEdgeSharpness = 0;
    imageNoiseMean = 0;
    imageNoiseUniformity = 0;
    imageLightingInconsistency = 0;
    imageEdgePerfection = 0;
    imageRenderSignature = 0;
    imageRoiFaceScore = 0;
    imageRoiPerfectPts = 0;
    imageRoiNoiseMismatchPts = 0;
    imageLocalElaCv = 0;
    imageLocalElaPeakRatio = 0;
    imageLocalEditLikely = false;
    imageVectorGraphicLike = false;
    imageElaSynthetic = false;
    imageFrequencySynthetic = false;
    imageTextureSynthetic = false;
    imageEdgesSmoothedSynthetic = false;
    imageNoiseMean = 0;
    imageNoiseUniformity = 0;
    imageLightingInconsistency = 0;
    imageEdgePerfection = 0;
    imageRenderSignature = 0;

    textConnectorScore = 0;
    textTopConnectors = [];

    isBusy = true;
    try {
      const premiumStart = performance.now();
      beginScanKind(file, 'text');

      try {
        fileHashHex = await sha256Hex(file);
      } catch {
        fileHashHex = '';
      }

      setAnalyzing();
      const steps = 12;
      for (let i = 0; i < steps; i++) {
        const progress = Math.min(98, 15 + (i / (steps - 1)) * 83);
        tickScan(i * 240, progress);
        await new Promise((r) => setTimeout(r, 90));
      }

      const result = await analyzeTextLLM(text);

      textConnectorScore = result.connectorScore;
      textTopConnectors = result.topConnectors;

      const hardAlert = file.size > MAX_SCAN_SIZE_BYTES;
      // Ensemble (0..100)
      let lingScore = 0;
      if ((result as any).sentCount >= 4 && (result as any).sentenceLenCv < 0.12) lingScore += 40;
      if (result.llmPattern) lingScore += 25;
      lingScore = Math.max(0, Math.min(100, lingScore));

      const ens = ensemble.evaluate({
        kind: 'text',
        linguistic: { score0to100: lingScore }
      });
      const score = Math.round(ens.finalFakeScore0to100);

      let verdict: 'VERIFICADO' | 'SOSPECHOSO' | 'ALERTA ROJA' = verdictFromScore(score);
      if (hardAlert) verdict = 'ALERTA ROJA';

      const confidence = confidenceFromScore(score);
      const riskScore = score;
      const warnings: string[] = [];
      if (result.llmPattern) warnings.push('Patrón de Conectores Lógicos Repetitivos (LLM)');
      if ((result as any).sentCount >= 4 && (result as any).sentenceLenCv < 0.12) warnings.push('Varianza de longitud de frases inusualmente baja (proxy)');

      const reason =
        verdict === 'ALERTA ROJA'
          ? 'El tamaño del texto supera el límite seguro de 150MB y requiere validación manual.'
          : verdict === 'SOSPECHOSO'
            ? 'Repetición y estereotipia de conectores lógicos compatibles con redacción de modelo de lenguaje.'
            : 'La estructura discursiva no muestra patrones dominantes de conectores repetitivos.';

      // Premium: mantenemos ANALYZING hasta el final visual
      await ensureMinimumPremiumTime(premiumStart, 15000, 35, 96);
      completeScan({
        verdict,
        confidence,
        riskScore,
        reason,
        warnings,
        ensembleVotes: toEnsembleVotesExport(ens.votes),
        logsExtra: [
          ...formatEnsembleVotes(ens.votes).map((s) => `ENSEMBLE_VOTE: ${s}`),
          `TEXT_CONNECTOR_SCORE: ${result.connectorScore.toFixed(4)}`,
          `TEXT_TOP_CONNECTORS: ${(result.topConnectors ?? []).slice(0, 3).join(' | ') || 'NONE'}`,
          `TEXT_SENTENCE_LEN_CV: ${Number((result as any).sentenceLenCv ?? 0).toFixed(3)}`,
          `TEXT_SENT_COUNT: ${Number((result as any).sentCount ?? 0)}`
        ]
      });
      await new Promise((r) => setTimeout(r, 180));
      if (!isAutomationRun()) showReport = true;
    } catch (err) {
      const hardAlert = file.size > MAX_SCAN_SIZE_BYTES || NOMINAL_MANIPULATION_FILE_RE.test(file.name);
      const verdict: 'VERIFICADO' | 'SOSPECHOSO' | 'ALERTA ROJA' = hardAlert ? 'ALERTA ROJA' : 'SOSPECHOSO';

      const premiumStartFail = performance.now();
      await ensureMinimumPremiumTime(premiumStartFail, 15000, 40, 96);
      completeScan({
        verdict,
        confidence: hardAlert ? 62 : 50,
        riskScore: hardAlert ? 92 : 58,
        reason: 'No se pudo completar la Auditoría de Integridad en el navegador (error general).',
        warnings: ['Auditoría no completada en cliente. Revisa consola para el detalle técnico.'],
        logsExtra: [`VIDEO_TEXT_IMAGE_ERROR: ${String((err as any)?.message ?? err)}`]
      });
      await new Promise((r) => setTimeout(r, 180));
      if (!isAutomationRun()) showReport = true;
    } finally {
      isBusy = false;
    }
  }

  async function loadFile(file: File) {
    const name = file.name.toLowerCase();
    const isImage =
      file.type?.startsWith('image/') ||
      /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(name);
    const isVideo =
      file.type?.startsWith('video/') || /\.(mp4|webm|mov|mkv|avi|m4v|3gp)$/i.test(name);
    const isAudio =
      file.type?.startsWith('audio/') || /\.(mp3|wav|m4a|aac|ogg|opus|flac)$/i.test(name);

    if (!isImage && !isVideo && !isAudio) return;
    if (activeTab === 'video' && (isImage || isAudio)) return;
    if (activeTab === 'image' && (isVideo || isAudio)) return;
    if (activeTab === 'audio' && isImage) return;

    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }

    selectedFile = file;
    mediaKind = activeTab === 'audio' ? 'audio' : isImage ? 'image' : 'video';
    showReport = false;
    resetScanner();
    videoExportFeatures = null;
    imageLowLevelForensic = null;
    fileHashHex = '';
    elaOverlayCanvas = null;
    audioSummary = '';

    if (videoUrl) {
      URL.revokeObjectURL(videoUrl);
    }
    if (imageUrl) {
      URL.revokeObjectURL(imageUrl);
    }

    if (mediaKind === 'video') {
      videoUrl = URL.createObjectURL(file);
    } else if (mediaKind === 'image') {
      imageUrl = URL.createObjectURL(file);
    } else {
      // audio: sin preview de vídeo/imagen
      videoUrl = '';
      imageUrl = '';
    }
    isBusy = true;

    try {
      const premiumStart = performance.now();
      beginScanKind(file, mediaKind ?? 'unknown');
      // Desde aquí marcamos ANALYZING para que la Telemetría no se "quede congelada"
      // mientras se resuelven EXIF/MediaInfo/SHA/FS del lado cliente.
      setAnalyzing();
      tickScan(0, 15);
      startTelemetryHeartbeat();
      appendLog('AUDIT_PIPELINE_OFFTHREAD_INIT...');
      // Offload (Worker): SHA-256 + MediaInfo WASM para evitar bloqueos del hilo principal
      let workerMi: { thirdParty: boolean; encoderHints: string[] } = { thirdParty: false, encoderHints: [] };
      try {
        const workerAudit = await withTimeout(runWorkerAudit(file, true), 35000, 'WORKER_AUDIT');
        fileHashHex = workerAudit.hashHex;
        workerMi = workerAudit.mi;
      } catch (err) {
        fileHashHex = '';
        appendLog(`WORKER_AUDIT_FAILED: ${String((err as any)?.message ?? err)}`);
      }

      const camera = await readCameraMetadata(file);
      const warnings: string[] = [];
      if (!camera.combined || !isKnownCamera(camera.combined)) {
        warnings.push('Origen Digital No Verificado');
      }

      // MediaInfo (WASM): no debe bloquear toda la auditoría si falla.
      // Ya viene del worker. No hacemos fallback on-thread para evitar freezes.
      const mi: { thirdParty: boolean; encoderHints: string[] } = workerMi;
      if (!fileHashHex) warnings.push('Auditoría en segundo plano no disponible (hash)');
      if (!mi) warnings.push('Auditoría en segundo plano no disponible (MediaInfo)');
      if (mi.thirdParty) {
        warnings.push('Origen: Software de Terceros detected. Integridad de Cámara: Comprometida');
      }

      const missingMobile: string[] = [];
      if (!camera.make) missingMobile.push('Marca');
      if (!camera.model) missingMobile.push('Modelo');
      if (!camera.iso) missingMobile.push('ISO');
      if (!camera.fNumber) missingMobile.push('Apertura');
      if (missingMobile.length) {
        warnings.push(`Metadatos de Cámara Incompletos: ${missingMobile.join(', ')}`);
      }

      const hardAlert =
        file.size > MAX_SCAN_SIZE_BYTES ||
        NOMINAL_MANIPULATION_FILE_RE.test(file.name) ||
        ((mediaKind === 'video' || mediaKind === 'image') && KNOWN_AI_GENERATOR_EXPORT_FILE_RE.test(file.name));
      // Se detiene el "heartbeat" cuando entramos en la fase de análisis real.
      stopTelemetryHeartbeat();

      if (mediaKind === 'audio') {
        try {
          appendLog('AUDIO_DECODE_INIT...');

          // En pestaña AUDIO aceptamos audio/* o video/* (para extraer pista).
          const audioBuffer = await withTimeout(decodeAudioBufferFromFile(file), 20000, 'AUDIO_DECODE');
          appendLog('AUDIO_FEATURES_EXTRACT...');
          const res = analyzeAudioQuick(audioBuffer);

          audioDurationSec = res.durationSec;
          audioSampleRate = res.sampleRate;
          audioChannels = res.channels;
          audioClipRatio = res.clipRatio;
          audioBandlimitScore = res.bandlimitScore;
          audioEditCuts = res.editCuts;

          const warningsAudio: string[] = [...warnings];
          if (res.editCuts >= 2) warningsAudio.push('Posible edición por cortes (Audio Continuidad)');
          if (res.clipRatio > 0.01) warningsAudio.push('Clipping detectado (Audio Saturación)');
          if (res.bandlimitScore > 0.75) warningsAudio.push('Compresión o limitación de banda agresiva (Audio)');
          if (res.ttsLike) warningsAudio.push('Naturalidad acústica atípica (posible TTS)');
          if ((res as any).digitalSilenceGaps >= 2) warningsAudio.push('Silencio digital absoluto entre segmentos (proxy)');

          const hardAlert = file.size > MAX_SCAN_SIZE_BYTES || NOMINAL_MANIPULATION_FILE_RE.test(file.name);
          let acousticScore = 0;
          if ((res as any).digitalSilenceGaps >= 2) acousticScore += 40;
          if (res.sampleRate >= 44100 && res.bandlimitScore > 0.78) acousticScore += 30;
          if (res.editCuts >= 2) acousticScore += 20;
          if (res.ttsLike) acousticScore += 15;
          acousticScore = Math.max(0, Math.min(100, acousticScore));

          const ens = ensemble.evaluate({
            kind: 'audio',
            acoustic: { score0to100: acousticScore },
            metadata: {
              thirdParty: Boolean(mi?.thirdParty),
              originNoVerify: warnings.includes('Origen Digital No Verificado'),
              missingCameraMeta: missingMobile.length > 0
            }
          });
          const score = Math.round(ens.finalFakeScore0to100);

          let verdict: 'VERIFICADO' | 'SOSPECHOSO' | 'ALERTA ROJA' = verdictFromScore(score);
          if (hardAlert) verdict = 'ALERTA ROJA';

          const confidence = confidenceFromScore(score);
          const riskScore = score;

          audioSummary =
            (res as any).digitalSilenceGaps >= 2
              ? 'Se detectaron tramos de silencio digital absoluto incompatibles con captación natural.'
              : res.sampleRate >= 44100 && res.bandlimitScore > 0.78
                ? 'Se detectó ausencia atípica de altas frecuencias (>16kHz) compatible con síntesis/compresión agresiva.'
                : res.editCuts >= 2
                  ? `Se detectaron ${res.editCuts} discontinuidades compatibles con edición.`
                  : res.ttsLike
                    ? 'Se detectó naturalidad acústica atípica. Requiere verificación.'
                    : 'Continuidad acústica estable. Sin señales fuertes de edición.';

          const reason =
            verdict === 'ALERTA ROJA'
              ? file.size > MAX_SCAN_SIZE_BYTES
                ? 'El archivo supera el limite seguro de 150MB y requiere validacion manual.'
                : 'Patrón en el nombre del archivo sugiere contenido manipulado o sintético (marcador nominal).'
              : verdict === 'SOSPECHOSO'
                ? audioSummary
                : 'Integridad de audio estable. No se detectaron señales fuertes de manipulación.';

          // Premium: mantenemos ANALYZING hasta el final visual
          await ensureMinimumPremiumTime(premiumStart, 15000, 28, 96);
          completeScan({
            verdict,
            confidence,
            riskScore,
            reason,
            warnings: warningsAudio,
            ensembleVotes: toEnsembleVotesExport(ens.votes),
            logsExtra: [
              ...formatEnsembleVotes(ens.votes).map((s) => `ENSEMBLE_VOTE: ${s}`),
              `AUDIO_DURATION_SEC: ${res.durationSec.toFixed(2)}`,
              `AUDIO_SR: ${res.sampleRate}`,
              `AUDIO_CHANNELS: ${res.channels}`,
              `AUDIO_CLIP_RATIO: ${(res.clipRatio * 100).toFixed(2)}%`,
              `AUDIO_BANDLIMIT_SCORE: ${res.bandlimitScore.toFixed(3)}`,
              `AUDIO_EDIT_CUTS: ${res.editCuts}`,
              `AUDIO_CUT_TIMES: ${(res.cutTimes ?? []).map((t) => t.toFixed(2)).join(', ') || 'NONE'}`,
              `AUDIO_DIGITAL_SILENCE_GAPS: ${Number((res as any).digitalSilenceGaps ?? 0)}`
            ]
          });
          await new Promise((r) => setTimeout(r, 180));
          if (!isAutomationRun()) showReport = true;
        } catch (err) {
          const verdict: 'VERIFICADO' | 'SOSPECHOSO' | 'ALERTA ROJA' = hardAlert ? 'ALERTA ROJA' : 'SOSPECHOSO';
          await ensureMinimumPremiumTime(premiumStart, 15000, 30, 92);
          completeScan({
            verdict,
            confidence: hardAlert ? 62 : 50,
            riskScore: hardAlert ? 92 : 58,
            reason: 'No se pudo completar la Auditoría de Integridad de audio en el navegador.',
            warnings: [...warnings, 'Auditoría no completada en cliente (audio). Revisa consola o intenta otro archivo.'],
            logsExtra: [`AUDIO_ANALYSIS_ERROR: ${String((err as any)?.message ?? err)}`]
          });
          await new Promise((r) => setTimeout(r, 180));
          if (!isAutomationRun()) showReport = true;
        }
      } else if (mediaKind === 'video') {
        try {
          await withTimeout(ensureModelsLoaded(), 20000, 'FACE_MODELS');

          let containerPrecomputed: import('$lib/forensics/mp4BoxForensics').Mp4ForensicResult | null = null;
          const isMp4Container =
            /\.mp4$/i.test(file.name) ||
            (file.type || '').toLowerCase().includes('mp4') ||
            (file.type || '').toLowerCase().includes('quicktime');
          if (isMp4Container) {
            try {
              const head = await file.slice(0, Math.min(file.size, 2 * 1024 * 1024)).arrayBuffer();
              containerPrecomputed = scanMp4Container(head);
            } catch {
              containerPrecomputed = null;
            }
          }

          const frameResult = await withTimeout(analyzeFramesReal(), 70000, 'VIDEO_ANALYSIS');

          const rppgRate = Number((frameResult as any).rppgSampleRateHz ?? 1000 / 70);
          const rppgAnalysis = analyzeRppgGreenSeries(
            (frameResult as any).rppgGreenSamples ?? [],
            rppgRate
          );

          const videoLowLevel = sampleVideoLowLevelForensic(videoRef);

          videoExportFeatures = buildVideoFeaturesForExport(frameResult, {
            rppgPrecomputed: rppgAnalysis,
            containerPrecomputed,
            lowLevelForensic: videoLowLevel
          });

          const ens = ensemble.evaluate({
            kind: 'video',
            forensic: {
              roiPerfectPts: Number((frameResult as any).roiPerfectPts ?? 0),
              roiNoiseMismatchPts: Number((frameResult as any).roiNoiseMismatchPts ?? 0),
              roiNoiseFace: Number((frameResult as any).roiNoiseFace ?? 0),
              roiNoiseBg: Number((frameResult as any).roiNoiseBg ?? 0),
              roiEdgeFace: Number((frameResult as any).roiEdgeFace ?? 0),
              roiEdgeBg: Number((frameResult as any).roiEdgeBg ?? 0),
              videoPortraitSyntheticHint: Boolean(
                videoExportFeatures?.forensic?.videoPortraitSyntheticHint ?? false
              ),
              videoPolishedRoiSyntheticHint: Boolean(
                videoExportFeatures?.forensic?.videoPolishedRoiSyntheticHint ?? false
              ),
              prnuResidualRisk0to100: videoLowLevel?.prnuResidualRisk0to100,
              dctDoubleQuantRisk0to100: videoLowLevel?.dctDoubleQuantRisk0to100
            },
            biometric: {
              blinkWarning: Boolean(frameResult.blinkWarning),
              suspiciousJitter: Boolean(frameResult.suspiciousJitter),
              suspiciousLowConfidence: Boolean(frameResult.suspiciousLowConfidence),
              maskJitterWarning: Boolean(frameResult.maskJitterWarning),
              reliableFaceFrames: Number((frameResult as any).reliableFaceFrames ?? 0),
              minFaceConfidence: Number(frameResult.minScore ?? 0),
              maxLandmarkJitter: Number(frameResult.maxJitter ?? 0),
              blinkCount: Number(frameResult.blinkCount ?? 0),
              maskJitterMaxScore: Number(frameResult.maskJitterMaxScore ?? 0),
              videoPolishedRoiSyntheticHint: Boolean(
                videoExportFeatures?.forensic?.videoPolishedRoiSyntheticHint ?? false
              )
            },
            metadata: {
              thirdParty: Boolean(mi?.thirdParty),
              originNoVerify: warnings.includes('Origen Digital No Verificado'),
              missingCameraMeta: missingMobile.length > 0
            },
            advanced: {
              rppg: {
                greenSamples: (frameResult as any).rppgGreenSamples ?? [],
                sampleRateHz: rppgRate
              },
              ...(isMp4Container ? { container: { precomputed: containerPrecomputed ?? undefined } } : {})
            }
          });

          const score = Math.round(ens.finalFakeScore0to100);

          let verdict: 'VERIFICADO' | 'SOSPECHOSO' | 'ALERTA ROJA' = verdictFromScore(score);
          if (hardAlert) verdict = 'ALERTA ROJA';

          const confidence = confidenceFromScore(score);
          const riskScore = score;

          if (KNOWN_AI_GENERATOR_EXPORT_FILE_RE.test(file.name)) {
            warnings.push(
              'Nombre de archivo compatible con export de generador de vídeo (Kling, Sora, Runway, Veo, etc.).'
            );
          }
          if (frameResult.blinkWarning) warnings.push('Patrón de Parpadeo Sintético');
          if (frameResult.maskJitterWarning) warnings.push('Inconsistencia de Bordes (Mask Jitter)');
          if (Number((frameResult as any).roiPerfectPts ?? 0) > 0)
            warnings.push('Contraste de Textura (ROI): cara demasiado suave vs fondo (proxy)');
          if (Number((frameResult as any).roiNoiseMismatchPts ?? 0) > 0)
            warnings.push('Ruido de piel vs fondo no coincide (ROI proxy)');
          if (!rppgAnalysis.rhythmicPulseLikely && rppgAnalysis.sampleCount >= 36) {
            warnings.push('rPPG: sin pulso rítmico plausible en ROI (mejillas / verde)');
          }
          if (containerPrecomputed && containerPrecomputed.fakeScore0to100 >= 40) {
            warnings.push('Contenedor MP4: estructura ftyp/boxes atípica para captura móvil estándar');
          }
          if (videoLowLevel && videoLowLevel.prnuResidualRisk0to100 >= 38) {
            warnings.push('PRNU (proxy): ruido residual compatible con síntesis/filtro, poca textura de sensor.');
          }
          if (videoLowLevel && videoLowLevel.dctDoubleQuantRisk0to100 >= 38) {
            warnings.push('DCT (proxy): indicios de doble compresión en bloques 8×8.');
          }

          const reason =
            verdict === 'ALERTA ROJA'
              ? file.size > MAX_SCAN_SIZE_BYTES
                ? 'El archivo supera el limite seguro de 150MB y requiere validacion manual.'
                : NOMINAL_MANIPULATION_FILE_RE.test(file.name)
                  ? 'Patrón en el nombre del archivo sugiere contenido manipulado o sintético (marcador nominal).'
                  : KNOWN_AI_GENERATOR_EXPORT_FILE_RE.test(file.name)
                    ? 'El nombre del archivo coincide con patrones típicos de export de generadores de vídeo (Kling, Sora, Runway, Veo, etc.).'
                    : 'Indicios fuertes de manipulación o síntesis (varias señales alineadas en vídeo).'
              : verdict === 'SOSPECHOSO'
                ? Number((frameResult as any).roiPerfectPts ?? 0) > 0
                  ? 'La cara aparece anormalmente “perfecta/suave” en comparación con el fondo (análisis ROI).'
                  : Number((frameResult as any).roiNoiseMismatchPts ?? 0) > 0
                    ? 'El grano/ruido de la piel no coincide con el del fondo (análisis ROI).'
                    : frameResult.blinkWarning
                      ? 'Patrón de parpadeo sintético detectado (proxy).'
                      : frameResult.maskJitterWarning
                        ? 'Inconsistencia de bordes detectada entre cara y cuello (Mask Jitter).'
                        : 'Se detectaron señales moderadas que requieren verificación adicional.'
                : 'Coherencia biométrica estable. No se detectaron indicios fuertes de síntesis.';

          // Premium: mantenemos ANALYZING hasta el final visual
          await ensureMinimumPremiumTime(premiumStart, 15000, 28, 96);
          completeScan({
            verdict,
            confidence,
            riskScore,
            reason,
            warnings,
            ensembleVotes: toEnsembleVotesExport(ens.votes),
            logsExtra: [
              ...formatEnsembleVotes(ens.votes).map((s) => `ENSEMBLE_VOTE: ${s}`),
              modelsReady ? 'FACE_MODELS: READY' : 'FACE_MODELS: OFFLINE',
              `MIN_FACE_CONFIDENCE: ${(frameResult.minScore * 100).toFixed(1)}%`,
              `MAX_LANDMARK_JITTER: ${(frameResult.maxJitter * 100).toFixed(2)}%`,
              `BLINK_COUNT_20S: ${frameResult.blinkCount}`,
              frameResult.blinkWarning ? 'BLINK_PATTERN: SYNTHETIC' : 'BLINK_PATTERN: OK',
              `MASK_JITTER_MAX_SCORE: ${frameResult.maskJitterMaxScore.toFixed(2)}`,
              frameResult.maskJitterWarning ? 'MASK_JITTER: HALO_DETECTED' : 'MASK_JITTER: OK',
              `ROI_FACE_SMOOTH_PTS: ${Number((frameResult as any).roiPerfectPts ?? 0)}`,
              `ROI_NOISE_MISMATCH_PTS: ${Number((frameResult as any).roiNoiseMismatchPts ?? 0)}`,
              `ROI_NOISE_FACE: ${Number((frameResult as any).roiNoiseFace ?? 0).toFixed(4)}`,
              `ROI_NOISE_BG: ${Number((frameResult as any).roiNoiseBg ?? 0).toFixed(4)}`,
              `ROI_EDGE_FACE: ${Number((frameResult as any).roiEdgeFace ?? 0).toFixed(2)}`,
              `ROI_EDGE_BG: ${Number((frameResult as any).roiEdgeBg ?? 0).toFixed(2)}`,
              mi.thirdParty ? `ENCODER_FOOTPRINT: ${mi.encoderHints.join(', ')}` : 'ENCODER_FOOTPRINT: NONE',
              missingMobile.length ? `CAMERA_META_MISSING: ${missingMobile.join(', ')}` : 'CAMERA_META_MISSING: NONE',
              `RPPG_SAMPLES: ${rppgAnalysis.sampleCount}`,
              `RPPG_FS_HZ: ${rppgRate.toFixed(2)}`,
              `RPPG_PROMINENCE: ${rppgAnalysis.prominence.toFixed(3)}`,
              `RPPG_RHYTHMIC: ${rppgAnalysis.rhythmicPulseLikely ? 'YES' : 'NO'}`,
              rppgAnalysis.estimatedBpm != null ? `RPPG_BPM_EST: ${rppgAnalysis.estimatedBpm}` : 'RPPG_BPM_EST: NA',
              containerPrecomputed
                ? `MP4_FTYP: ${containerPrecomputed.ftypMajorBrand ?? 'NONE'} | MP4_CONTAINER_SCORE: ${containerPrecomputed.fakeScore0to100}`
                : 'MP4_FTYP: N/A',
              videoLowLevel
                ? `PRNU_RESIDUAL_RISK: ${videoLowLevel.prnuResidualRisk0to100} | DCT_DOUBLEQ_RISK: ${videoLowLevel.dctDoubleQuantRisk0to100}`
                : 'PRNU_RESIDUAL_RISK: N/A | DCT_DOUBLEQ_RISK: N/A',
              `VIDEO_POLISHED_ROI_HINT: ${videoExportFeatures?.forensic?.videoPolishedRoiSyntheticHint ? 'YES' : 'NO'}`,
              `AI_EXPORT_FILENAME_HEURISTIC: ${KNOWN_AI_GENERATOR_EXPORT_FILE_RE.test(file.name) ? 'MATCH' : 'NO'}`
            ]
          });
          await new Promise((r) => setTimeout(r, 180));
          if (!isAutomationRun()) showReport = true;
        } catch (err) {
          const verdict: 'VERIFICADO' | 'SOSPECHOSO' | 'ALERTA ROJA' = hardAlert ? 'ALERTA ROJA' : 'SOSPECHOSO';
          const reason = hardAlert
            ? file.size > MAX_SCAN_SIZE_BYTES
              ? 'El archivo supera el limite seguro de 150MB y requiere validacion manual.'
              : NOMINAL_MANIPULATION_FILE_RE.test(file.name)
                ? 'Patrón en el nombre del archivo sugiere contenido manipulado o sintético (marcador nominal).'
                : KNOWN_AI_GENERATOR_EXPORT_FILE_RE.test(file.name)
                  ? 'El nombre del archivo coincide con patrones típicos de export de generadores de vídeo (Kling, Sora, Runway, Veo, etc.).'
                  : 'Patrón en el nombre del archivo sugiere revisión prioritaria.'
            : 'No se pudo completar la Auditoría de Integridad del vídeo en el navegador (error durante el análisis).';

          warnings.push('Auditoría no completada en cliente (video). Revisa consola o intenta otro archivo.');
          await ensureMinimumPremiumTime(premiumStart, 15000, 30, 92);
          completeScan({
            verdict,
            confidence: hardAlert ? 62 : 50,
            riskScore: hardAlert ? 92 : 58,
            reason,
            warnings,
            logsExtra: [`VIDEO_ANALYSIS_ERROR: ${String((err as any)?.message ?? err)}`]
          });
          await new Promise((r) => setTimeout(r, 180));
          if (!isAutomationRun()) showReport = true;
        }
      } else {
        // UX: en imágenes, garantizamos una fase mínima visible (evita "informe instantáneo").
        const imgMinMs = 15000;
        const imgPromise = analyzeImageElaAndTexture(file);
        // Corre análisis real y animación en paralelo; esperamos ambos para UX consistente.
        const [imgResult] = (await Promise.all([imgPromise, smoothProgressUntil(imgPromise, imgMinMs)])) as [
          Awaited<typeof imgPromise>,
          unknown
        ];

        imageElaMean = imgResult.elaMean;
        imageElaUniformity = imgResult.elaUniformity;
        imageTextureRepeatScore = imgResult.textureRepeatScore;
        imageFreqPeakiness = imgResult.freqPeakiness ?? 0;
        imageFreqRadialVar = imgResult.freqRadialVar ?? 0;
        imageEdgeSharpness = imgResult.edgeSharpnessMean ?? 0;
        imageNoiseMean = Number((imgResult as any).noiseMean ?? 0);
        imageNoiseUniformity = Number((imgResult as any).noiseUniformity ?? 0);
        imageLightingInconsistency = Number((imgResult as any).lightingInconsistencyScore ?? 0);
        imageEdgePerfection = Number((imgResult as any).edgePerfectionScore ?? 0);
        imageRenderSignature = Number((imgResult as any).renderSignatureScore ?? 0);
        imageRoiFaceScore = Number((imgResult as any).roiFaceScore ?? 0);
        imageRoiPerfectPts = Number((imgResult as any).roiPerfectPts ?? 0);
        imageRoiNoiseMismatchPts = Number((imgResult as any).roiNoiseMismatchPts ?? 0);
        imageLocalElaCv = Number((imgResult as any).localElaCv ?? 0);
        imageLocalElaPeakRatio = Number((imgResult as any).localElaPeakRatio ?? 0);
        imageLocalEditLikely = Boolean((imgResult as any).localEditLikely);
        imageVectorGraphicLike = Boolean((imgResult as any).vectorGraphicLike);
        imageElaSynthetic = Boolean(imgResult.elaSynthetic);
        imageFrequencySynthetic = Boolean(imgResult.frequencySynthetic);
        imageTextureSynthetic = Boolean(imgResult.textureSynthetic);
        imageEdgesSmoothedSynthetic = Boolean(imgResult.edgesSmoothedSynthetic);

        imageLowLevelForensic = {
          prnuResidualRisk0to100: Number((imgResult as any).prnuResidualRisk0to100 ?? 0),
          prnuResidualMetrics: (imgResult as any).prnuResidualMetrics ?? null,
          prnuResidualNotes: Array.isArray((imgResult as any).prnuResidualNotes)
            ? (imgResult as any).prnuResidualNotes.map(String)
            : [],
          dctDoubleQuantRisk0to100: Number((imgResult as any).dctDoubleQuantRisk0to100 ?? 0),
          dctDoubleQuantMetrics: (imgResult as any).dctDoubleQuantMetrics ?? null,
          dctDoubleQuantNotes: Array.isArray((imgResult as any).dctDoubleQuantNotes)
            ? (imgResult as any).dctDoubleQuantNotes.map(String)
            : []
        };

        let verdict: 'VERIFICADO' | 'SOSPECHOSO' | 'ALERTA ROJA' = 'VERIFICADO';
        let imageEnsVotes: any[] = [];
        if (hardAlert) {
          verdict = 'ALERTA ROJA';
        } else {
          const ens = ensemble.evaluate({
            kind: 'image',
            forensic: {
              roiPerfectPts:
                Number((imgResult as any).roiFaceScore ?? 0) >= 0.9 ? Number((imgResult as any).roiPerfectPts ?? 0) : 0,
              roiNoiseMismatchPts:
                Number((imgResult as any).roiFaceScore ?? 0) >= 0.9 ? Number((imgResult as any).roiNoiseMismatchPts ?? 0) : 0,
              elaSynthetic: Boolean(imgResult.elaSynthetic),
              elaUniformity: Number((imgResult as any).elaUniformity ?? 0),
              frequencySynthetic: Boolean(imgResult.frequencySynthetic),
              freqPeakiness: Number((imgResult as any).freqPeakiness ?? 0),
              freqRadialVar: Number((imgResult as any).freqRadialVar ?? 0),
              textureSynthetic: Boolean(imgResult.textureSynthetic),
              textureRepeatScore: Number((imgResult as any).textureRepeatScore ?? 0),
              edgesSmoothedSynthetic: Boolean(imgResult.edgesSmoothedSynthetic),
              localEditLikely: Boolean((imgResult as any).localEditLikely),
              vectorGraphicLike: Boolean((imgResult as any).vectorGraphicLike),
              noiseMean: Number((imgResult as any).noiseMean ?? 0),
              noiseUniformity: Number((imgResult as any).noiseUniformity ?? 0),
              edgePerfectionScore: Number((imgResult as any).edgePerfectionScore ?? 0),
              edgeSharpnessMean: Number((imgResult as any).edgeSharpnessMean ?? 0),
              renderSignatureScore: Number((imgResult as any).renderSignatureScore ?? 0),
              lightingInconsistencyScore: Number((imgResult as any).lightingInconsistencyScore ?? 0),
              localElaCv: Number((imgResult as any).localElaCv ?? 0),
              localElaPeakRatio: Number((imgResult as any).localElaPeakRatio ?? 0),
              prnuResidualRisk0to100: Number((imgResult as any).prnuResidualRisk0to100 ?? 0),
              dctDoubleQuantRisk0to100: Number((imgResult as any).dctDoubleQuantRisk0to100 ?? 0)
            },
            metadata: {
              thirdParty: Boolean(mi?.thirdParty),
              originNoVerify: warnings.includes('Origen Digital No Verificado'),
              missingCameraMeta: missingMobile.length > 0
            }
          });

          const imgScore = Math.round(ens.finalFakeScore0to100);
          verdict = verdictFromScore(imgScore);
          (imgResult as any).__kronosScore = imgScore;
          imageEnsVotes = ens.votes as any[];
          (imgResult as any).__kronosEnsembleVotes = formatEnsembleVotes(ens.votes);
        }

        const imgScore = Number((imgResult as any).__kronosScore ?? 0);

        const originOnly =
          verdict === 'VERIFICADO' &&
          [
            imgResult.elaSynthetic,
            imgResult.frequencySynthetic,
            imgResult.textureSynthetic,
            imgResult.edgesSmoothedSynthetic,
            (imgResult as any).vectorGraphicLike,
            (imgResult as any).localEditLikely
          ].filter(Boolean).length === 0 &&
          (warnings.includes('Origen Digital No Verificado') || (missingMobile?.length ?? 0) > 0);

        const confidence = confidenceFromScore(imgScore);
        const riskScore = imgScore;
        // Reflejo “en tiempo real” (al terminar el cómputo de imagen): score/confianza quedan consistentes con el ROI.
        setScores({ riskScore, confidence });

        // Avisos en imagen:
        // - "Generada sintéticamente" solo para combinación fuerte.
        // - La recomprensión es común (WhatsApp/IG/X/iCloud, HDR, reducción de ruido). Si el veredicto es VERIFICADO
        //   y no hay señales fuertes (edición local / múltiples módulos), NO lo mostramos como aviso al usuario.
        const weakEditHint = imgResult.elaSynthetic || imgResult.frequencySynthetic;
        const hasLocalEdit = Boolean((imgResult as any).localEditLikely);
        const hasMultiSignals =
          [
            imgResult.elaSynthetic,
            imgResult.frequencySynthetic,
            imgResult.textureSynthetic,
            imgResult.edgesSmoothedSynthetic,
            (imgResult as any).vectorGraphicLike,
            (imgResult as any).localEditLikely
          ].filter(Boolean).length >= 2;

        if (imgResult.elaSynthetic && imgResult.frequencySynthetic) {
          warnings.push('Generada sintéticamente');
        } else if (weakEditHint) {
          if (verdict !== 'VERIFICADO' || hasLocalEdit || hasMultiSignals) {
            warnings.push('Posible recomprensión/edición detectada (ELA/Frecuencia)');
          } else {
            // Se deja en logsExtra para trazabilidad sin asustar a usuarios con fotos reales recomprimidas.
            // (se añadirá abajo en logsExtra)
          }
        }
        if (imgResult.textureSynthetic) warnings.push('Patrones Repetitivos en Texturas (Stable Diffusion)');
        if (imgResult.edgesSmoothedSynthetic) warnings.push('Bordes Suavizados Artificialmente (Edge Softening)');
        if (imageNoiseMean > 0 && imageNoiseMean < 0.018 && imageNoiseUniformity > 0.72) warnings.push('Anomalía de Ruido de Fondo (imagen demasiado limpia)');
        if (imageEdgePerfection > 0.74 && imageEdgeSharpness > 0.55 && imageNoiseMean < 0.025)
          warnings.push('Generación Sintética Probable (bordes de alta frecuencia demasiado perfectos)');
        if (imageRenderSignature > 0.78 && imageNoiseMean < 0.022) warnings.push('Firma de Renderizado (progresión demasiado suave)');
        if (imageLightingInconsistency > 0.86 && imageNoiseMean < 0.03) warnings.push('Coherencia de Iluminación Atípica (proxy)');
        if ((imgResult as any).vectorGraphicLike) warnings.push('Evidencia de edición o contenido gráfico (UI/CGI)');
        if ((imgResult as any).localEditLikely) warnings.push('Posible edición local / composición (ELA por regiones)');
        if (Number((imgResult as any).roiFaceScore ?? 0) >= 0.9 && Number((imgResult as any).roiPerfectPts ?? 0) > 0)
          warnings.push('Contraste de Textura (ROI): cara demasiado suave vs fondo (proxy)');
        if (Number((imgResult as any).roiFaceScore ?? 0) >= 0.9 && Number((imgResult as any).roiNoiseMismatchPts ?? 0) > 0)
          warnings.push('Ruido de piel vs fondo no coincide (ROI proxy)');
        if (Number((imgResult as any).prnuResidualRisk0to100 ?? 0) >= 38) {
          warnings.push('PRNU (proxy): ruido residual compatible con síntesis/filtro, poca textura de sensor.');
        }
        if (Number((imgResult as any).dctDoubleQuantRisk0to100 ?? 0) >= 38) {
          warnings.push('DCT (proxy): indicios de doble compresión en bloques 8×8.');
        }
        if (KNOWN_AI_GENERATOR_EXPORT_FILE_RE.test(file.name)) {
          warnings.push(
            'Nombre de archivo compatible con export de generador de vídeo/imagen (Kling, Sora, Runway, Veo, etc.).'
          );
        }

        const reason =
          verdict === 'ALERTA ROJA'
            ? file.size > MAX_SCAN_SIZE_BYTES
              ? 'El archivo supera el limite seguro de 150MB y requiere validacion manual.'
              : NOMINAL_MANIPULATION_FILE_RE.test(file.name)
                ? 'Patrón en el nombre del archivo sugiere contenido manipulado o sintético (marcador nominal).'
                : KNOWN_AI_GENERATOR_EXPORT_FILE_RE.test(file.name)
                  ? 'El nombre del archivo coincide con patrones típicos de export de generadores (Kling, Sora, Runway, Veo, etc.).'
                  : 'Riesgo de integridad visual elevado (ensemble forense). Se recomienda verificación adicional.'
            : verdict === 'SOSPECHOSO'
              ? imgResult.elaSynthetic || imgResult.frequencySynthetic
                ? 'Se detectaron señales de síntesis compatibles: ELA y/o periodicidad en dominio frecuencia.'
                : imgResult.edgesSmoothedSynthetic
                  ? 'Se detectaron bordes demasiado suavizados (edge softening) compatibles con cuantización/manipulación sintética.'
                  : imgResult.textureSynthetic
                    ? 'Se detectaron patrones repetitivos en texturas compatibles con generación por IA.'
                    : imageRenderSignature > 0.78
                      ? 'Se detectó una firma de renderizado (progresión de color demasiado suave) compatible con generación sintética.'
                      : 'Se detectaron múltiples señales visuales compatibles con generación o manipulación.'
              : originOnly
                ? 'La integridad visual no muestra señales fuertes de edición/IA. El origen de cámara no es verificable por metadatos.'
                : 'La integridad visual y la consistencia de metadatos no muestran indicios claros de IA.';

        completeScan({
          verdict,
          confidence,
          riskScore,
          reason,
          warnings,
          ensembleVotes: toEnsembleVotesExport(imageEnsVotes),
          logsExtra: [
            ...(((imgResult as any).__kronosEnsembleVotes as string[] | undefined) ?? []).map((s) => `ENSEMBLE_VOTE: ${s}`),
            `IMAGE_SHA_STATE: ${fileHashHex ? 'SET' : 'N/A'}`,
            `ELA_MEAN: ${(imgResult.elaMean * 100).toFixed(1)}`,
            `ELA_UNIFORMITY: ${(imgResult.elaUniformity * 100).toFixed(1)}`,
            `TEXTURE_REPEAT_SCORE: ${(imgResult.textureRepeatScore * 100).toFixed(1)}`,
            imgResult.elaSynthetic ? 'ELA_VERDICT: SYNTHETIC' : 'ELA_VERDICT: OK',
            imgResult.textureSynthetic ? 'TEXTURE_VERDICT: SYNTHETIC' : 'TEXTURE_VERDICT: OK',
            imgResult.frequencySynthetic ? 'FREQ_VERDICT: SYNTHETIC' : 'FREQ_VERDICT: OK',
            `FREQ_PEAKINESS: ${(imgResult.freqPeakiness ?? 0).toFixed(4)}`,
            `FREQ_RADIAL_VAR: ${(imgResult.freqRadialVar ?? 0).toFixed(4)}`,
            `EDGE_SHARPNESS: ${(imgResult.edgeSharpnessMean ?? 0).toFixed(4)}`,
            `NOISE_MEAN: ${Number((imgResult as any).noiseMean ?? 0).toFixed(4)}`,
            `NOISE_UNIFORMITY: ${(Number((imgResult as any).noiseUniformity ?? 0) * 100).toFixed(1)}`,
            `LIGHTING_INCONSISTENCY: ${Number((imgResult as any).lightingInconsistencyScore ?? 0).toFixed(3)}`,
            `EDGE_PERFECTION: ${Number((imgResult as any).edgePerfectionScore ?? 0).toFixed(3)}`,
            `RENDER_SIGNATURE: ${Number((imgResult as any).renderSignatureScore ?? 0).toFixed(3)}`,
            imgResult.edgesSmoothedSynthetic ? 'EDGE_SOFTENING: DETECTED' : 'EDGE_SOFTENING: OK',
            `LOCAL_ELA_CV: ${Number((imgResult as any).localElaCv ?? 0).toFixed(3)}`,
            `LOCAL_ELA_PEAK_RATIO: ${Number((imgResult as any).localElaPeakRatio ?? 0).toFixed(3)}`,
            (imgResult as any).localEditLikely ? 'LOCAL_EDIT: LIKELY' : 'LOCAL_EDIT: NO_STRONG_SIGNAL',
            (imgResult.elaSynthetic || imgResult.frequencySynthetic) && verdict === 'VERIFICADO'
              ? 'WEAK_EDIT_HINT: PRESENT_BUT_SUPPRESSED_IN_UI'
              : 'WEAK_EDIT_HINT: -',
            mi.thirdParty ? `ENCODER_FOOTPRINT: ${mi.encoderHints.join(', ')}` : 'ENCODER_FOOTPRINT: NONE',
            `PRNU_RESIDUAL_RISK: ${Number((imgResult as any).prnuResidualRisk0to100 ?? 0)}`,
            `DCT_DOUBLEQ_RISK: ${Number((imgResult as any).dctDoubleQuantRisk0to100 ?? 0)}`
          ]
        });
        await new Promise((r) => setTimeout(r, 180));
        if (!isAutomationRun()) showReport = true;
      }

      // `showReport` se gestiona dentro de cada rama para respetar el final visual de progreso.
    } finally {
      isBusy = false;
    }
  }

  function clearSession() {
    stopTelemetryHeartbeat();
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }

    if (videoUrl) URL.revokeObjectURL(videoUrl);
    videoUrl = '';
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    imageUrl = '';
    selectedFile = null;
    showReport = false;
    resetScanner();
    lastLandmarks = null;
    edgeOverlayRect = null;
    lastMaskJitterScore = 0;
    elaOverlayCanvas = null;
    roiTmpCanvas = null;
    mediaKind = null;
    jitterSeries = [];
    scoreSeries = [];
    lastFrameScore = 0;
    lastFrameJitter = 0;

    imageElaMean = 0;
    imageElaUniformity = 0;
    imageTextureRepeatScore = 0;
    imageFreqPeakiness = 0;
    imageFreqRadialVar = 0;
    imageEdgeSharpness = 0;

    audioSummary = '';
    audioDurationSec = 0;
    audioSampleRate = 0;
    audioChannels = 0;
    audioClipRatio = 0;
    audioBandlimitScore = 0;
    audioEditCuts = 0;

    textInput = '';
    textPreview = '';
    textConnectorScore = 0;
    textTopConnectors = [];
    videoExportFeatures = null;
    imageLowLevelForensic = null;
  }

  function ensureCanvasSize() {
    const preview = videoRef ?? imageRef;
    if (!preview || !canvasRef) return;
    const rect = preview.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    canvasRef.width = Math.floor(rect.width);
    canvasRef.height = Math.floor(rect.height);

    if (!raf) {
      raf = requestAnimationFrame(drawOverlay);
    }
  }

  function drawOverlay() {
    if (!canvasRef) return;
    const ctx = canvasRef.getContext('2d');
    if (!ctx) return;

    const { width, height } = canvasRef;
    if (!width || !height) {
      raf = requestAnimationFrame(drawOverlay);
      return;
    }

    const t = performance.now();

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = 'rgba(8, 8, 8, 0.12)';
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = 'rgba(0, 229, 255, 0.11)';
    ctx.lineWidth = 1;
    for (let y = 0; y < height; y += 28) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    const pulse = (Math.sin(t / 380) + 1) / 2;
    const markerX = width * (0.2 + pulse * 0.6);
    const markerY = height * (0.35 + Math.cos(t / 520) * 0.15);
    ctx.strokeStyle =
      scan.verdict === 'ALERTA ROJA' ? 'rgba(230, 57, 70, 0.7)' : 'rgba(0, 229, 255, 0.7)';
    ctx.strokeRect(markerX - 20, markerY - 20, 40, 40);

    // ELA overlay (solo durante escaneo de imagen)
    if (scan.phase === 'ANALYZING' && mediaKind === 'image' && elaOverlayCanvas) {
      ctx.save();
      ctx.globalAlpha = 0.78;
      ctx.drawImage(elaOverlayCanvas, 0, 0, width, height);
      ctx.globalAlpha = 1;

      // HUD
      ctx.fillStyle = 'rgba(10, 10, 10, 0.65)';
      ctx.strokeStyle = 'rgba(0, 229, 255, 0.22)';
      ctx.lineWidth = 1;
      const pad = 10;
      const boxW = 210;
      const boxH = 42;
      ctx.beginPath();
      ctx.roundRect(pad, pad, boxW, boxH, 10);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.82)';
      ctx.font = '12px Consolas, Monaco, monospace';
      // Mostrar que la IA está trabajando (valores aproximados en UI)
      ctx.fillText('ELA_ANALYSIS: ACTIVE', pad + 12, pad + 24);
      ctx.restore();
    }

    // Landmarks (solo durante el escaneo)
    if (scan.phase === 'ANALYZING' && mediaKind === 'video' && lastLandmarks?.length) {
      const tr = getVideoToCanvasTransform();
      if (!tr) {
        raf = requestAnimationFrame(drawOverlay);
        return;
      }

      const tone =
        scan.verdict === 'ALERTA ROJA'
          ? 'rgba(230, 57, 70, 0.95)'
          : scan.verdict === 'SOSPECHOSO'
            ? 'rgba(242, 214, 126, 0.95)'
            : 'rgba(0, 229, 255, 0.95)';

      ctx.save();
      ctx.globalCompositeOperation = 'screen';

      // Filtro de bordes (Mask Jitter) - dibuja el mapa de edges sobre la ROI facial
      if (edgeOverlayCanvas && edgeOverlayRect) {
        const x = edgeOverlayRect.x * tr.scale + tr.offsetX;
        const y = edgeOverlayRect.y * tr.scale + tr.offsetY;
        const w = edgeOverlayRect.w * tr.scale;
        const h = edgeOverlayRect.h * tr.scale;
        ctx.globalAlpha = 0.78;
        ctx.drawImage(edgeOverlayCanvas, x, y, w, h);
        ctx.globalAlpha = 1;
      }

      // Halo suave
      ctx.fillStyle = tone;
      for (const p of lastLandmarks) {
        const x = p.x * tr.scale + tr.offsetX;
        const y = p.y * tr.scale + tr.offsetY;
        ctx.beginPath();
        ctx.arc(x, y, Math.max(1.2, 1.6 * tr.scale), 0, Math.PI * 2);
        ctx.fill();
      }

      // Conexiones simples (nariz/cejas/ojos/boca)
      ctx.strokeStyle = tone;
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.75;

      const pts = lastLandmarks;
      const drawChain = (from: number, to: number, close = false) => {
        ctx.beginPath();
        for (let i = from; i <= to; i++) {
          const p = pts?.[i];
          if (!p) continue;
          const x = p.x * tr.scale + tr.offsetX;
          const y = p.y * tr.scale + tr.offsetY;
          if (i === from) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        if (close) ctx.closePath();
        ctx.stroke();
      };

      // Jaw (0-16), brows (17-21, 22-26), nose (27-35), eyes (36-41, 42-47), mouth (48-59)
      drawChain(0, 16);
      drawChain(17, 21);
      drawChain(22, 26);
      drawChain(27, 35);
      drawChain(36, 41, true);
      drawChain(42, 47, true);
      drawChain(48, 59, true);

      // HUD pequeño: score/jitter en la esquina
      ctx.globalAlpha = 1;
      ctx.fillStyle = 'rgba(10, 10, 10, 0.65)';
      ctx.strokeStyle = 'rgba(0, 229, 255, 0.22)';
      ctx.lineWidth = 1;
      const pad = 10;
      const boxW = 190;
      const boxH = 52;
      ctx.beginPath();
      ctx.roundRect(pad, pad, boxW, boxH, 10);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = 'rgba(255,255,255,0.82)';
      ctx.font = '12px Consolas, Monaco, monospace';
      ctx.fillText(`FACE_SCORE: ${(lastFrameScore * 100).toFixed(1)}%`, pad + 12, pad + 22);
      ctx.fillStyle = tone;
      ctx.fillText(`JITTER: ${(lastFrameJitter * 100).toFixed(2)}%`, pad + 12, pad + 40);

      ctx.restore();
    }

    raf = requestAnimationFrame(drawOverlay);
  }

  function downloadCertificate() {
    if (!selectedFile || !scan.verdict) return;
    downloadForensicPdf();
  }

  function closeReport() {
    showReport = false;
  }

  onDestroy(() => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    if (scoreTweenRaf) cancelAnimationFrame(scoreTweenRaf);
    scoreTweenRaf = 0;
    if (confTweenRaf) cancelAnimationFrame(confTweenRaf);
    confTweenRaf = 0;
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    stopTelemetryHeartbeat();
    try {
      auditWorker?.terminate();
    } catch {
      // ignore
    }
    auditWorker = null;
    auditPending.clear();
  });
</script>

<section class="processor">
  <div class="main-card">
    <header>
      <div>
        <p class="chip">{$t('scanner.chip')}</p>
        <h2>
          {activeTab === 'video'
            ? $t('scanner.titles.video')
            : activeTab === 'image'
              ? $t('scanner.titles.image')
              : activeTab === 'audio'
                ? $t('scanner.titles.audio')
              : activeTab === 'text'
                ? $t('scanner.titles.text')
                : $t('scanner.titles.link')}
        </h2>
      </div>
      <span
        class="status"
        class:warn={scan.verdict === 'SOSPECHOSO'}
        class:danger={scan.verdict === 'ALERTA ROJA'}
        class:safe={scan.verdict === 'VERIFICADO'}
        data-testid="kronos-badge"
      >
        {badgeLabel}
      </span>
      <span class="sr-only" data-testid="kronos-phase">{scan.phase}</span>
    </header>

    <nav class="tabs" aria-label="Tabs de análisis">
      <button
        type="button"
        class:active={activeTab === 'video'}
        data-testid="kronos-tab-video"
        on:click={() => {
          if (isBusy) return;
          activeTab = 'video';
          clearSession();
        }}
      >
        {$t('scanner.tabs.video')}
      </button>
      <button
        type="button"
        class:active={activeTab === 'image'}
        data-testid="kronos-tab-image"
        on:click={() => {
          if (isBusy) return;
          activeTab = 'image';
          clearSession();
        }}
      >
        {$t('scanner.tabs.image')}
      </button>
      <button
        type="button"
        class:active={activeTab === 'audio'}
        data-testid="kronos-tab-audio"
        on:click={() => {
          if (isBusy) return;
          activeTab = 'audio';
          clearSession();
        }}
      >
        {$t('scanner.tabs.audio')}
      </button>
      <button
        type="button"
        class:active={activeTab === 'text'}
        data-testid="kronos-tab-text"
        on:click={() => {
          if (isBusy) return;
          activeTab = 'text';
          clearSession();
        }}
      >
        {$t('scanner.tabs.text')}
      </button>
      <button
        type="button"
        class:active={activeTab === 'link'}
        data-testid="kronos-tab-link"
        on:click={() => {
          if (isBusy) return;
          activeTab = 'link';
          clearSession();
        }}
      >
        {$t('scanner.tabs.link')}
      </button>
    </nav>

    {#if activeTab === 'video' || activeTab === 'image' || activeTab === 'audio'}
      <div
        class="dropzone"
        class:dragging={isDragActive}
        role="button"
        tabindex="0"
        aria-label={activeTab === 'video' ? 'Zona de carga de video' : activeTab === 'image' ? 'Zona de carga de imagen' : 'Zona de carga de audio'}
        on:dragover={onDragOver}
        on:dragleave={onDragLeave}
        on:drop={onDrop}
      >
        <input
          id="video-input"
          type="file"
          accept={activeTab === 'video' ? 'video/*' : activeTab === 'image' ? 'image/*' : 'audio/*,video/*'}
          on:change={onFileInput}
          data-testid="kronos-file-input"
        />
        <label for="video-input">
          <strong
            >{activeTab === 'video'
              ? $t('scanner.dropzone.strongVideo')
              : activeTab === 'image'
                ? $t('scanner.dropzone.strongImage')
                : $t('scanner.dropzone.strongAudio')}</strong
          >
          <span>
            {activeTab === 'video'
              ? $t('scanner.dropzone.formatsVideo')
              : activeTab === 'image'
                ? $t('scanner.dropzone.formatsImage')
                : $t('scanner.dropzone.formatsAudio')}
          </span>
        </label>

        {#if modelLoading}
          <div class="model-loader" in:fade={{ duration: 120 }} out:fade={{ duration: 120 }}>
            <div class="model-loader-inner">
              <p>{modelStatusText}</p>
              <div class="model-bar" aria-label="Cargando Redes Neuronales">
                <div class="model-bar-fill" style={`width:${modelProgress}%;`}></div>
              </div>
              <span>{modelProgress}%</span>
            </div>
          </div>
        {/if}
      </div>
    {:else if activeTab === 'text'}
      <div class="text-panel">
        <div class="text-head">
          <p class="chip">TEXTUAL INTEGRITY</p>
          <p class="text-sub">Auditoria de estilo: conectores lógicos repetitivos de modelos.</p>
        </div>
        <textarea
          class="text-area"
          bind:value={textInput}
          placeholder="Pega aquí un texto para analizar...&#10;Ejemplo: En conclusión, ... Por otro lado, ... Es importante destacar..."
        ></textarea>
        <button type="button" class="text-analyze" on:click={runTextAnalysis} disabled={!textInput.trim() || isBusy}>
          {$t('scanner.text.analyze')}
        </button>
      </div>
    {:else}
      <div class="link-panel">
        <div class="link-head">
          <p class="chip">{$t('scanner.link.chip')}</p>
          <p class="link-sub">
            {$t('scanner.link.body')}
          </p>
        </div>

        <div class="link-form">
          <label class="link-label" for="kronos-link-input">Enlace</label>
          <input
            id="kronos-link-input"
            class="link-input"
            bind:value={linkInput}
            placeholder="https://www.youtube.com/watch?v=...  |  https://vimeo.com/...  |  https://tiktok.com/..."
            inputmode="url"
            autocomplete="off"
            spellcheck="false"
          />
          {#if linkError}
            <p class="link-error">{linkError}</p>
          {:else if linkNormalized}
            <p class="link-hint">
              Detectado: <strong>{linkKind.label}</strong>{linkKind.host ? ` · ${linkKind.host}` : ''}
              {#if linkKind.type === 'DIRECT'}
                · Parece un archivo directo (aun así, para compliance no lo descargamos automáticamente).
              {/if}
            </p>
          {/if}

          <div class="link-actions">
            <button
              type="button"
              class="link-open"
              disabled={!linkNormalized || isBusy}
              on:click={() => {
                if (!linkNormalized) return;
                window.open(linkNormalized, '_blank', 'noopener,noreferrer');
              }}
            >
              Abrir enlace
            </button>

            <div class="link-upload">
              <input
                id="link-file-input"
                type="file"
                accept="video/*,image/*,audio/*"
                on:change={onLinkFileInput}
              />
              <label class="link-upload-btn" for="link-file-input">Subir archivo para analizar</label>
            </div>
          </div>
        </div>

        <div class="link-guidance">
          <p><strong>Cómo proceder</strong></p>
          <ul>
            <li>Si eres el propietario, <strong>exporta el archivo original</strong> (cámara/editor) y súbelo aquí.</li>
            <li>Si la plataforma ofrece descarga oficial (según permisos/plan), descarga el archivo y súbelo.</li>
            <li>Si solo tienes un enlace público, KRONOS puede registrar el enlace como referencia, pero la auditoría profunda requiere el archivo.</li>
          </ul>
        </div>
      </div>
    {/if}

    <div class="viewport" class:danger={verdictClass === 'danger'} class:warn={verdictClass === 'warn'}>
      {#if activeTab === 'video' && mediaKind === 'video' && hasVideo}
        <video bind:this={videoRef} src={videoUrl} controls on:loadedmetadata={ensureCanvasSize}></video>
        <canvas bind:this={canvasRef} aria-hidden="true"></canvas>

        {#if scan.phase === 'ANALYZING' && mediaKind === 'video'}
          <div class="laser-wrap" in:fade={{ duration: 120 }} out:fade={{ duration: 120 }}>
            <div class="laser" style={`top:${laserProgress}%;`}></div>
          </div>
        {/if}
      {:else if activeTab === 'image' && mediaKind === 'image' && hasImage}
        <img bind:this={imageRef} class="media-img" src={imageUrl} alt="Evidencia subida" on:load={ensureCanvasSize} />
        <canvas bind:this={canvasRef} aria-hidden="true"></canvas>
      {:else if activeTab === 'text' && mediaKind === 'text'}
        <div class="text-preview">
          <Radar active={scan.phase === 'ANALYZING'} progress={scan.progress} verdict={scan.verdict} />
          <p class="text-preview-label">Texto analizado</p>
          <pre class="text-pre">{textPreview || '-'}</pre>
        </div>
      {:else if activeTab === 'audio' && mediaKind === 'audio'}
        <div class="text-preview">
          <Radar active={scan.phase === 'ANALYZING'} progress={scan.progress} verdict={scan.verdict} />
          <p class="text-preview-label">Audio</p>
          <pre class="text-pre">{audioSummary || 'Listo para auditoría acústica.'}</pre>
        </div>
      {:else if activeTab === 'text'}
        <div class="empty-state">
          <Radar active={scan.phase === 'ANALYZING'} progress={scan.progress} verdict={scan.verdict} />
          <p>{$t('scanner.text.hint')}</p>
        </div>
      {:else if activeTab === 'audio'}
        <div class="empty-state">
          <Radar active={scan.phase === 'ANALYZING'} progress={scan.progress} verdict={scan.verdict} />
          <p>{$t('scanner.empty.audio')}</p>
        </div>
      {:else}
        <div class="empty-state">
          <Radar active={scan.phase === 'ANALYZING'} progress={scan.progress} verdict={scan.verdict} />
          <p>{$t('scanner.empty.image')}</p>
        </div>
      {/if}
    </div>

    <footer>
      <div class="meter" class:indeterminate={scan.phase === 'ANALYZING'}>
        <div class="fill" style={`width:${scan.progress}%;`}></div>
      </div>
      <p class={scan.phase === 'ANALYZING' ? 'status status-live' : 'status'}>
        {#if scan.phase === 'ANALYZING'}
          {$t('scanner.status.scanning')}
          <span class="dots" aria-hidden="true">
            <span>.</span><span>.</span><span>.</span>
          </span>
        {:else}
          {displayMillis}ms · {Math.round(scan.progress)}%
        {/if}
      </p>
      <button type="button" class="btn-ghost" on:click={clearSession} disabled={isBusy}>{$t('scanner.buttons.reset')}</button>
    </footer>
  </div>

  <aside class="telemetry" in:fly={{ x: 20, duration: 250 }}>
    <h3>{$t('scanner.telemetry.title')}</h3>
    <p class="sub">{$t('scanner.telemetry.sub')}</p>

    <div class="stream">
      {#each telemetry as line, index (line + index)}
        <p class="line" transition:fade={{ duration: 180 }}>
          <span>&gt;</span>{line}
        </p>
      {/each}
    </div>

    <div class="validation">
      <div class="val-grid" aria-label="Indicadores de validación">
        <div class="val-item">
          <div class="val-top">
            <span class="val-ico" aria-hidden="true">◌</span>
            <span class="val-label">{metric1Label}</span>
            <strong class={metric1Ok ? 'ok' : 'bad'}>{metric1Ok ? 'OK' : 'ALERTA'}</strong>
          </div>
          <div class="val-bar"><div class="val-fill" class:loading={scan.phase === 'ANALYZING'} style={`width:${Math.round(metric1ScoreUi * 100)}%;`}></div></div>
        </div>

        <div class="val-item">
          <div class="val-top">
            <span class="val-ico" aria-hidden="true">◌</span>
            <span class="val-label">{metric2Label}</span>
            <strong class={metric2ScoreUi > 0.74 ? 'ok' : 'bad'}>{metric2ScoreUi > 0.74 ? 'OK' : 'ALERTA'}</strong>
          </div>
          <div class="val-bar"><div class="val-fill" class:loading={scan.phase === 'ANALYZING'} style={`width:${Math.round(metric2ScoreUi * 100)}%;`}></div></div>
        </div>

        <div class="val-item">
          <div class="val-top">
            <span class="val-ico" aria-hidden="true">◌</span>
            <span class="val-label">{metric3Label}</span>
            <strong class={dataScoreUi > 0.7 ? 'ok' : 'bad'}>{dataScoreUi > 0.7 ? 'OK' : 'ALERTA'}</strong>
          </div>
          <div class="val-bar"><div class="val-fill" class:loading={scan.phase === 'ANALYZING'} style={`width:${Math.round(dataScoreUi * 100)}%;`}></div></div>
        </div>
      </div>

      <div class="val-rows">
        <p><span>{$t('scanner.details.state')}</span> <strong class={verdictClass}>{verdictLabelUi(scan.verdict)}</strong></p>
        <p class="row-conf">
          <span>{$t('scanner.details.confidence')}</span>
          <strong class="conf-wrap">
            <span class="conf-num">{scan.confidence ? `${confidenceSmooth.toFixed(1)}%` : '-'}</span>
            <span class="conf-bar" aria-hidden="true">
              <span
                class={`conf-bar-fill ${confidenceBarTone}`}
                style={`width:${scan.confidence ? confidenceSmooth.toFixed(1) : 0}%;`}
              ></span>
            </span>
          </strong>
        </p>
        <p><span>{$t('scanner.details.score')}</span> <strong class="mono">{scan.riskScore ? `${Math.round(riskScoreSmooth)}` : '-'}</strong></p>
        <p class="row-file"><span>{$t('scanner.details.file')}</span> <strong class="mono file-val">{selectedFile?.name ?? '—'}</strong></p>
        <p><span>{$t('scanner.details.weight')}</span> <strong class="mono">{selectedFile ? `${(selectedFile.size / 1024 / 1024).toFixed(2)} MB` : '—'}</strong></p>
        <div class="val-actions">
          <button
            type="button"
            class="btn-mini"
            on:click={exportAnalysisJson}
            disabled={!selectedFile || scan.phase !== 'COMPLETED'}
          >
            {$t('scanner.buttons.exportJson')}
          </button>
        </div>
      </div>
    </div>
  </aside>
</section>

<ReportModal
  open={showReport}
  verdict={scan.verdict}
  confidence={scan.confidence}
  riskScore={scan.riskScore}
  fileName={selectedFile?.name ?? ''}
  reason={scan.reason}
  warnings={scan.warnings}
  completedAt={scan.completedAt ?? ''}
  on:close={closeReport}
  on:download={downloadCertificate}
/>

<style>
  .processor {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 300px;
    gap: 1rem;
  }

  .main-card,
  .telemetry {
    border-radius: 22px;
    border: 1px solid var(--kronos-border);
    background: rgba(22, 22, 22, 0.9);
    backdrop-filter: blur(14px);
  }

  .main-card {
    padding: 1rem;
    box-shadow:
      0 0 0 1px rgba(255, 255, 255, 0.03) inset,
      0 10px 34px rgba(0, 0, 0, 0.35);
  }

  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.7rem;
    margin-bottom: 0.85rem;
  }

  .chip {
    letter-spacing: 0.14em;
    color: rgba(255, 255, 255, 0.58);
    font-size: 0.71rem;
    text-transform: uppercase;
  }

  h2 {
    margin-top: 0.18rem;
    font-size: clamp(1.15rem, 2vw, 1.44rem);
    color: #f3f3f3;
    font-weight: 600;
  }

  .status {
    border: 1px solid rgba(0, 229, 255, 0.34);
    border-radius: 999px;
    color: #00e5ff;
    font-size: 0.75rem;
    letter-spacing: 0.09em;
    padding: 0.4rem 0.67rem;
  }

  .status.safe {
    border-color: rgba(34, 197, 94, 0.38);
    color: var(--kronos-ok);
  }

  .status.warn {
    border-color: rgba(245, 158, 11, 0.38);
    color: var(--kronos-warn);
  }

  .status.danger {
    border-color: rgba(230, 57, 70, 0.42);
    color: #e63946;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border-width: 0;
  }

  .dropzone {
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 18px;
    background: rgba(10, 10, 10, 0.35);
    position: relative;
    margin-bottom: 0.85rem;
    transition: border-color 200ms ease, background-color 200ms ease, transform 200ms ease;
  }

  .model-loader {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    background: rgba(2, 2, 2, 0.72);
    backdrop-filter: blur(10px);
    border-radius: 14px;
  }

  .model-loader-inner {
    width: min(92%, 420px);
    border: 1px solid rgba(0, 229, 255, 0.18);
    border-radius: 14px;
    background: rgba(10, 10, 10, 0.85);
    padding: 0.85rem 0.9rem;
    text-align: center;
    box-shadow: 0 0 26px rgba(0, 229, 255, 0.09);
  }

  .model-loader-inner p {
    color: rgba(255, 255, 255, 0.82);
    font-size: 0.92rem;
    margin-bottom: 0.55rem;
    letter-spacing: 0.03em;
  }

  .model-bar {
    height: 10px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.08);
    overflow: hidden;
    border: 1px solid rgba(255, 255, 255, 0.06);
  }

  .model-bar-fill {
    height: 100%;
    width: 0%;
    background: linear-gradient(90deg, rgba(0, 229, 255, 0.28), rgba(0, 229, 255, 0.92));
    box-shadow: 0 0 14px rgba(0, 229, 255, 0.28);
    transition: width 180ms ease;
  }

  .model-loader-inner span {
    display: inline-block;
    margin-top: 0.5rem;
    font-family: Consolas, Monaco, monospace;
    color: rgba(255, 255, 255, 0.7);
    font-size: 0.8rem;
  }

  .dropzone.dragging {
    border-color: rgba(0, 229, 255, 0.26);
    background: rgba(0, 229, 255, 0.06);
    transform: translateY(-1px);
  }

  .dropzone input[type='file'] {
    position: absolute;
    inset: 0;
    opacity: 0;
    cursor: pointer;
  }

  .dropzone label {
    min-height: 96px;
    display: grid;
    place-content: center;
    text-align: center;
    gap: 0.36rem;
    color: rgba(255, 255, 255, 0.84);
    font-size: 0.94rem;
    padding: 1rem;
  }

  .dropzone label span {
    color: rgba(255, 255, 255, 0.58);
    font-size: 0.8rem;
  }

  .link-panel {
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 14px;
    background: rgba(10, 10, 10, 0.32);
    padding: 0.9rem;
    margin-bottom: 0.85rem;
  }

  .link-sub {
    color: rgba(255, 255, 255, 0.72);
    font-size: 0.9rem;
    line-height: 1.5;
    margin-top: 0.35rem;
  }

  .link-form {
    margin-top: 0.75rem;
    display: grid;
    gap: 0.55rem;
  }

  .link-label {
    font-size: 0.78rem;
    letter-spacing: 0.08em;
    color: rgba(255, 255, 255, 0.58);
  }

  .link-input {
    width: 100%;
    border-radius: 12px;
    border: 1px solid rgba(255, 255, 255, 0.14);
    background: rgba(10, 10, 10, 0.7);
    color: rgba(255, 255, 255, 0.92);
    padding: 0.65rem 0.75rem;
    outline: none;
    transition: border-color 160ms ease, box-shadow 160ms ease;
  }

  .link-input:focus {
    border-color: rgba(0, 229, 255, 0.42);
    box-shadow: 0 0 0 3px rgba(0, 229, 255, 0.12);
  }

  .link-error {
    color: rgba(230, 57, 70, 0.92);
    font-size: 0.85rem;
  }

  .link-hint {
    color: rgba(255, 255, 255, 0.7);
    font-size: 0.85rem;
  }

  .link-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.6rem;
    align-items: center;
    margin-top: 0.2rem;
  }

  .link-open {
    border-radius: 12px;
    border: 1px solid rgba(255, 255, 255, 0.14);
    background: rgba(255, 255, 255, 0.06);
    color: rgba(255, 255, 255, 0.86);
    padding: 0.6rem 0.75rem;
    font-size: 0.9rem;
    transition: transform 160ms ease, border-color 160ms ease, background-color 160ms ease;
  }

  .link-open:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .link-open:not(:disabled):hover {
    transform: translateY(-1px);
    border-color: rgba(0, 229, 255, 0.22);
    background: rgba(0, 229, 255, 0.06);
  }

  .link-upload {
    position: relative;
    display: inline-flex;
  }

  .link-upload input[type='file'] {
    position: absolute;
    inset: 0;
    opacity: 0;
    cursor: pointer;
  }

  .link-upload-btn {
    border-radius: 12px;
    border: 1px solid rgba(0, 229, 255, 0.32);
    background: rgba(0, 229, 255, 0.14);
    color: rgba(255, 255, 255, 0.9);
    padding: 0.6rem 0.75rem;
    font-size: 0.9rem;
    letter-spacing: 0.02em;
    box-shadow: 0 0 22px rgba(0, 229, 255, 0.12);
  }

  .link-guidance {
    margin-top: 0.8rem;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
    padding-top: 0.75rem;
    color: rgba(255, 255, 255, 0.72);
    font-size: 0.88rem;
  }

  .link-guidance p {
    color: rgba(255, 255, 255, 0.85);
    margin-bottom: 0.4rem;
  }

  .link-guidance ul {
    margin: 0;
    padding-left: 1.1rem;
    display: grid;
    gap: 0.35rem;
  }

  .viewport {
    position: relative;
    min-height: 360px;
    border-radius: 22px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: radial-gradient(circle at 18% 12%, rgba(0, 229, 255, 0.05), rgba(0, 0, 0, 0.35) 60%);
    overflow: hidden;
  }

  .viewport.danger {
    border-color: rgba(230, 57, 70, 0.3);
    box-shadow: 0 0 28px rgba(230, 57, 70, 0.16) inset;
  }

  .viewport.warn {
    border-color: rgba(245, 158, 11, 0.26);
    box-shadow: 0 0 28px rgba(245, 158, 11, 0.14) inset;
  }

  video,
  img.media-img,
  canvas,
  .laser-wrap {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }

  video {
    object-fit: cover;
    background: #000;
  }

  .media-img {
    object-fit: cover;
    background: #000;
  }

  canvas {
    pointer-events: none;
  }

  .laser-wrap {
    pointer-events: none;
  }

  .laser {
    position: absolute;
    left: 0;
    width: 100%;
    height: 2px;
    background: linear-gradient(90deg, transparent, rgba(0, 229, 255, 0.92), transparent);
    box-shadow:
      0 0 20px rgba(0, 229, 255, 0.42),
      0 0 35px rgba(0, 229, 255, 0.16);
    transform: translateY(-50%);
    transition: top 80ms linear;
  }

  .viewport.danger .laser {
    background: linear-gradient(90deg, transparent, rgba(230, 57, 70, 0.96), transparent);
    box-shadow:
      0 0 20px rgba(230, 57, 70, 0.62),
      0 0 35px rgba(230, 57, 70, 0.25);
  }

  .viewport.warn .laser {
    background: linear-gradient(90deg, transparent, rgba(245, 158, 11, 0.96), transparent);
    box-shadow:
      0 0 20px rgba(245, 158, 11, 0.58),
      0 0 35px rgba(245, 158, 11, 0.22);
  }

  .empty-state {
    min-height: 360px;
    display: grid;
    place-items: center;
    text-align: center;
    gap: 0.8rem;
    color: rgba(255, 255, 255, 0.74);
    padding: 1rem;
  }

  .empty-state p {
    max-width: 44ch;
  }

  footer {
    margin-top: 0.85rem;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    gap: 0.7rem;
    align-items: center;
  }

  .meter {
    height: 8px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.08);
    overflow: hidden;
  }

  .fill {
    height: 100%;
    background: linear-gradient(90deg, rgba(0, 229, 255, 0.35), rgba(0, 229, 255, 0.95));
    box-shadow: 0 0 14px rgba(0, 229, 255, 0.28);
    transition: width 120ms linear;
  }

  /* Barra indeterminada: sigue animando aunque JS se bloquee momentáneamente */
  .meter.indeterminate .fill {
    width: 100% !important;
    background: linear-gradient(
      90deg,
      rgba(0, 229, 255, 0.2),
      rgba(0, 229, 255, 0.92),
      rgba(255, 255, 255, 0.72),
      rgba(0, 229, 255, 0.2)
    );
    background-size: 220% 100%;
    animation: kronos-indeterminate 1.1s linear infinite;
  }

  @keyframes kronos-indeterminate {
    from {
      background-position: 0% 0%;
    }
    to {
      background-position: 220% 0%;
    }
  }

  .status {
    color: rgba(255, 255, 255, 0.68);
    font-size: 0.82rem;
    white-space: nowrap;
  }

  .status-live {
    font-variant-numeric: tabular-nums;
  }

  .dots {
    display: inline-flex;
    gap: 0.1em;
    margin-left: 0.25em;
  }

  .dots span {
    opacity: 0.22;
    animation: kronos-dot 1s infinite;
  }

  .dots span:nth-child(2) {
    animation-delay: 0.15s;
  }
  .dots span:nth-child(3) {
    animation-delay: 0.3s;
  }

  @keyframes kronos-dot {
    0%,
    60%,
    100% {
      opacity: 0.22;
    }
    30% {
      opacity: 0.95;
    }
  }

  footer p {
    color: rgba(255, 255, 255, 0.68);
    font-size: 0.82rem;
  }

  .btn-ghost {
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 12px;
    background: transparent;
    color: rgba(255, 255, 255, 0.75);
    padding: 0.5rem 0.75rem;
    cursor: pointer;
    transition: border-color 160ms ease, color 160ms ease, background-color 160ms ease, transform 160ms ease;
  }

  .btn-ghost:hover:not(:disabled) {
    border-color: rgba(0, 229, 255, 0.22);
    color: rgba(255, 255, 255, 0.9);
    background: rgba(0, 229, 255, 0.05);
    transform: translateY(-1px);
  }

  .btn-ghost:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .telemetry {
    padding: 0.95rem;
    color: #f3f3f3;
  }

  .telemetry h3 {
    font-size: 1.02rem;
    font-weight: 600;
  }

  .sub {
    color: rgba(255, 255, 255, 0.58);
    font-size: 0.8rem;
    margin-top: 0.2rem;
  }

  .stream {
    margin-top: 0.8rem;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 18px;
    padding: 0.7rem;
    height: 260px;
    overflow-y: auto;
    overflow-x: hidden;
    background: rgba(0, 0, 0, 0.18);
    scrollbar-width: thin;
    scrollbar-color: rgba(255, 255, 255, 0.16) rgba(0, 0, 0, 0.08);
    overscroll-behavior: contain;
  }

  /* Scrollbar premium (evita barras blancas por defecto) */
  .stream::-webkit-scrollbar {
    width: 8px;
    height: 8px;
  }

  .stream::-webkit-scrollbar-track {
    background: rgba(0, 0, 0, 0.08);
    border-radius: 999px;
  }

  .stream::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.16);
    border: 2px solid rgba(0, 0, 0, 0.14);
    border-radius: 999px;
  }

  .stream::-webkit-scrollbar-thumb:hover {
    background: rgba(0, 229, 255, 0.22);
  }

  .line {
    color: rgba(255, 255, 255, 0.87);
    font-size: 0.78rem;
    letter-spacing: 0.04em;
    margin-bottom: 0.4rem;
    font-family: Consolas, Monaco, monospace;
    /* Evitar overflow horizontal (y por tanto scroll feo) en logs largos */
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .line span {
    color: #00e5ff;
    margin-right: 0.32rem;
  }

  .validation {
    margin-top: 0.75rem;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 18px;
    padding: 0.75rem;
    background: rgba(255, 255, 255, 0.012);
  }

  .val-grid {
    display: grid;
    gap: 0.6rem;
    padding-bottom: 0.7rem;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    margin-bottom: 0.7rem;
  }

  .val-item {
    display: grid;
    gap: 0.4rem;
  }

  .val-top {
    display: grid;
    grid-template-columns: 18px 1fr auto;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.82rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace;
    letter-spacing: 0.02em;
  }

  .val-ico {
    color: rgba(0, 229, 255, 0.85);
  }

  .val-label {
    color: rgba(255, 255, 255, 0.7);
  }

  .val-top strong.ok {
    color: rgba(0, 229, 255, 0.95);
  }

  .val-top strong.bad {
    color: rgba(230, 57, 70, 0.9);
  }

  .val-bar {
    height: 8px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.06);
    overflow: hidden;
    border: 1px solid rgba(255, 255, 255, 0.06);
  }

  .val-fill {
    height: 100%;
    width: 0%;
    border-radius: 999px;
    background: linear-gradient(90deg, rgba(0, 229, 255, 0.22), rgba(0, 229, 255, 0.9));
    /* Movimiento gradual “premium” */
    transition: width 780ms cubic-bezier(0.22, 1, 0.36, 1);
    will-change: width;
  }

  /* “Cargando” premium: shimmer suave mientras ANALYZING */
  .val-fill.loading {
    background: linear-gradient(
      90deg,
      rgba(0, 229, 255, 0.16) 0%,
      rgba(0, 229, 255, 0.92) 45%,
      rgba(255, 255, 255, 0.22) 55%,
      rgba(0, 229, 255, 0.92) 70%,
      rgba(0, 229, 255, 0.16) 100%
    );
    background-size: 220% 100%;
    animation: kronos-val-shimmer 1100ms ease-in-out infinite;
    filter: saturate(1.05);
  }

  @keyframes kronos-val-shimmer {
    0% {
      background-position: 0% 50%;
    }
    100% {
      background-position: 100% 50%;
    }
  }

  .val-rows {
    display: grid;
    gap: 0.45rem;
  }

  .val-actions {
    display: flex;
    justify-content: flex-end;
    margin-top: 0.15rem;
  }

  .btn-mini {
    font-size: 0.72rem;
    letter-spacing: 0.06em;
    padding: 0.42rem 0.6rem;
    border-radius: 999px;
    border: 1px solid rgba(255, 255, 255, 0.09);
    background: rgba(10, 10, 10, 0.25);
    color: rgba(255, 255, 255, 0.76);
    transition: border-color 180ms ease, background-color 180ms ease, color 180ms ease, transform 180ms ease;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;
  }

  .btn-mini:hover:enabled {
    border-color: rgba(0, 229, 255, 0.36);
    background: rgba(0, 229, 255, 0.08);
    color: rgba(255, 255, 255, 0.9);
    transform: translateY(-1px);
  }

  .btn-mini:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .val-rows p {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.6rem;
    font-size: 0.79rem;
  }

  .val-rows p.row-file {
    align-items: flex-start;
  }

  .val-rows p.row-conf {
    align-items: flex-start;
  }

  .conf-wrap {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 0.35rem;
    min-width: 150px;
  }

  .conf-num {
    transition: opacity 220ms ease, transform 220ms ease;
    will-change: transform;
  }

  .conf-bar {
    width: 150px;
    height: 8px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.07);
    border: 1px solid rgba(255, 255, 255, 0.08);
    overflow: hidden;
  }

  .conf-bar-fill {
    display: block;
    height: 100%;
    width: 0%;
    border-radius: 999px;
    transition: width 520ms cubic-bezier(0.22, 1, 0.36, 1), background-color 320ms ease;
  }

  .conf-bar-fill.safe {
    background: rgba(0, 229, 255, 0.92);
  }

  .conf-bar-fill.warn {
    background: rgba(255, 166, 0, 0.88);
  }

  .conf-bar-fill.danger {
    background: rgba(230, 57, 70, 0.92);
  }

  .file-val {
    max-width: 170px;
    text-align: right;
    overflow-wrap: anywhere;
    word-break: break-word;
  }

  .val-rows span {
    color: rgba(255, 255, 255, 0.58);
  }

  .mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace;
  }

  .val-rows strong.safe {
    color: var(--kronos-ok);
  }

  .val-rows strong.warn {
    color: var(--kronos-warn);
  }

  .val-rows strong.danger {
    color: #e63946;
  }

  /* Utilidades de semáforo para toda la UI del scanner */
  .safe {
    color: var(--kronos-ok);
  }

  .warn {
    color: var(--kronos-warn);
  }

  .danger {
    color: var(--kronos-alert);
  }

  .tabs {
    display: flex;
    gap: 0.25rem;
    margin-bottom: 0.9rem;
    padding: 0.25rem;
    border-radius: 16px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(10, 10, 10, 0.32);
  }

  .tabs button {
    flex: 1;
    border-radius: 14px;
    border: 1px solid transparent;
    background: transparent;
    color: rgba(255, 255, 255, 0.74);
    padding: 0.6rem 0.75rem;
    font-weight: 650;
    letter-spacing: 0.06em;
    cursor: pointer;
    transition: transform 180ms ease, border-color 180ms ease, background-color 180ms ease;
  }

  .tabs button.active {
    border-color: rgba(255, 255, 255, 0.08);
    background: rgba(255, 255, 255, 0.045);
    color: rgba(255, 255, 255, 0.92);
    box-shadow: 0 0 0 1px rgba(0, 229, 255, 0.08) inset;
  }

  .text-panel {
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 14px;
    background: rgba(10, 10, 10, 0.32);
    padding: 1rem;
    margin-bottom: 0.85rem;
  }

  .text-head {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    margin-bottom: 0.75rem;
  }

  .text-sub {
    color: rgba(255, 255, 255, 0.7);
    font-size: 0.9rem;
    line-height: 1.35;
  }

  .text-area {
    width: 100%;
    min-height: 170px;
    border-radius: 12px;
    border: 1px solid rgba(26, 26, 26, 1);
    background: rgba(0, 0, 0, 0.22);
    color: rgba(255, 255, 255, 0.92);
    padding: 0.8rem;
    font-family: Consolas, Monaco, monospace;
    font-size: 0.9rem;
    outline: none;
  }

  .text-analyze {
    width: 100%;
    margin-top: 0.8rem;
    border-radius: 12px;
    border: 1px solid rgba(0, 229, 255, 0.42);
    background: rgba(0, 229, 255, 0.14);
    color: #fff;
    font-weight: 700;
    padding: 0.72rem;
    cursor: pointer;
    transition: transform 180ms ease, box-shadow 180ms ease, opacity 180ms ease;
  }

  .text-analyze:disabled {
    opacity: 0.55;
    cursor: not-allowed;
    transform: none;
    box-shadow: none;
  }

  .text-analyze:hover:not(:disabled) {
    transform: translateY(-1px);
    box-shadow: 0 0 22px rgba(0, 229, 255, 0.18);
  }

  .text-preview {
    display: grid;
    gap: 0.55rem;
    padding: 1rem 0;
    width: 100%;
  }

  .text-preview-label {
    color: rgba(255, 255, 255, 0.72);
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    font-size: 0.72rem;
  }

  .text-pre {
    margin: 0;
    padding: 0.85rem 0.95rem;
    border-radius: 14px;
    border: 1px solid rgba(26, 26, 26, 1);
    background: rgba(0, 0, 0, 0.22);
    color: rgba(255, 255, 255, 0.9);
    font-family: Consolas, Monaco, monospace;
    font-size: 0.85rem;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 240px;
    overflow: auto;
  }

  @media (max-width: 980px) {
    .processor {
      grid-template-columns: 1fr;
    }

    .stream {
      height: 180px;
    }
  }

  @media (max-width: 720px) {
    footer {
      grid-template-columns: 1fr;
    }
  }
</style>
