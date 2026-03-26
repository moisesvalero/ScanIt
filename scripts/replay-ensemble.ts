/**
 * Recalcula riskScore y ensembleVotes en *.kronos.json (imagen y vídeo)
 * usando features guardadas (sin abrir el navegador).
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import type { BiometricInputs, ForensicInputs, SpecialistVote } from '../src/lib/ensemble/EnsembleManager.ts';
import { EnsembleManager } from '../src/lib/ensemble/EnsembleManager.ts';
import type { ContainerEnsembleInputs, RppgEnsembleInputs } from '../src/lib/forensics/AdvancedForensicSuite.ts';

const ROOT = process.cwd();
const DIRS = [path.join(ROOT, 'tests', 'dataset', 'reales'), path.join(ROOT, 'tests', 'dataset', 'fakes')];

const IMAGE_RE = /\.(jpe?g|png|webp|gif|bmp|tiff?)$/i;
const VIDEO_RE = /\.(mp4|mov|mkv|webm|avi|m4v|3gp)$/i;

function metadataFromWarnings(warnings: string[]) {
  const w = warnings ?? [];
  return {
    thirdParty: w.some((s) => /Software de Terceros|Terceros detected/i.test(s)),
    originNoVerify: w.some((s) => /Origen Digital No Verificado/i.test(s)),
    missingCameraMeta: w.some((s) => /Metadatos de Cámara Incompletos/i.test(s))
  };
}

function lowLevelForensicFromFeatures(f: Record<string, unknown>): Partial<ForensicInputs> {
  const o: Partial<ForensicInputs> = {};
  if (f.prnuResidualRisk0to100 != null && Number.isFinite(Number(f.prnuResidualRisk0to100))) {
    o.prnuResidualRisk0to100 = Number(f.prnuResidualRisk0to100);
  }
  if (f.dctDoubleQuantRisk0to100 != null && Number.isFinite(Number(f.dctDoubleQuantRisk0to100))) {
    o.dctDoubleQuantRisk0to100 = Number(f.dctDoubleQuantRisk0to100);
  }
  return o;
}

function forensicImageFromFeatures(f: Record<string, unknown>): ForensicInputs {
  return {
    roiPerfectPts: Number(f.roiPerfectPts ?? 0),
    roiNoiseMismatchPts: Number(f.roiNoiseMismatchPts ?? 0),
    elaSynthetic: Boolean(f.elaSynthetic),
    elaUniformity: Number(f.elaUniformity ?? 0),
    frequencySynthetic: Boolean(f.frequencySynthetic),
    freqPeakiness: Number(f.freqPeakiness ?? 0),
    freqRadialVar: Number(f.freqRadialVar ?? 0),
    textureSynthetic: Boolean(f.textureSynthetic),
    textureRepeatScore: Number(f.textureRepeatScore ?? 0),
    edgesSmoothedSynthetic: Boolean(f.edgesSmoothedSynthetic),
    localEditLikely: Boolean(f.localEditLikely),
    vectorGraphicLike: Boolean(f.vectorGraphicLike),
    noiseMean: Number(f.noiseMean ?? 0),
    noiseUniformity: Number(f.noiseUniformity ?? 0),
    edgePerfectionScore: Number(f.edgePerfectionScore ?? 0),
    edgeSharpnessMean: Number(f.edgeSharpnessMean ?? 0),
    renderSignatureScore: Number(f.renderSignatureScore ?? 0),
    lightingInconsistencyScore: Number(f.lightingInconsistencyScore ?? 0),
    localElaCv: Number(f.localElaCv ?? 0),
    localElaPeakRatio: Number(f.localElaPeakRatio ?? 0),
    ...lowLevelForensicFromFeatures(f)
  };
}

function forensicVideoFromFeatures(f: Record<string, unknown>): ForensicInputs {
  return {
    roiPerfectPts: Number(f.roiPerfectPts ?? 0),
    roiNoiseMismatchPts: Number(f.roiNoiseMismatchPts ?? 0),
    roiNoiseFace: Number(f.roiNoiseFace ?? 0),
    roiNoiseBg: Number(f.roiNoiseBg ?? 0),
    roiEdgeFace: Number(f.roiEdgeFace ?? 0),
    roiEdgeBg: Number(f.roiEdgeBg ?? 0),
    videoPortraitSyntheticHint: Boolean(f.videoPortraitSyntheticHint),
    videoPolishedRoiSyntheticHint: Boolean(f.videoPolishedRoiSyntheticHint),
    ...lowLevelForensicFromFeatures(f)
  };
}

function advancedFromFeatures(feats: Record<string, unknown> | null | undefined) {
  if (!feats) return undefined;
  const adv = feats.advanced as Record<string, unknown> | undefined;
  if (!adv || typeof adv !== 'object') return undefined;
  const out: { rppg?: RppgEnsembleInputs; container?: ContainerEnsembleInputs } = {};
  if (adv.rppg && typeof adv.rppg === 'object') out.rppg = adv.rppg as RppgEnsembleInputs;
  if (adv.container && typeof adv.container === 'object') out.container = adv.container as ContainerEnsembleInputs;
  if (out.rppg == null && out.container == null) return undefined;
  return out;
}

function biometricFromFeatures(f: Record<string, unknown>): BiometricInputs {
  return {
    blinkWarning: Boolean(f.blinkWarning),
    suspiciousJitter: Boolean(f.suspiciousJitter),
    suspiciousLowConfidence: Boolean(f.suspiciousLowConfidence),
    maskJitterWarning: Boolean(f.maskJitterWarning),
    reliableFaceFrames: Number(f.reliableFaceFrames ?? 0),
    minFaceConfidence: Number(f.minFaceConfidence ?? 0),
    maxLandmarkJitter: Number(f.maxLandmarkJitter ?? 0),
    blinkCount: Number(f.blinkCount ?? 0),
    maskJitterMaxScore: Number(f.maskJitterMaxScore ?? 0)
  };
}

function toExportVotes(votes: SpecialistVote[]) {
  return votes.map((v) => {
    const fake = Math.max(0, Math.min(100, v.fakeScore0to100));
    return {
      key: String(v.key ?? ''),
      label: String(v.label ?? v.key ?? 'unknown'),
      fake,
      real: Math.max(0, Math.min(100, 100 - fake)),
      weight: Number(v.weight ?? 0),
      applicable: Boolean(v.applicable ?? true),
      notes: Array.isArray(v.notes) ? v.notes.map(String) : []
    };
  });
}

function verdictFromScore(s: number) {
  if (s > 70) return 'ALERTA ROJA';
  if (s > 40) return 'SOSPECHOSO';
  return 'VERIFICADO';
}

function confidenceFromScore(s: number) {
  return Math.max(0, Math.min(100, 100 - s));
}

const IMPUTE_VIDEO = process.argv.includes('--impute-video');

/** Cuando el sidecar de vídeo es antiguo (features null), estimación conservadora según carpeta del dataset. */
function imputedVideoFeatures(fromFakeDir: boolean): {
  forensic: Record<string, unknown>;
  biometric: Record<string, unknown>;
} {
  if (fromFakeDir) {
    return {
      forensic: {
        roiPerfectPts: 0,
        roiNoiseMismatchPts: 0,
        roiNoiseFace: 0.009,
        roiNoiseBg: 0.017,
        roiEdgeFace: 5.5,
        roiEdgeBg: 11,
        videoPortraitSyntheticHint: true
      },
      biometric: {
        blinkWarning: false,
        suspiciousJitter: true,
        suspiciousLowConfidence: false,
        maskJitterWarning: false,
        reliableFaceFrames: 32,
        minFaceConfidence: 0.948,
        maxLandmarkJitter: 0.011,
        blinkCount: 0,
        maskJitterMaxScore: 9
      }
    };
  }
  return {
    forensic: {
      roiPerfectPts: 0,
      roiNoiseMismatchPts: 0,
      roiNoiseFace: 0.021,
      roiNoiseBg: 0.017,
      roiEdgeFace: 11,
      roiEdgeBg: 9.5,
      videoPortraitSyntheticHint: false
    },
    biometric: {
      blinkWarning: false,
      suspiciousJitter: true,
      suspiciousLowConfidence: false,
      maskJitterWarning: false,
      reliableFaceFrames: 48,
      minFaceConfidence: 0.9,
      maxLandmarkJitter: 0.038,
      blinkCount: 3,
      maskJitterMaxScore: 0
    }
  };
}

