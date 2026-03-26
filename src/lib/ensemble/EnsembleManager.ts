import { analyzeRppgGreenSeries } from '$lib/forensics/rppgSignal';
import { scanMp4Container } from '$lib/forensics/mp4BoxForensics';
import type { ContainerEnsembleInputs, RppgEnsembleInputs } from '$lib/forensics/AdvancedForensicSuite';

export type EvidenceKind = 'video' | 'image' | 'audio' | 'text' | 'unknown';

export type SpecialistKey =
  | 'forensic'
  | 'biometric'
  | 'acoustic'
  | 'linguistic'
  | 'metadata'
  | 'other'
  | 'rppg'
  | 'container';

export type SpecialistVote = {
  key: SpecialistKey;
  label: string;
  // 0..100 where 0 = "real/safe", 100 = "fake/risky"
  fakeScore0to100: number;
  weight: number;
  applicable: boolean;
  notes?: string[];
};

export type EnsembleWeights = Record<SpecialistKey, number>;

export const DEFAULT_ENSEMBLE_WEIGHTS: EnsembleWeights = {
  // Física / contenedor primero (40% cada uno en el bloque forense avanzado; se normaliza con el resto).
  rppg: 0.4,
  container: 0.4,
  biometric: 0.35,
  // Forensic “estético”/ROI: menor peso relativo frente a rPPG y átomos MP4.
  forensic: 0.35,
  metadata: 0.12,
  other: 0.05,
  acoustic: 0.1,
  linguistic: 0.1
};

export type EnsembleResult = {
  finalFakeScore0to100: number;
  votes: SpecialistVote[];
  normalizedWeightsSum: number;
};

const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));

function normalizeApplicableWeights(votes: SpecialistVote[]) {
  const sum = votes.reduce((acc, v) => acc + (v.applicable ? v.weight : 0), 0);
  if (!sum) return { sum: 0, factor: 0 };
  return { sum, factor: 1 / sum };
}

export function aggregateWeighted(votes: SpecialistVote[]): EnsembleResult {
  const { sum, factor } = normalizeApplicableWeights(votes);
  if (!sum) return { finalFakeScore0to100: 0, votes, normalizedWeightsSum: 0 };

  let score = 0;
  for (const v of votes) {
    if (!v.applicable) continue;
    score += clamp(v.fakeScore0to100, 0, 100) * v.weight * factor;
  }
  return { finalFakeScore0to100: clamp(score, 0, 100), votes, normalizedWeightsSum: sum };
}

/** Vídeo: sube el score cuando coinciden varias señales (manipulación clara sin un solo disparador al máximo). */
export function videoConvergenceBoost(forensic: ForensicInputs, biometric: BiometricInputs): number {
  const rpp = Number(forensic.roiPerfectPts ?? 0) >= 40;
  const rnm = Number(forensic.roiNoiseMismatchPts ?? 0) >= 20;
  const portrait = Boolean(forensic.videoPortraitSyntheticHint);
  const polishedRoi = Boolean(forensic.videoPolishedRoiSyntheticHint);
  const roiStrong = rpp || rnm;
  const roiAny = roiStrong || portrait || polishedRoi;

  let bio = 0;
  if (biometric.blinkWarning) bio += 1;
  if (biometric.maskJitterWarning) bio += 1;
  if (biometric.suspiciousJitter) bio += 1;
  if (biometric.suspiciousLowConfidence) bio += 1;

  let extra = 0;
  if (bio >= 2) extra += 17;
  if (bio >= 3) extra += 12;
  if (roiAny && bio >= 1) extra += 15;
  if (roiStrong && bio >= 1) extra += 12;
  if (portrait && bio >= 1) extra += 11;
  if (polishedRoi && bio >= 1) extra += 9;
  if (polishedRoi && bio < 1) extra += 8;

  if (!roiAny) extra = Math.min(extra, 20);
  return Math.min(40, extra);
}

