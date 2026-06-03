import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const DATASET_DIR = path.join(ROOT, "dataset");
const REPORT_DIR = path.join(DATASET_DIR, "reports");
const API_URL =
  process.env.SCANIT_EVAL_URL || "http://127.0.0.1:5173/api/audit-document";
const FETCH_ATTEMPTS = Math.max(
  1,
  Number(process.env.SCANIT_EVAL_FETCH_ATTEMPTS || 6),
);
const ALLOWED_EXT = new Set([".pdf", ".docx"]);
const MAX_PER_CLASS = Number(process.env.SCANIT_EVAL_MAX_PER_CLASS || 0);
const PARTIAL_EVERY = Math.max(
  1,
  Number(process.env.SCANIT_EVAL_PARTIAL_EVERY || 10),
);
const RUN_MS = Number(process.env.SCANIT_EVAL_RUN_MS || 0); // 0 = sin limite de tiempo

function guessMime(fileName) {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".docx"))
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  return "application/octet-stream";
}

async function listFiles(dir) {
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listFiles(full)));
      continue;
    }
    if (ALLOWED_EXT.has(path.extname(entry.name).toLowerCase())) {
      out.push(full);
    }
  }
  return out;
}

function predictedLabelFromVerdict(verdict) {
  if (verdict === "anomalias_detectadas") return "ia";
  if (verdict === "integro") return "real";
  return "no_concluyente";
}

async function auditFile(filePath) {
  const fileBuffer = await fs.readFile(filePath);
  const fileName = path.basename(filePath);
  const blob = new Blob([fileBuffer], { type: guessMime(fileName) });
  const file = new File([blob], fileName, { type: guessMime(fileName) });
  const form = new FormData();
  form.append("file", file);

  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 45000);
      const response = await fetch(API_URL, {
        method: "POST",
        body: form,
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));
      const raw = await response.text();
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        body = { error: raw.slice(0, 220) };
      }
      return {
        status: response.status,
        ok: response.ok,
        body,
      };
    } catch (err) {
      if (attempt >= FETCH_ATTEMPTS) {
        return {
          status: 0,
          ok: false,
          body: { error: `network_error:${String(err)}` },
        };
      }
      const backoffMs = Math.min(30_000, 1200 * attempt * attempt);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
}

function safeDiv(a, b) {
  return b ? a / b : 0;
}

function computeMetrics(rows) {
  const total = rows.length;
  const failed = rows.filter((r) => !r.ok).length;
  const undecided = rows.filter((r) => r.predicted === "no_concluyente").length;
  const decidedRows = rows.filter((r) => r.predicted !== "no_concluyente");
  const tp = decidedRows.filter(
    (r) => r.expected === "ia" && r.predicted === "ia",
  ).length;
  const tn = decidedRows.filter(
    (r) => r.expected === "real" && r.predicted === "real",
  ).length;
  const fp = decidedRows.filter(
    (r) => r.expected === "real" && r.predicted === "ia",
  ).length;
  const fn = decidedRows.filter(
    (r) => r.expected === "ia" && r.predicted === "real",
  ).length;
  const realTotal = rows.filter((r) => r.expected === "real").length;
  const iaTotal = rows.filter((r) => r.expected === "ia").length;
  return {
    dataset: { total, realTotal, iaTotal, failed, undecided },
    rates: {
      undecidedRate: Number((safeDiv(undecided, total) * 100).toFixed(2)),
      falsePositiveRateReal: Number((safeDiv(fp, realTotal) * 100).toFixed(2)),
      falseNegativeRateIa: Number((safeDiv(fn, iaTotal) * 100).toFixed(2)),
      precisionIa: Number((safeDiv(tp, tp + fp) * 100).toFixed(2)),
      recallIa: Number((safeDiv(tp, tp + fn) * 100).toFixed(2)),
      decidedAccuracy: Number(
        (safeDiv(tp + tn, decidedRows.length) * 100).toFixed(2),
      ),
    },
    confusionDecidedOnly: { tp, tn, fp, fn, decided: decidedRows.length },
    partial: true,
  };
}

