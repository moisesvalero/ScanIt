/**
 * Proxy de doble cuantificación JPEG vía bloques 8×8 DCT-II en luminancia.
 * Sin leer tablas del bitstream: busca periodicidad / picos secundarios en histogramas de coef. AC,
 * típico de doble compresión con factores distintos (no equivale a “tabla ≠ cámara” literal).
 */

export type DctDoubleQuantMetrics = {
  acHistPeakRatio: number;
  acHistAutocorrMax: number;
  blocksSampled: number;
};

export type DctDoubleQuantResult = {
  /** 0 = poca evidencia de doble Q, 100 = fuerte indicio */
  risk0to100: number;
  metrics: DctDoubleQuantMetrics;
  notes: string[];
};

const COS8 = (() => {
  const c = new Float64Array(8 * 8);
  for (let u = 0; u < 8; u++) {
    for (let x = 0; x < 8; x++) {
      c[u * 8 + x] = Math.cos(((2 * x + 1) * u * Math.PI) / 16);
    }
  }
  return c;
})();

const ALPHA = (u: number) => (u === 0 ? 1 / Math.sqrt(8) : Math.sqrt(2 / 8));

function dct8x8Block(patch: Float64Array): void {
  const temp = new Float64Array(64);
  for (let u = 0; u < 8; u++) {
    for (let y = 0; y < 8; y++) {
      let s = 0;
      for (let x = 0; x < 8; x++) {
        s += patch[y * 8 + x] * COS8[u * 8 + x];
      }
      temp[u * 8 + y] = ALPHA(u) * s;
    }
  }
  for (let u = 0; u < 8; u++) {
    for (let v = 0; v < 8; v++) {
      let s = 0;
      for (let y = 0; y < 8; y++) {
        s += temp[u * 8 + y] * COS8[v * 8 + y];
      }
      patch[u * 8 + v] = ALPHA(v) * s;
    }
  }
}

export function analyzeDctDoubleQuantization(gray: Float32Array, width: number, height: number): DctDoubleQuantResult {
  const notes: string[] = [];
  if (width < 64 || height < 64) {
    return {
      risk0to100: 0,
      metrics: { acHistPeakRatio: 0, acHistAutocorrMax: 0, blocksSampled: 0 },
      notes: ['Imagen demasiado pequeña para DCT 8×8.']
    };
  }

  const patch = new Float64Array(64);
  const acVals: number[] = [];

  let blocks = 0;
  for (let y0 = 0; y0 + 8 <= height; y0 += 8) {
    for (let x0 = 0; x0 + 8 <= width; x0 += 8) {
      if ((blocks & 1) === 0) {
        let m = 0;
        for (let y = 0; y < 8; y++) {
          for (let x = 0; x < 8; x++) {
            const v = gray[(y0 + y) * width + (x0 + x)];
            patch[y * 8 + x] = v;
            m += v;
          }
        }
        m /= 64;
        for (let i = 0; i < 64; i++) patch[i] -= m;
        dct8x8Block(patch);
        // AC (1,0) y (0,1) — sensibles a artefactos de recompresión
        acVals.push(patch[1 * 8 + 0], patch[0 * 8 + 1]);
      }
      blocks++;
    }
  }

  if (acVals.length < 80) {
    return {
      risk0to100: 0,
      metrics: { acHistPeakRatio: 0, acHistAutocorrMax: 0, blocksSampled: blocks },
      notes: ['Pocos bloques AC muestreados.']
    };
  }

  let minV = acVals[0];
  let maxV = acVals[0];
  for (const v of acVals) {
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }
  const span = maxV - minV + 1e-9;
  const bins = 96;
  const hist = new Float32Array(bins);
  for (const v of acVals) {
    const t = (v - minV) / span;
    const b = Math.min(bins - 1, Math.max(0, Math.floor(t * bins)));
    hist[b] += 1;
  }
  let hsum = 0;
  for (let i = 0; i < bins; i++) hsum += hist[i];
  if (hsum < 1e-6) {
    return {
      risk0to100: 0,
      metrics: { acHistPeakRatio: 0, acHistAutocorrMax: 0, blocksSampled: blocks },
      notes: []
    };
  }
  for (let i = 0; i < bins; i++) hist[i] /= hsum;

  let hmax = 0;
  let hmean = 0;
  for (let i = 0; i < bins; i++) {
    if (hist[i] > hmax) hmax = hist[i];
    hmean += hist[i];
  }
  hmean /= bins;
  const acHistPeakRatio = hmax / (hmean + 1e-9);

  let acMax = 0;
  for (let lag = 2; lag <= 28; lag++) {
    let c0 = 0;
    for (let i = 0; i < bins - lag; i++) {
      c0 += hist[i] * hist[i + lag];
    }
    if (c0 > acMax) acMax = c0;
  }

  const acHistAutocorrMax = acMax;

  let risk = 0;
  if (acHistAutocorrMax > 0.014 && acHistPeakRatio > 2.8) {
    risk += 42;
    notes.push('Periodicidad en histograma DCT AC compatible con doble cuantificación.');
  } else if (acHistAutocorrMax > 0.009 && acHistPeakRatio > 2.35) {
    risk += 26;
    notes.push('Indicios moderados de doble compresión en coeficientes DCT.');
  }

  if (acHistPeakRatio > 3.6 && acHistAutocorrMax > 0.006) {
    risk += 14;
    notes.push('Histograma AC muy pico (recompresión / export no lineal).');
  }

  return {
    risk0to100: Math.max(0, Math.min(100, risk)),
    metrics: {
      acHistPeakRatio,
      acHistAutocorrMax,
      blocksSampled: blocks
    },
    notes
  };
}