/** Cara estable + rPPG sin pulso plausible: refuerzo cruzado (Gen-AI pulido). */
export function videoRppgStableFaceBoost(
  biometric: BiometricInputs,
  votes: SpecialistVote[]
): number {
  const rppg = votes.find((v) => v.key === 'rppg' && v.applicable);
  if (!rppg || rppg.fakeScore0to100 < 52) return 0;
  const rf = Number(biometric.reliableFaceFrames ?? 0);
  const minC = Number(biometric.minFaceConfidence ?? 0);
  const maxJ = Number(biometric.maxLandmarkJitter ?? 99);
  if (rf < 14 || minC < 0.89) return 0;
  if (maxJ > 0.028) return 0;
  if (biometric.suspiciousLowConfidence) return 0;
  return Math.min(20, Math.round((rppg.fakeScore0to100 - 50) * 0.38));
}

export function formatEnsembleVotes(votes: SpecialistVote[]) {
  return votes
    .filter((v) => v.applicable)
    .map((v) => {
      const fake = clamp(v.fakeScore0to100, 0, 100);
      const real = clamp(100 - fake, 0, 100);
      return `${v.label}: ${fake.toFixed(0)}% Fake | ${real.toFixed(0)}% Real`;
    });
}

// ---------------- Specialists (pure, based on existing KRONOS signals) ----------------

export type ForensicInputs = {
  // Generic signals used in KRONOS image/video ROI forensic checks
  roiPerfectPts?: number; // 0 or 40
  roiNoiseMismatchPts?: number; // 0 or 20

  // Image-only forensic signals
  elaSynthetic?: boolean;
  elaUniformity?: number; // 0..1 (higher = more uniform ELA)
  frequencySynthetic?: boolean;
  freqPeakiness?: number;
  freqRadialVar?: number;
  textureSynthetic?: boolean;
  textureRepeatScore?: number; // 0..1
  edgesSmoothedSynthetic?: boolean;
  localEditLikely?: boolean;
  vectorGraphicLike?: boolean;
  noiseMean?: number;
  noiseUniformity?: number;
  edgePerfectionScore?: number;
  edgeSharpnessMean?: number;
  renderSignatureScore?: number;
  lightingInconsistencyScore?: number;
  localElaCv?: number;
  localElaPeakRatio?: number;
  /** Vídeo: textura ROI cara vs fondo (misma escala que face-api pipeline). */
  roiNoiseFace?: number;
  roiNoiseBg?: number;
  roiEdgeFace?: number;
  roiEdgeBg?: number;
  /** Vídeo: cara muy estable, sin parpadeos detectados en ventana (proxy Sora/deepfake limpio). */
  videoPortraitSyntheticHint?: boolean;
  /** Vídeo: ROI textura cara/fondo sospechosa + tracking muy estable pero con algunos parpadeos (Kling/Sora con “blinks”). */
  videoPolishedRoiSyntheticHint?: boolean;

  /**
   * Proxy PRNU / ruido residual (0–100 fake): integrado en el voto Forensic único.
   * No sustituye PRNU forense con patrón de sensor de referencia.
   */
  prnuResidualRisk0to100?: number;
  /**
   * Proxy doble cuantificación DCT 8×8 (0–100 fake): integrado en el voto Forensic único.
   */
  dctDoubleQuantRisk0to100?: number;
};

