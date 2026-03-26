#!/usr/bin/env node
/**
 * KRONOS Benchmark (Node.js, sin UI)
 *
 * IMPORTANT:
 * - Este script NO analiza binarios (jpg/mp4/wav) por sí mismo.
 * - Consume sidecars JSON generados previamente por KRONOS (p.ej. durante análisis en navegador).
 *
 * Dataset:
 * - tests/dataset/reales
 * - tests/dataset/fakes
 *
 * Sidecar esperado por cada archivo:
 * - <archivo>.kronos.json  (preferido)
 * - <archivo>.analysis.json (fallback)
 *
 * Formato mínimo del sidecar:
 * {
 *   "riskScore": 0-100,
 *   "ensembleVotes": [
 *     { "label": "Forensic", "fake": 80, "real": 20, "applicable": true }
 *   ]
 * }
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const REALS_DIR = path.join(ROOT, 'tests', 'dataset', 'reales');
const FAKES_DIR = path.join(ROOT, 'tests', 'dataset', 'fakes');
const OUT_ERRORS = path.join(ROOT, 'tests', 'results_error.json');

const THRESH_FAKE_HIT = 70; // fakes: >70 = acierto
const THRESH_REAL_HIT = 40; // reales: <40 = acierto

function isMediaFile(name) {
  return /\.(png|jpe?g|webp|gif|bmp|tiff?|mp4|mov|mkv|webm|avi|m4v|3gp|mp3|wav|m4a|aac|ogg|opus|flac|txt|pdf)$/i.test(
    name
  );
}

async function listFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => path.join(dir, e.name))
    .filter((p) => isMediaFile(path.basename(p)));
}

async function readJsonIfExists(p) {
  try {
    const raw = await fs.readFile(p, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function loadSidecarFor(filePath) {
  const preferred = `${filePath}.kronos.json`;
  const fallback = `${filePath}.analysis.json`;
  return (await readJsonIfExists(preferred)) ?? (await readJsonIfExists(fallback));
}

function voteFakeScore(v) {
  const n = Number(v?.fake ?? v?.fakeScore0to100 ?? v?.fakeScore ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function pickBlameSpecialist(ensembleVotes = [], expectedLabel) {
  const votes = Array.isArray(ensembleVotes) ? ensembleVotes : [];
  const applicable = votes.filter((v) => v && (v.applicable ?? true) !== false);
  if (!applicable.length) return 'N/A';

  // Heurística:
  // - si esperábamos FAKE pero salió bajo: culpamos al especialista con fake más bajo
  // - si esperábamos REAL pero salió alto: culpamos al especialista con fake más alto
  const dir = expectedLabel === 'FAKE' ? 'under' : 'over';
  if (dir === 'under') {
    const min = applicable.reduce((best, v) => (voteFakeScore(v) < voteFakeScore(best) ? v : best), applicable[0]);
    return min.label ?? min.key ?? 'unknown';
  }
  const max = applicable.reduce((best, v) => (voteFakeScore(v) > voteFakeScore(best) ? v : best), applicable[0]);
  return max.label ?? max.key ?? 'unknown';
}

function asNumberScore(v) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

async function run() {
  const realFiles = await listFiles(REALS_DIR);
  const fakeFiles = await listFiles(FAKES_DIR);

  const all = [
    ...realFiles.map((p) => ({ file: p, truth: 'REAL' })),
    ...fakeFiles.map((p) => ({ file: p, truth: 'FAKE' }))
  ];

  let total = 0;
  let hits = 0;
  const failures = [];

  for (const item of all) {
    total += 1;
    const sidecar = await loadSidecarFor(item.file);
    if (!sidecar) {
      failures.push({
        file: path.relative(ROOT, item.file),
        truth: item.truth,
        reason: 'MISSING_SIDECAR_JSON',
        blame: 'N/A',
        debug: null
      });
      continue;
    }

    const riskScore = asNumberScore(sidecar.riskScore ?? sidecar.score ?? sidecar.finalFakeScore0to100);
    const votes = sidecar.ensembleVotes ?? sidecar.votes ?? [];
    if (riskScore === null) {
      failures.push({
        file: path.relative(ROOT, item.file),
        truth: item.truth,
        reason: 'INVALID_SCORE_IN_SIDECAR',
        blame: 'N/A',
        debug: { sidecar }
      });
      continue;
    }

    const ok =
      item.truth === 'FAKE' ? riskScore > THRESH_FAKE_HIT : item.truth === 'REAL' ? riskScore < THRESH_REAL_HIT : false;

    if (ok) {
      hits += 1;
      continue;
    }

    failures.push({
      file: path.relative(ROOT, item.file),
      truth: item.truth,
      riskScore,
      reason: 'MISCLASSIFIED',
      blame: pickBlameSpecialist(votes, item.truth),
      debug: { votes }
    });
  }

  const precision = total ? (hits / total) * 100 : 0;

  // Console report
  console.log('\nKRONOS Benchmark');
  console.log('--------------');
  console.table([
    {
      total,
      hits,
      fails: failures.length,
      precisionPct: `${precision.toFixed(2)}%`,
      fakeHit: `FAKE > ${THRESH_FAKE_HIT}`,
      realHit: `REAL < ${THRESH_REAL_HIT}`
    }
  ]);

  if (failures.length) {
    console.log('\nFailures (summary)');
    console.table(
      failures.map((f) => ({
        file: f.file,
        truth: f.truth,
        riskScore: f.riskScore ?? '-',
        blame: f.blame,
        reason: f.reason
      }))
    );
  }

  // Write error export
  await fs.mkdir(path.dirname(OUT_ERRORS), { recursive: true });
  await fs.writeFile(
    OUT_ERRORS,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        thresholds: { fakeHit: THRESH_FAKE_HIT, realHit: THRESH_REAL_HIT },
        summary: { total, hits, fails: failures.length, precisionPct: precision },
        failures
      },
      null,
      2
    ),
    'utf8'
  );

  console.log(`\nWrote: ${path.relative(ROOT, OUT_ERRORS)}`);
  process.exitCode = failures.length ? 1 : 0;
}

run().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exitCode = 2;
});