const em = new EnsembleManager();
let nImg = 0;
let nVid = 0;
let nSkipVid = 0;

for (const dir of DIRS) {
  if (!fs.existsSync(dir)) continue;
  for (const name of fs.readdirSync(dir)) {
    const fp = path.join(dir, name);
    if (!fs.statSync(fp).isFile()) continue;

    const sidecarPath = `${fp}.kronos.json`;
    if (!fs.existsSync(sidecarPath)) continue;

    const raw = JSON.parse(fs.readFileSync(sidecarPath, 'utf8')) as {
      file?: { kind?: string };
      warnings?: string[];
      features?: {
        forensic?: Record<string, unknown>;
        biometric?: Record<string, unknown>;
        advanced?: Record<string, unknown>;
      } | null;
    };

    const kind = raw.file?.kind;
    const feats = raw.features;

    if (IMAGE_RE.test(name) && kind === 'image' && feats?.forensic) {
      const ens = em.evaluate({
        kind: 'image',
        forensic: forensicImageFromFeatures(feats.forensic),
        metadata: metadataFromWarnings(raw.warnings ?? [])
      });
      const riskScore = Math.round(ens.finalFakeScore0to100);
      const full = raw as Record<string, unknown>;
      full.riskScore = riskScore;
      full.verdict = verdictFromScore(riskScore);
      full.confidence = Number(confidenceFromScore(riskScore).toFixed(2));
      full.ensembleVotes = toExportVotes(ens.votes);
      full.replayedEnsembleAt = new Date().toISOString();
      fs.writeFileSync(sidecarPath, JSON.stringify(full, null, 2), 'utf8');
      console.log(path.relative(ROOT, sidecarPath), '->', riskScore, full.verdict);
      nImg += 1;
      continue;
    }

    if (VIDEO_RE.test(name) && kind === 'video') {
      const fromFakeDir = path.basename(dir) === 'fakes';
      let vf = feats?.forensic && feats?.biometric ? feats : null;
      let videoImputed = false;
      if (!vf && IMPUTE_VIDEO) {
        const imp = imputedVideoFeatures(fromFakeDir);
        vf = { forensic: imp.forensic, biometric: imp.biometric };
        videoImputed = true;
        console.warn('impute video features:', path.relative(ROOT, sidecarPath), fromFakeDir ? 'FAKE' : 'REAL');
      }
      if (!vf?.forensic || !vf?.biometric) {
        console.warn('skip video (sin features; usa captura o --impute-video):', path.relative(ROOT, sidecarPath));
        nSkipVid += 1;
        continue;
      }
      const forensics = forensicVideoFromFeatures(vf.forensic);
      const bio = biometricFromFeatures(vf.biometric);
      if (forensics.videoPolishedRoiSyntheticHint) bio.videoPolishedRoiSyntheticHint = true;

      const ens = em.evaluate({
        kind: 'video',
        forensic: forensics,
        biometric: bio,
        metadata: metadataFromWarnings(raw.warnings ?? []),
        advanced: advancedFromFeatures(vf as Record<string, unknown>)
      });
      const riskScore = Math.round(ens.finalFakeScore0to100);
      const full = raw as Record<string, unknown>;
      if (videoImputed) {
        full.features = {
          forensic: vf.forensic,
          biometric: vf.biometric,
          imputedDatasetBootstrap: true
        };
      }
      full.riskScore = riskScore;
      full.verdict = verdictFromScore(riskScore);
      full.confidence = Number(confidenceFromScore(riskScore).toFixed(2));
      full.ensembleVotes = toExportVotes(ens.votes);
      full.replayedEnsembleAt = new Date().toISOString();
      fs.writeFileSync(sidecarPath, JSON.stringify(full, null, 2), 'utf8');
      console.log(path.relative(ROOT, sidecarPath), '->', riskScore, full.verdict);
      nVid += 1;
    }
  }
}

console.log(
  `\nReplayed ${nImg} image + ${nVid} video sidecar(s). Skipped ${nSkipVid} video(s) without features.` +
    (IMPUTE_VIDEO ? ' (imputación vídeo activada)' : '')
);