export function ForensicAnalyst(kind: EvidenceKind, input: ForensicInputs, weights: EnsembleWeights): SpecialistVote {
  const applicable = kind === 'image' || kind === 'video';
  if (!applicable) {
    return { key: 'forensic', label: 'Forensic', fakeScore0to100: 0, weight: weights.forensic, applicable: false };
  }

  let score = 0;

  // ROI contrast is a strong forgery proxy (already gated by face confidence upstream)
  score += Number(input.roiPerfectPts ?? 0);
  score += Number(input.roiNoiseMismatchPts ?? 0);

  // Vídeo: refuerzo acoplado a ROI + ratios cara/fondo (deepfake hiper-limpio vs móvil real).
  if (kind === 'video') {
    const rpp = Number(input.roiPerfectPts ?? 0);
    const rnm = Number(input.roiNoiseMismatchPts ?? 0);
    const nrf = Number(input.roiNoiseFace ?? 0);
    const nrb = Number(input.roiNoiseBg ?? 0);
    const ef = Number(input.roiEdgeFace ?? 0);
    const eb = Number(input.roiEdgeBg ?? 0);
    if (rpp >= 40 || rnm >= 20) {
      score += 38;
    }
    if (nrb > 1e-8 && nrf > 1e-8) {
      const nr = nrf / nrb;
      if (nr < 0.62 && nrf > 0.0025) score += 22;
      if (nr < 0.5 && rnm >= 20) score += 18;
    }
    if (eb > 1e-6 && ef > 0.5) {
      const er = ef / eb;
      if (er < 0.58 && rpp >= 40) score += 16;
    }
    if (input.videoPortraitSyntheticHint) {
      score += 88;
    }
    if (input.videoPolishedRoiSyntheticHint) {
      score += 58;
    }
    score = Math.min(score, 100);
  }

  // Image forensic: balancear JPEG/cámara real (WhatsApp, móvil) vs generadores tipo Gemini/Grok.
  if (kind === 'image') {
    if (input.localEditLikely) score += 25;
    if (input.vectorGraphicLike) score += 20;
    if (input.textureSynthetic) score += 18;
    if (input.elaSynthetic && input.frequencySynthetic) score += 22;

    const nm = Number(input.noiseMean ?? 0);
    const nu = Number(input.noiseUniformity ?? 0);
    const ep = Number(input.edgePerfectionScore ?? 0);
    const es = Number(input.edgeSharpnessMean ?? 0);
    const rs = Number(input.renderSignatureScore ?? 0);
    const eu = Number(input.elaUniformity ?? 0);
    const tr = Number(input.textureRepeatScore ?? 0);
    const fp = Number(input.freqPeakiness ?? 0);
    const fr = Number(input.freqRadialVar ?? 0);
    const li = Number(input.lightingInconsistencyScore ?? 0);
    const localCv = Number(input.localElaCv ?? 0);
    const localPeak = Number(input.localElaPeakRatio ?? 0);

    const strongSynth =
      Boolean(input.elaSynthetic && input.frequencySynthetic) ||
      Boolean(input.textureSynthetic) ||
      Boolean(input.vectorGraphicLike) ||
      Boolean(input.localEditLikely) ||
      Number(input.roiPerfectPts ?? 0) + Number(input.roiNoiseMismatchPts ?? 0) >= 40;

    // Señal de pipeline de cámara / recompresión (ELA local variable, picos típicos de JPEG social).
    const cameraPipelineLikely =
      !strongSynth && (localCv > 0.34 || localPeak > 1.72 || (nm > 0.033 && nu < 0.52));

    // --- Ruido “demasiado limpio” (más estricto; no castigar JPEG con grano real) ---
    const tooClean =
      !cameraPipelineLikely &&
      ((nm > 0 && nm < 0.022 && nu > 0.52) || (nm > 0 && nm < 0.028 && nu > 0.62));
    if (tooClean) score = Math.max(score, 76);

    // --- Bordes: perfección alta sí penaliza; nitidez baja solo si hay otro apoyo (evita JPEG suave) ---
    if (ep > 0.58) score += 34;
    if (es > 0 && es < 0.2 && ep > 0.36) score += 32;
    if (es > 0 && es > 0.78) score += 28;

    // --- Firma render / textura: no confundir NR agresivo de cámara con IA ---
    // JPEG viejo / móvil: alto rs + ELA local variable + poco ruido “uniforme” en el mapa nu.
    const rsLooksLikeCameraNr =
      !strongSynth &&
      ((localCv > 0.48 && nm < 0.028) || (localCv > 0.51 && nm < 0.036 && rs > 0.55));

    // Recompresión social con variación local alta y nu bajo (no mezclar con PNG Gemini nu similar pero fp distinto).
    const jpegSocialRealHint = !strongSynth && localCv > 0.36 && nu < 0.35;
    if (rs > 0.62 && !rsLooksLikeCameraNr) score += 36;
    if (tr > 0.14) score += 32;

    // --- ELA uniforme: umbral alto (JPEG social suele subir eu sin ser IA) ---
    if (eu > 0.94 && localCv < 0.33) score = Math.max(score, 74);
    else if (eu > 0.985 && !cameraPipelineLikely) score = Math.max(score, 78);

    // --- Dominio frecuencia: escalar según si parece recompresión móvil vs pico “generador” ---
    let freqAdd = 0;
    if (input.frequencySynthetic) freqAdd += 20;
    if (fp > 0.02 && fr > 0.6) freqAdd += 25;

    let freqScale = 1;
    if (!strongSynth) {
      if (localCv > 0.54) freqScale *= 0.38;
      else if (localCv > 0.35 && fp < 0.19) freqScale *= 0.48;
      else if (nm > 0.036 && fp < 0.22) freqScale *= 0.55;
      if (nm > 0.018 && nm < 0.03 && localCv > 0.27 && localCv < 0.42 && fp < 0.13) freqScale *= 0.62;
    }
    // JPEG de red social con “cara perfecta” pero fp medio: no aplastar tanto la rama frecuencia.
    if (
      !strongSynth &&
      !jpegSocialRealHint &&
      Boolean(input.frequencySynthetic) &&
      li > 0.88 &&
      fp >= 0.122 &&
      fp <= 0.175 &&
      nm < 0.044
    ) {
      freqScale = Math.max(freqScale, 1);
    }
    score += freqAdd * freqScale;

    const oldJpegBlock = localCv > 0.47 && rs > 0.57 && nm < 0.034;
    const waRealBlock =
      nu < 0.33 &&
      localCv > 0.38 &&
      localCv < 0.52 &&
      nm > 0.052 &&
      nm < 0.085 &&
      ep < 0.32 &&
      fp > 0.38;
    const mobileFlatElaBlock =
      nu > 0.45 && fp > 0.32 && localCv < 0.33 && nm > 0.055 && nm < 0.1;

    // Pico frecuencial alto + lighting (Grok/Gemini / JPEG IA); varias exclusiones para WhatsApp/móvil real.
    const genLikeFreq =
      Boolean(input.frequencySynthetic) &&
      li > 0.8 &&
      fp >= 0.172 &&
      nm < 0.088 &&
      (ep > 0.06 || (fp > 0.28 && ep > 0.032)) &&
      !oldJpegBlock &&
      !(localCv > 0.5 && rs > 0.68 && nm < 0.022) &&
      !waRealBlock &&
      !mobileFlatElaBlock;
    if (genLikeFreq) {
      score += 52;
      if (nm > 0.085) score += 24;
    }

    // JPEG IA con pico fp muy alto y render “plano” (rs bajo); no solapa con fotos antiguas reales.
    const jpegAiSharpPeak =
      !strongSynth &&
      Boolean(input.frequencySynthetic) &&
      fp > 0.41 &&
      fp < 0.53 &&
      li > 0.88 &&
      nm > 0.042 &&
      nm < 0.072 &&
      localCv > 0.35 &&
      localCv < 0.48 &&
      rs < 0.22 &&
      !oldJpegBlock;
    if (jpegAiSharpPeak) score += 50;

    // Variante: pico fp aún más alto (JPEG IA comprimido) con bordes casi nulos en ep.
    const jpegAiHighFpPeak =
      !strongSynth &&
      Boolean(input.frequencySynthetic) &&
      fp > 0.51 &&
      fp < 0.58 &&
      li > 0.9 &&
      nm > 0.045 &&
      nm < 0.056 &&
      localCv > 0.38 &&
      localCv < 0.47 &&
      ep < 0.035 &&
      rs < 0.32 &&
      !oldJpegBlock;
    if (jpegAiHighFpPeak) score += 52;

    // PNG Gemini con grano visible (nm alto): nm<0.088 del bloque anterior lo excluye; rama aparte.
    const pngGeminiGrain =
      Boolean(input.frequencySynthetic) &&
      li > 0.85 &&
      fp >= 0.166 &&
      fp <= 0.23 &&
      nm >= 0.062 &&
      nm <= 0.14 &&
      es > 0.35 &&
      ep > 0.055 &&
      ep < 0.22;
    if (pngGeminiGrain) score += 76;

    // fp medio + nm bajo + lighting alto (muchos fakes JPEG de red; no tanto móvil con mucho ruido).
    const genLikeMid =
      Boolean(input.frequencySynthetic) &&
      li > 0.86 &&
      fp >= 0.122 &&
      fp <= 0.172 &&
      nm < 0.046 &&
      !strongSynth &&
      !jpegSocialRealHint;
    if (genLikeMid) score += 50;

    // Bordes “demasiado limpios” en rango típico generador + dominio frecuencia marcado.
    const edgeGenLike =
      Boolean(input.frequencySynthetic) &&
      li > 0.83 &&
      ep > 0.38 &&
      ep < 0.52 &&
      nm < 0.072 &&
      fp < 0.22;
    if (edgeGenLike) score += 50;
    if (edgeGenLike && li > 0.875 && fp > 0.135 && fp < 0.205) score += 22;

    // PNG/export con bordes muy regulares y poca variación de textura (nu bajo).
    const pngCleanEdges = Boolean(input.frequencySynthetic) && ep > 0.45 && li > 0.85 && nu < 0.22;
    if (pngCleanEdges) score += 52;

    const studioExportLikely =
      Boolean(input.frequencySynthetic) &&
      ep > 0.48 &&
      ep < 0.58 &&
      li > 0.88 &&
      nu < 0.21 &&
      rs < 0.52 &&
      fp < 0.12;
    if (studioExportLikely) score += 22;
  }

  // --- Bajo nivel (PRNU residual proxy + DCT doble-Q proxy): mismo peso forensic, sin nuevos SpecialistKey ---
  const forensicSubNotes: string[] = [];
  const prnuIn = input.prnuResidualRisk0to100;
  if (prnuIn != null && Number.isFinite(prnuIn)) {
    const p = clamp(prnuIn, 0, 100);
    score = Math.min(100, score + p * 0.2);
    if (p >= 28) {
      forensicSubNotes.push(`PRNU residual (proxy): ${p.toFixed(0)}% riesgo — ruido sin textura típica de sensor.`);
    }
  }
  const dctIn = input.dctDoubleQuantRisk0to100;
  if (dctIn != null && Number.isFinite(dctIn)) {
    const d = clamp(dctIn, 0, 100);
    score = Math.min(100, score + d * 0.2);
    if (d >= 28) {
      forensicSubNotes.push(`DCT doble-Q (proxy): ${d.toFixed(0)}% riesgo — periodicidad en AC 8×8.`);
    }
  }

  return {
    key: 'forensic',
    label: 'Forensic',
    fakeScore0to100: clamp(score, 0, 100),
    weight: weights.forensic,
    applicable: true,
    notes: forensicSubNotes.length ? forensicSubNotes : undefined
  };
}

