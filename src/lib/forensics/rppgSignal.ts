/**
 * rPPG ligero: variación temporal del canal verde en ROI tipo mejilla.
 * FFT / espectro para banda cardiaca aproximada (~0.7–4 Hz).
 */

export type RppgAnalysisResult = {
  sampleCount: number;
  sampleRateHz: number;
  /** Pico en banda HR / mediana del espectro en banda (sin unidades absolutas). */
  prominence: number;
  /** true si hay pico claro y coherente en banda plausible */
  rhythmicPulseLikely: boolean;
  /** BPM estimado del bin dominante en banda (si aplica) */
  estimatedBpm: number | null;
};

function subtractMean(values: number[]): Float64Array {
  const n = values.length;
  const out = new Float64Array(n);
  let m = 0;
  for (let i = 0; i < n; i++) m += values[i];
  m /= Math.max(1, n);
  for (let i = 0; i < n; i++) out[i] = values[i] - m;
  return out;
}

/** Tendencia lineal simple (mínimos cuadrados). */
function detrendLinear(x: Float64Array): Float64Array {
  const n = x.length;
  if (n < 4) return x;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += i;
    sy += x[i];
    sxx += i * i;
    sxy += i * x[i];
  }
  const denom = n * sxx - sx * sx;
  if (Math.abs(denom) < 1e-12) return x;
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = x[i] - (slope * i + intercept);
  return out;
}

function hannWindow(n: number): Float64Array {
  const w = new Float64Array(n);
  if (n <= 1) {
    w[0] = 1;
    return w;
  }
  for (let i = 0; i < n; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  }
  return w;
}

function dftBinMagnitude(signal: Float64Array, k: number): number {
  const n = signal.length;
  let re = 0;
  let im = 0;
  const twoPiKOverN = (-2 * Math.PI * k) / n;
  for (let i = 0; i < n; i++) {
    const ang = twoPiKOverN * i;
    re += signal[i] * Math.cos(ang);
    im += signal[i] * Math.sin(ang);
  }
  return Math.sqrt(re * re + im * im);
}

/**
 * Media del canal verde en dos parches “mejilla” respecto al box facial (coords en espacio del canvas).
 */
export function meanGreenCheekRoi(
  img: ImageData,
  box: { x: number; y: number; width: number; height: number }
): number {
  const { width: W, height: H, data } = img;
  const bx = box.x;
  const by = box.y;
  const bw = box.width;
  const bh = box.height;
  const rects = [
    {
      x: Math.max(0, Math.floor(bx + bw * 0.22)),
      y: Math.max(0, Math.floor(by + bh * 0.36)),
      w: Math.max(2, Math.floor(bw * 0.2)),
      h: Math.max(2, Math.floor(bh * 0.2))
    },
    {
      x: Math.max(0, Math.floor(bx + bw * 0.58)),
      y: Math.max(0, Math.floor(by + bh * 0.36)),
      w: Math.max(2, Math.floor(bw * 0.2)),
      h: Math.max(2, Math.floor(bh * 0.2))
    }
  ];

  let sum = 0;
  let n = 0;
  for (const r of rects) {
    const x1 = Math.min(W, r.x + r.w);
    const y1 = Math.min(H, r.y + r.h);
    for (let y = Math.max(0, r.y); y < y1; y++) {
      const row = y * W * 4;
      for (let x = Math.max(0, r.x); x < x1; x++) {
        const i = row + x * 4;
        sum += data[i + 1];
        n++;
      }
    }
  }
  return n > 0 ? sum / n : 0;
}

const HR_LOW_HZ = 0.65;
const HR_HIGH_HZ = 4.0;
const MIN_SAMPLES = 36;
const MIN_FS_HZ = 3.5;

export function analyzeRppgGreenSeries(greenSamples: number[], sampleRateHz: number): RppgAnalysisResult {
  const n = greenSamples.length;
  const badRate = sampleRateHz < MIN_FS_HZ || !Number.isFinite(sampleRateHz);
  if (n < MIN_SAMPLES || badRate) {
    return {
      sampleCount: n,
      sampleRateHz,
      prominence: 0,
      rhythmicPulseLikely: false,
      estimatedBpm: null
    };
  }

  let sig = subtractMean(greenSamples);
  sig = detrendLinear(sig);
  const win = hannWindow(n);
  for (let i = 0; i < n; i++) sig[i] *= win[i];

  const half = Math.floor(n / 2);
  const mags: { f: number; mag: number; k: number }[] = [];
  for (let k = 1; k < half; k++) {
    const f = (k * sampleRateHz) / n;
    if (f < HR_LOW_HZ || f > HR_HIGH_HZ) continue;
    mags.push({ f, mag: dftBinMagnitude(sig, k), k });
  }

  if (!mags.length) {
    return {
      sampleCount: n,
      sampleRateHz,
      prominence: 0,
      rhythmicPulseLikely: false,
      estimatedBpm: null
    };
  }

  const sorted = mags.map((m) => m.mag).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || 1e-9;
  let peakMag = 0;
  let peakF: number | null = null;
  for (const m of mags) {
    if (m.mag > peakMag) {
      peakMag = m.mag;
      peakF = m.f;
    }
  }

  const prominence = peakMag / (median + 1e-9);

  // Energía temporal (después de quitar media) — evita “picos” en señales casi nulas.
  let varSig = 0;
  for (let i = 0; i < n; i++) varSig += sig[i] * sig[i];
  varSig /= n;
  const rms = Math.sqrt(varSig);

  // Umbral conservador: prominencia y RMS mínimo en verde (0–255 escala).
  const rhythmicPulseLikely = prominence >= 4.2 && rms >= 0.085 && peakF !== null && peakF >= 0.75 && peakF <= 3.6;

  const estimatedBpm = peakF !== null ? Math.round(peakF * 60) : null;

  return {
    sampleCount: n,
    sampleRateHz,
    prominence,
    rhythmicPulseLikely,
    estimatedBpm
  };
}
