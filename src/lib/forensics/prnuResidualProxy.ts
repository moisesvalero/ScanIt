/**
 * Proxy de huella PRNU / ruido residual: no sustituye a PRNU con patrón de referencia del sensor.
 * Extrae ruido tipo high-pass (contenido − suavizado) y contrasta estructura vs ruido casi gaussiano/plano
 * frecuente en síntesis IA / filtrado agresivo.
 */

export type PrnuResidualMetrics = {
  excessKurtosis: number;
  lag1CorrAbs: number;
  blockVarianceCv: number;
  residualStd: number;
};

export type PrnuResidualResult = {
  /** 0 = plausible sensor/pipeline real, 100 = muy compatible con ruido “matemático” / sin textura de sensor */
  risk0to100: number;
  metrics: PrnuResidualMetrics;
  notes: string[];
};

function boxBlur5InPlace(src: Float32Array, width: number, height: number, out: Float32Array) {
  const tmp = new Float32Array(src.length);
  const k = [0.0625, 0.25, 0.375, 0.25, 0.0625];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let s = 0;
      for (let dx = -2; dx <= 2; dx++) {
        const xx = Math.max(0, Math.min(width - 1, x + dx));
        s += src[y * width + xx] * k[dx + 2];
      }
      tmp[y * width + x] = s;
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let s = 0;
      for (let dy = -2; dy <= 2; dy++) {
        const yy = Math.max(0, Math.min(height - 1, y + dy));
        s += tmp[yy * width + x] * k[dy + 2];
      }
      out[y * width + x] = s;
    }
  }
}

export function analyzePrnuResidualProxy(gray: Float32Array, width: number, height: number): PrnuResidualResult {
  const notes: string[] = [];
  const n = width * height;
  if (n < 4096 || width < 64 || height < 64) {
    return {
      risk0to100: 0,
      metrics: { excessKurtosis: 0, lag1CorrAbs: 0, blockVarianceCv: 0, residualStd: 0 },
      notes: ['Muestra demasiado pequeña para PRNU proxy.']
    };
  }

  const blurred = new Float32Array(n);
  boxBlur5InPlace(gray, width, height, blurred);

  const residual = new Float32Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    residual[i] = gray[i] - blurred[i];
    sum += residual[i];
  }
  const mean = sum / n;
  let varSum = 0;
  for (let i = 0; i < n; i++) {
    const d = residual[i] - mean;
    varSum += d * d;
  }
  const variance = n > 1 ? varSum / (n - 1) : 0;
  const std = Math.sqrt(Math.max(variance, 1e-12));

  let m4 = 0;
  let lag1 = 0;
  let lagC = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const z = (residual[y * width + x] - mean) / std;
      m4 += z * z * z * z;
      if (x < width - 1) {
        const z2 = (residual[y * width + x + 1] - mean) / std;
        lag1 += z * z2;
        lagC++;
      }
    }
  }
  const excessKurtosis = n ? m4 / n - 3 : 0;
  const lag1CorrAbs = lagC ? Math.abs(lag1 / lagC) : 0;

  const bw = 16;
  const bh = 16;
  const blockVars: number[] = [];
  for (let y0 = 2; y0 + bh <= height - 2; y0 += bh) {
    for (let x0 = 2; x0 + bw <= width - 2; x0 += bw) {
      let bm = 0;
      let cnt = 0;
      for (let y = y0; y < y0 + bh; y++) {
        for (let x = x0; x < x0 + bw; x++) {
          bm += residual[y * width + x];
          cnt++;
        }
      }
      bm /= Math.max(1, cnt);
      let bv = 0;
      for (let y = y0; y < y0 + bh; y++) {
        for (let x = x0; x < x0 + bw; x++) {
          const d = residual[y * width + x] - bm;
          bv += d * d;
        }
      }
      bv /= Math.max(1, cnt - 1);
      blockVars.push(bv);
    }
  }
  const bvMean = blockVars.length ? blockVars.reduce((a, b) => a + b, 0) / blockVars.length : 0;
  const bvVar =
    blockVars.length > 1
      ? blockVars.reduce((acc, v) => acc + (v - bvMean) * (v - bvMean), 0) / (blockVars.length - 1)
      : 0;
  const blockVarianceCv = bvMean > 1e-10 ? Math.sqrt(Math.max(0, bvVar)) / bvMean : 0;

  // Riesgo: curtosis cercana a gaussiana + correlación espacial casi nula + bloques de varianza muy homogénea
  let risk = 0;
  const gaussLike = excessKurtosis > -0.55 && excessKurtosis < 0.65;
  const flatSpatial = lag1CorrAbs < 0.032;
  const uniformBlocks = blockVarianceCv < 0.42;

  if (gaussLike && flatSpatial && uniformBlocks) {
    risk += 38;
    notes.push('Ruido residual muy compatible con distribución gaussiana/espacialmente blanca (proxy IA/filtro).');
  } else if (gaussLike && flatSpatial) {
    risk += 24;
    notes.push('Residual casi gaussiano y poca correlación local (revisar pipeline sintético).');
  }

  if (std < 0.004 && gray.length > 5000) {
    risk += 18;
    notes.push('Varianza residual muy baja (superficie excesivamente “limpia”).');
  }

  if (excessKurtosis > 2.2 && lag1CorrAbs > 0.06) {
    risk = Math.max(0, risk - 22);
    notes.push('Colas pesadas y correlación local: más compatible con compresión/sensor que con ruido i.i.d.');
  }

  return {
    risk0to100: Math.max(0, Math.min(100, risk)),
    metrics: {
      excessKurtosis,
      lag1CorrAbs,
      blockVarianceCv,
      residualStd: std
    },
    notes
  };
}