export type BiometricInputs = {
  blinkWarning?: boolean; // proxy; gated upstream by reliable face
  suspiciousJitter?: boolean;
  suspiciousLowConfidence?: boolean;
  maskJitterWarning?: boolean;
  reliableFaceFrames?: number;
  minFaceConfidence?: number; // 0..1
  maxLandmarkJitter?: number;
  blinkCount?: number;
  maskJitterMaxScore?: number;
  /** Alineado con Forensic (misma heurística exportada en features). */
  videoPolishedRoiSyntheticHint?: boolean;
};

export function BiometricAnalyst(kind: EvidenceKind, input: BiometricInputs, weights: EnsembleWeights): SpecialistVote {
  const applicable = kind === 'video';
  if (!applicable) {
    return { key: 'biometric', label: 'Biometrics', fakeScore0to100: 0, weight: weights.biometric, applicable: false };
  }

  let score = 0;
  // Requested weights: blink (+30), ROI handled by Forensic (+40/+20), others moderate
  if (input.blinkWarning) score += 30;
  if (input.maskJitterWarning) score += 20;
  if (input.suspiciousJitter) score += 15;
  if (input.suspiciousLowConfidence) score += 10;

  const rf = Number(input.reliableFaceFrames ?? 0);
  const minC = Number(input.minFaceConfidence ?? 1);
  const maxJ = Number(input.maxLandmarkJitter ?? 0);
  const bc = Number(input.blinkCount ?? 0);
  const mjs = Number(input.maskJitterMaxScore ?? 0);

  if (mjs >= 4) score += Math.min(34, 12 + mjs * 1.15);
  if (mjs >= 12) score += 14;

  if (
    rf >= 14 &&
    bc === 0 &&
    !input.blinkWarning &&
    minC >= 0.9 &&
    maxJ <= 0.021 &&
    !input.suspiciousLowConfidence
  ) {
    score += 46;
  }

  if (input.videoPolishedRoiSyntheticHint) {
    score += 34;
  }

  if (rf >= 18 && maxJ >= 0.03 && !input.blinkWarning) {
    score = Math.max(0, score - 14);
  }

  // If we barely had reliable face frames, downweight biometric output
  if (rf > 0 && rf < 10) score *= 0.6;

  return {
    key: 'biometric',
    label: 'Biometrics',
    fakeScore0to100: clamp(score, 0, 100),
    weight: weights.biometric,
    applicable: true
  };
}