async function main() {
  const realDir = path.join(DATASET_DIR, "real");
  const iaDir = path.join(DATASET_DIR, "ia");
  const [realAll, iaAll] = await Promise.all([
    listFiles(realDir),
    listFiles(iaDir),
  ]);
  const realFiles =
    MAX_PER_CLASS > 0 ? realAll.slice(0, MAX_PER_CLASS) : realAll;
  const iaFiles = MAX_PER_CLASS > 0 ? iaAll.slice(0, MAX_PER_CLASS) : iaAll;
  const items = [
    ...realFiles.map((filePath) => ({ filePath, label: "real" })),
    ...iaFiles.map((filePath) => ({ filePath, label: "ia" })),
  ];

  await fs.mkdir(REPORT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(":", "-");
  const partialDetailsPath = path.join(
    REPORT_DIR,
    `eval-partial-${stamp}.json`,
  );
  const partialMetricsPath = path.join(
    REPORT_DIR,
    `eval-partial-metrics-${stamp}.json`,
  );
  const runStarted = Date.now();

  const rows = [];
  for (const item of items) {
    if (RUN_MS > 0 && Date.now() - runStarted > RUN_MS) {
      console.log(
        "\n[eval] Limite de tiempo alcanzado (SCANIT_EVAL_RUN_MS). Guardando parcial.",
      );
      break;
    }
    const startedAt = Date.now();
    const result = await auditFile(item.filePath);
    const elapsedMs = Date.now() - startedAt;
    const verdict = result.body?.verdict ?? null;
    const predicted = predictedLabelFromVerdict(verdict);
    rows.push({
      file: path.relative(DATASET_DIR, item.filePath).replaceAll("\\", "/"),
      expected: item.label,
      predicted,
      verdict,
      anomalyIndex: result.body?.anomalyIndex ?? null,
      anomalyCodes: Array.isArray(result.body?.anomalies)
        ? result.body.anomalies.map((a) => a.code)
        : [],
      confidence: result.body?.confidence?.score ?? null,
      wordCount: result.body?.metrics?.wordCount ?? null,
      editingMinutes: result.body?.metrics?.editingMinutes ?? null,
      ratioWordsPerMinute: result.body?.metrics?.ratioWordsPerMinute ?? null,
      textEntropy: result.body?.metrics?.textEntropy ?? null,
      lexicalDiversity: result.body?.metrics?.lexicalDiversity ?? null,
      syntaxUniformityCoefficient:
        result.body?.metrics?.syntaxUniformityCoefficient ?? null,
      styleConsistencyIndex:
        result.body?.metrics?.styleConsistencyIndex ?? null,
      linguisticState: result.body?.linguisticAiStatus?.state ?? null,
      linguisticReason: result.body?.linguisticAiStatus?.reason ?? null,
      status: result.status,
      ok: result.ok,
      elapsedMs,
      error: result.body?.error ?? null,
    });
    process.stdout.write(`\rAnalizados: ${rows.length}/${items.length}`);
    if (rows.length % PARTIAL_EVERY === 0) {
      const partialMetrics = computeMetrics(rows);
      partialMetrics.partialNote = `Progreso ${rows.length}/${items.length}`;
      await fs.writeFile(
        partialDetailsPath,
        JSON.stringify(rows, null, 2),
        "utf8",
      );
      await fs.writeFile(
        partialMetricsPath,
        JSON.stringify(partialMetrics, null, 2),
        "utf8",
      );
    }
  }
  process.stdout.write("\n");

  const metrics = computeMetrics(rows);
  delete metrics.partial;
  metrics.dataset.expectedTotal = items.length;
  metrics.dataset.completed = rows.length;

  const detailsPath = path.join(REPORT_DIR, `eval-details-${stamp}.json`);
  const metricsPath = path.join(REPORT_DIR, `eval-metrics-${stamp}.json`);
  await fs.writeFile(detailsPath, JSON.stringify(rows, null, 2), "utf8");
  await fs.writeFile(metricsPath, JSON.stringify(metrics, null, 2), "utf8");

  console.log("\n=== METRICAS ===");
  console.log(JSON.stringify(metrics, null, 2));
  console.log(`\nDetalles: ${path.relative(ROOT, detailsPath)}`);
  console.log(`Metricas: ${path.relative(ROOT, metricsPath)}`);

  process.exitCode = metrics.dataset.failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error("Error evaluando dataset:", err);
  process.exit(1);
});
