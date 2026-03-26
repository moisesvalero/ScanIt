/**
 * Suite forense avanzada: rPPG (física) + integridad de contenedor MP4.
 * Los analistas del ensemble consumen los tipos `RppgEnsembleInputs` / `ContainerEnsembleInputs`.
 */

import type { RppgAnalysisResult } from './rppgSignal';
import type { Mp4ForensicResult } from './mp4BoxForensics';

export { analyzeRppgGreenSeries, meanGreenCheekRoi, type RppgAnalysisResult } from './rppgSignal';
export { scanMp4Container, type Mp4ForensicResult } from './mp4BoxForensics';

export type RppgEnsembleInputs = {
  /** Muestras de verde (ROI mejillas) a fs constante */
  greenSamples?: number[];
  sampleRateHz?: number;
  /** Si ya se calculó fuera (p. ej. replay desde JSON) */
  precomputed?: RppgAnalysisResult | null;
};

export type ContainerEnsembleInputs = {
  /** Buffer MP4 o cabecera */
  buffer?: ArrayBuffer | null;
  /** Si ya se escaneó */
  precomputed?: Mp4ForensicResult | null;
};