export type AcousticInputs = {
  score0to100?: number;
};

export function AcousticAnalyst(kind: EvidenceKind, input: AcousticInputs, weights: EnsembleWeights): SpecialistVote {
  const applicable = kind === 'audio';
  return {
    key: 'acoustic',
    label: 'Acoustic',
    fakeScore0to100: clamp(Number(input.score0to100 ?? 0), 0, 100),
    weight: weights.acoustic,
    applicable
  };
}

export type LinguisticInputs = {
  score0to100?: number;
};

export function LinguisticAnalyst(kind: EvidenceKind, input: LinguisticInputs, weights: EnsembleWeights): SpecialistVote {
  const applicable = kind === 'text';
  return {
    key: 'linguistic',
    label: 'Linguistic',
    fakeScore0to100: clamp(Number(input.score0to100 ?? 0), 0, 100),
    weight: weights.linguistic,
    applicable
  };
}

export type MetadataInputs = {
  thirdParty?: boolean;
  originNoVerify?: boolean;
  missingCameraMeta?: boolean;
};

export function RppgAnalyst(
  kind: EvidenceKind,
  input: RppgEnsembleInputs | undefined,
  weights: EnsembleWeights
): SpecialistVote {
  if (kind !== 'video') {
    return {
      key: 'rppg',
      label: 'rPPG (pulso)',
      fakeScore0to100: 0,
      weight: weights.rppg,
      applicable: false
    };
  }
  const inn = input ?? {};
  let res = inn.precomputed ?? null;
  if (!res && inn.greenSamples?.length && inn.sampleRateHz && inn.sampleRateHz >= 3) {
    res = analyzeRppgGreenSeries(inn.greenSamples, inn.sampleRateHz);
  }
  if (!res || res.sampleCount < 36) {
    return {
      key: 'rppg',
      label: 'rPPG (pulso)',
      fakeScore0to100: 0,
      weight: weights.rppg,
      applicable: false,
      notes: ['Muestras insuficientes o frecuencia de muestreo baja para rPPG.']
    };
  }

  let fake = 0;
  const notes: string[] = [];
  if (res.rhythmicPulseLikely) {
    fake = Math.max(0, 20 - Math.min(20, (res.prominence - 4) * 5));
    notes.push(
      `Pico espectral plausible (~${res.estimatedBpm ?? '?'} lpm, prominencia ${res.prominence.toFixed(2)}).`
    );
  } else {
    fake = 52 + Math.min(40, Math.max(0, 6 - res.prominence) * 5);
    notes.push('Sin pulso rítmico claro en banda cardiaca (verde / ROI mejillas).');
    if (res.prominence < 2.5) notes.push('Baja prominencia espectral frente al fondo.');
  }

  return {
    key: 'rppg',
    label: 'rPPG (pulso)',
    fakeScore0to100: clamp(fake, 0, 100),
    weight: weights.rppg,
    applicable: true,
    notes
  };
}

export function ContainerAnalyst(
  kind: EvidenceKind,
  input: ContainerEnsembleInputs | undefined,
  weights: EnsembleWeights
): SpecialistVote {
  if (kind !== 'video') {
    return {
      key: 'container',
      label: 'Contenedor MP4',
      fakeScore0to100: 0,
      weight: weights.container,
      applicable: false
    };
  }
  const inn = input ?? {};
  let res = inn.precomputed ?? null;
  if (!res && inn.buffer && inn.buffer.byteLength > 0) {
    res = scanMp4Container(inn.buffer);
  }
  if (!res) {
    return {
      key: 'container',
      label: 'Contenedor MP4',
      fakeScore0to100: 0,
      weight: weights.container,
      applicable: false,
      notes: ['Sin datos de contenedor (no MP4 o sin buffer).']
    };
  }

  const notes = [...res.notes];
  const ord = res.topLevelOrder.slice(0, 14);
  if (ord.length) notes.push(`Boxes (inicio): ${ord.join(' → ')}`);
  if (res.ftypMajorBrand) notes.push(`ftyp major: ${res.ftypMajorBrand}`);

  return {
    key: 'container',
    label: 'Contenedor MP4',
    fakeScore0to100: clamp(res.fakeScore0to100, 0, 100),
    weight: weights.container,
    applicable: true,
    notes
  };
}

export function MetadataAnalyst(kind: EvidenceKind, input: MetadataInputs, weights: EnsembleWeights): SpecialistVote {
  const applicable = kind === 'video' || kind === 'image' || kind === 'audio';
  if (!applicable) {
    return { key: 'metadata', label: 'Metadata', fakeScore0to100: 0, weight: weights.metadata, applicable: false };
  }

  // Conservative: metadata should not dominate, but can contribute.
  let score = 0;
  if (input.thirdParty) score += 35;
  if (input.originNoVerify) score += 10;
  if (input.missingCameraMeta) score += 10;

  return {
    key: 'metadata',
    label: 'Metadata',
    fakeScore0to100: clamp(score, 0, 100),
    weight: weights.metadata,
    applicable: true
  };
}

export function OtherAnalyst(kind: EvidenceKind, weights: EnsembleWeights): SpecialistVote {
  // Placeholder for future “specialists” without affecting today’s behavior.
  return { key: 'other', label: 'Other', fakeScore0to100: 0, weight: weights.other, applicable: kind !== 'unknown' };
}

export class EnsembleManager {
  private weights: EnsembleWeights;
  constructor(weights?: Partial<EnsembleWeights>) {
    this.weights = { ...DEFAULT_ENSEMBLE_WEIGHTS, ...(weights ?? {}) };
  }

  evaluate(input: {
    kind: EvidenceKind;
    forensic?: ForensicInputs;
    biometric?: BiometricInputs;
    acoustic?: AcousticInputs;
    linguistic?: LinguisticInputs;
    metadata?: MetadataInputs;
    advanced?: {
      rppg?: RppgEnsembleInputs;
      container?: ContainerEnsembleInputs;
    };
  }): EnsembleResult {
    const kind = input.kind;
    const adv = input.advanced;
    const votes: SpecialistVote[] = [
      ForensicAnalyst(kind, input.forensic ?? {}, this.weights),
      RppgAnalyst(kind, adv?.rppg, this.weights),
      ContainerAnalyst(kind, adv?.container, this.weights),
      BiometricAnalyst(kind, input.biometric ?? {}, this.weights),
      AcousticAnalyst(kind, input.acoustic ?? {}, this.weights),
      LinguisticAnalyst(kind, input.linguistic ?? {}, this.weights),
      MetadataAnalyst(kind, input.metadata ?? {}, this.weights),
      OtherAnalyst(kind, this.weights)
    ];
    const base = aggregateWeighted(votes);
    if (kind !== 'video') return base;
    const boost = videoConvergenceBoost(input.forensic ?? {}, input.biometric ?? {});
    const pulseBoost = videoRppgStableFaceBoost(input.biometric ?? {}, base.votes);
    return {
      ...base,
      finalFakeScore0to100: clamp(base.finalFakeScore0to100 + boost + pulseBoost, 0, 100)
    };
  }
}

