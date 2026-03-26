import type { RequestHandler } from './$types';
import mammoth from 'mammoth';
// Nota: evitamos pdf-parse porque puede mezclar versiones de pdf.js (API/Worker) y fallar con mismatch.
import JSZip from 'jszip';
import Groq from 'groq-sdk';
import { env } from '$env/dynamic/private';

type GroqLinguisticVerdict = {
  suspicionPercent: number;
  reasons: string[];
};

type LinguisticAiStatus = {
  state: 'ok' | 'omitted' | 'error';
  reason: string;
};

type Severity = 'green' | 'amber' | 'red';

type Anomaly = {
  code: string;
  severity: Severity;
  message: string;
};

function xmlDecode(value: string) {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'");
}

function xmlTag(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match?.[1] ? xmlDecode(match[1].trim()) : null;
}

function countWords(text: string) {
  const tokens = text.match(/\b[\p{L}\p{N}'-]+\b/gu);
  return tokens?.length ?? 0;
}

function calcTextEntropy(text: string) {
  if (!text) return 0;
  const clean = text.toLowerCase().replace(/[^a-z0-9áéíóúüñ\s]/gi, ' ');
  const freq = new Map<string, number>();
  let total = 0;
  for (const ch of clean) {
    if (!ch.trim()) continue;
    total += 1;
    freq.set(ch, (freq.get(ch) ?? 0) + 1);
  }
  if (!total) return 0;
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / total;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function sentenceUniformity(text: string) {
  const sentences = text
    .split(/[.!?]+/g)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => countWords(s));
  if (sentences.length < 6) return null;
  const mean = sentences.reduce((a, b) => a + b, 0) / sentences.length;
  if (!mean) return null;
  const variance = sentences.reduce((a, b) => a + (b - mean) ** 2, 0) / sentences.length;
  const std = Math.sqrt(variance);
  return {
    mean,
    coefficient: std / mean
  };
}

async function parseDocx(buffer: Buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const coreXml = (await zip.file('docProps/core.xml')?.async('text')) ?? '';
  const appXml = (await zip.file('docProps/app.xml')?.async('text')) ?? '';
  const text = (await mammoth.extractRawText({ buffer })).value ?? '';

  const wordsFromText = countWords(text);
  const wordsFromProps = Number(xmlTag(appXml, 'Words') ?? 0) || 0;
  const wordCount = Math.max(wordsFromText, wordsFromProps);
  const totalTimeMinutes = Number(xmlTag(appXml, 'TotalTime') ?? 0) || null;

  const created = xmlTag(coreXml, 'dcterms:created');
  const modified = xmlTag(coreXml, 'dcterms:modified');
  const creator = xmlTag(coreXml, 'dc:creator');
  const lastModifiedBy = xmlTag(coreXml, 'cp:lastModifiedBy');
  const application = xmlTag(appXml, 'Application');
  const company = xmlTag(appXml, 'Company');

  return {
    text,
    wordCount,
    editingMinutes: totalTimeMinutes,
    pageCount: null as number | null,
    metadata: {
      created,
      modified,
      creator,
      lastModifiedBy,
      application,
      company
    }
  };
}

async function parsePdf(buffer: Buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    stopAtErrors: false,
    // Importante: en server evitamos Worker (y sus mismatches).
    disableWorker: true,
    disableAutoFetch: true,
    disableStream: true,
    isEvalSupported: false
  } as any);

  const pdf = await loadingTask.promise;

  let metaInfo: any = {};
  try {
    const meta = await pdf.getMetadata();
    metaInfo = meta?.info ?? {};
  } catch {
    metaInfo = {};
  }

  let text = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const parts = (content.items as any[])
      .map((it) => (typeof it?.str === 'string' ? it.str : ''))
      .filter(Boolean);
    text += parts.join(' ') + '\n';
  }

  const wordCount = countWords(text);

  const created = typeof metaInfo.CreationDate === 'string' ? metaInfo.CreationDate : null;
  const modified = typeof metaInfo.ModDate === 'string' ? metaInfo.ModDate : null;
  const creator = typeof metaInfo.Creator === 'string' ? metaInfo.Creator : null;
  const producer = typeof metaInfo.Producer === 'string' ? metaInfo.Producer : null;

  let editingMinutes: number | null = null;
  if (created && modified) {
    const c = Date.parse(created.replace(/^D:/, ''));
    const m = Date.parse(modified.replace(/^D:/, ''));
    if (Number.isFinite(c) && Number.isFinite(m) && m > c) {
      editingMinutes = Math.round((m - c) / 60000);
    }
  }

  return {
    text,
    wordCount,
    editingMinutes,
    pageCount: pdf.numPages,
    metadata: {
      created,
      modified,
      creator,
      application: producer,
      producer
    }
  };
}

function buildAnomalies(input: {
  extension: 'docx' | 'pdf';
  wordCount: number;
  editingMinutes: number | null;
  entropy: number;
  uniformity: { mean: number; coefficient: number } | null;
  metadata: Record<string, unknown>;
}) {
  const anomalies: Anomaly[] = [];
  const ratio = input.editingMinutes && input.editingMinutes > 0 ? input.wordCount / input.editingMinutes : null;
  const app = String(input.metadata.application ?? '').toLowerCase();
  const producer = String(input.metadata.producer ?? '').toLowerCase();

  if (input.extension === 'pdf' && input.wordCount < 40) {
    anomalies.push({
      code: 'PDF_NON_TEXTUAL_CONTENT',
      severity: 'amber',
      message:
        'Contenido textual insuficiente: posible escaneo no textual, dibujo o evidencia no academica para analisis lingüistico.'
    });
  }

  if (input.wordCount > 1000 && input.editingMinutes !== null && input.editingMinutes < 15) {
    anomalies.push({
      code: 'TEXT_INJECTION_RED',
      severity: 'red',
      message:
        'Alerta Roja: documento extenso con tiempo de edicion anormalmente bajo (posible inyeccion masiva de texto).'
    });
  }

  if (app.includes('pandoc') || producer.includes('pandoc') || app.includes('google docs') || producer.includes('google docs')) {
    anomalies.push({
      code: 'SUSPICIOUS_CREATOR_TOOL',
      severity: 'amber',
      message: 'Origen de creacion/exportacion atipico para entrega academica local (Pandoc/Google Docs).'
    });
  }

  if (ratio !== null && ratio > 120) {
    anomalies.push({
      code: 'EXTREME_WORD_RATE',
      severity: 'amber',
      message: `Ritmo de escritura muy elevado (${ratio.toFixed(1)} palabras/minuto).`
    });
  }

  if (input.uniformity && input.uniformity.coefficient < 0.34 && input.wordCount > 350) {
    anomalies.push({
      code: 'UNIFORM_SYNTAX_PATTERN',
      severity: 'amber',
      message: 'Patron sintactico inusualmente uniforme; indicador compatible con generacion automatizada.'
    });
  }

  if (input.entropy < 3.2 && input.wordCount > 350) {
    anomalies.push({
      code: 'LOW_TEXT_ENTROPY',
      severity: 'amber',
      message: 'Entropia textual baja para la longitud observada.'
    });
  }

  const redCount = anomalies.filter((a) => a.severity === 'red').length;
  const amberCount = anomalies.filter((a) => a.severity === 'amber').length;

  let verdict: 'integro' | 'anomalias_detectadas' | 'no_concluyente' = 'no_concluyente';
  if (redCount > 0 || amberCount >= 2) verdict = 'anomalias_detectadas';
  else if (amberCount === 0 && input.wordCount > 150) verdict = 'integro';

  return {
    anomalies,
    anomalyIndex: redCount * 3 + amberCount,
    ratioWordsPerMinute: ratio,
    verdict
  };
}

function clamp01to100(n: number) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(err: unknown) {
  const e = err as any;
  const status = Number(e?.status ?? e?.response?.status ?? 0);
  const msg = String(e?.message ?? '').toLowerCase();
  return status === 429 || msg.includes('rate limit') || msg.includes('too many requests') || msg.includes('429');
}

function trimToTokenLimit(text: string, tokenLimit = 2000) {
  const tokens = text.match(/\S+/g) ?? [];
  if (tokens.length <= tokenLimit) return text;
  return tokens.slice(0, tokenLimit).join(' ');
}

function rebuildDecision(anomalies: Anomaly[], wordCount: number, ratioWordsPerMinute: number | null) {
  const redCount = anomalies.filter((a) => a.severity === 'red').length;
  const amberCount = anomalies.filter((a) => a.severity === 'amber').length;

  let verdict: 'integro' | 'anomalias_detectadas' | 'no_concluyente' = 'no_concluyente';
  if (redCount > 0 || amberCount >= 2) verdict = 'anomalias_detectadas';
  else if (amberCount === 0 && wordCount > 150) verdict = 'integro';

  return {
    anomalies,
    anomalyIndex: redCount * 3 + amberCount,
    ratioWordsPerMinute,
    verdict
  };
}

async function groqLinguisticAudit(text: string): Promise<GroqLinguisticVerdict | null> {
  const key = env.GROQ_API_KEY || process.env.GROQ_API_KEY;
  if (!key) return null;

  const trimmed = text.trim();
  if (!trimmed) return null;

  // Ahorro de cuota: enviamos aprox. solo los primeros 2.000 tokens.
  const sample = trimToTokenLimit(trimmed, 2000);

  const groq = new Groq({ apiKey: key });
  const system =
    'Eres un perito lingüístico forense. Analiza el texto buscando patrones de IA: falta de errores naturales, ritmo monótono y conectores genéricos. Devuelve un JSON con: un porcentaje de sospecha y 3 razones técnicas de tu veredicto.';

  let resp: any = null;
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      resp = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        temperature: 0.2,
        max_tokens: 260,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          {
            role: 'user',
            content:
              'Texto a analizar (puede estar truncado):\n' +
              sample +
              '\n\nResponde SOLO con JSON con claves: suspicionPercent (0-100) y reasons (array de 3 strings).'
          }
        ]
      });
      break;
    } catch (e) {
      if (!isRateLimitError(e) || attempt >= maxAttempts) throw e;
      const waitMs = 5000 * 2 ** (attempt - 1); // 5s, 10s...
      await sleep(waitMs);
    }
  }

  const content = resp?.choices?.[0]?.message?.content ?? '';
  if (!content) return null;

  let parsed: any;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }

  const suspicionPercent = clamp01to100(Number(parsed?.suspicionPercent ?? parsed?.porcentaje ?? 0));
  const reasonsRaw = Array.isArray(parsed?.reasons) ? parsed.reasons : [];
  const reasons = reasonsRaw.map(String).filter(Boolean).slice(0, 3);
  while (reasons.length < 3) reasons.push('No concluyente: evidencia lingüística insuficiente en la muestra.');

  return { suspicionPercent, reasons };
}

export const POST: RequestHandler = async ({ request }) => {
  const form = await request.formData();
  const file = form.get('file');
  if (!(file instanceof File)) {
    return new Response(JSON.stringify({ error: 'Archivo no valido.' }), { status: 400 });
  }

  const extension = file.name.toLowerCase().endsWith('.docx')
    ? 'docx'
    : file.name.toLowerCase().endsWith('.pdf')
      ? 'pdf'
      : null;

  if (!extension) {
    return new Response(JSON.stringify({ error: 'Formato no soportado. Usa .docx o .pdf.' }), { status: 400 });
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const parsed = extension === 'docx' ? await parseDocx(buffer) : await parsePdf(buffer);
    const entropy = calcTextEntropy(parsed.text);
    const uniformity = sentenceUniformity(parsed.text);
    const decision = buildAnomalies({
      extension,
      wordCount: parsed.wordCount,
      editingMinutes: parsed.editingMinutes,
      entropy,
      uniformity,
      metadata: parsed.metadata
    });
    let linguisticAi: GroqLinguisticVerdict | null = null;
    let linguisticAiStatus: LinguisticAiStatus = {
      state: 'omitted',
      reason: 'No se ejecuto el analisis lingüistico.'
    };
    const hasGroqKey = Boolean(env.GROQ_API_KEY || process.env.GROQ_API_KEY);
    const trimmedText = parsed.text.trim();

    if (!hasGroqKey) {
      linguisticAiStatus = {
        state: 'omitted',
        reason: 'GROQ_API_KEY ausente en el entorno del servidor.'
      };
    } else if (!trimmedText || parsed.wordCount < 40) {
      linguisticAiStatus = {
        state: 'omitted',
        reason: 'Texto insuficiente o no extraible del documento (PDF escaneado, dibujo o imagen no textual).'
      };
    } else {
      try {
        linguisticAi = await groqLinguisticAudit(parsed.text);
        if (linguisticAi) {
          linguisticAiStatus = {
            state: 'ok',
            reason: `Analisis completado. Sospecha estimada: ${linguisticAi.suspicionPercent.toFixed(0)}%.`
          };
        } else {
          linguisticAiStatus = {
            state: 'omitted',
            reason: 'Groq no devolvio contenido JSON valido para esta muestra.'
          };
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (isRateLimitError(e)) {
          linguisticAiStatus = {
            state: 'error',
            reason: 'Servidores saturados, reintentando en 5 segundos...'
          };
          // Ya se aplicó backoff en servidor; dejamos mensaje elegante para telemetría.
          linguisticAi = null;
        } else {
          linguisticAiStatus = {
            state: 'error',
            reason: `Fallo en Groq: ${msg.slice(0, 140)}`
          };
        }
      }
    }

    // La señal lingüística no debe marcar "Íntegro" cuando la sospecha es alta.
    const mergedAnomalies = [...decision.anomalies];
    if (linguisticAi && parsed.wordCount >= 120) {
      if (linguisticAi.suspicionPercent >= 85) {
        mergedAnomalies.push({
          code: 'LINGUISTIC_AI_VERY_HIGH',
          severity: 'red',
          message: `Sospecha lingüística muy alta (${linguisticAi.suspicionPercent.toFixed(
            0
          )}%) compatible con redacción asistida/generada por IA.`
        });
      } else if (linguisticAi.suspicionPercent >= 70) {
        mergedAnomalies.push({
          code: 'LINGUISTIC_AI_HIGH',
          severity: 'amber',
          message: `Sospecha lingüística elevada (${linguisticAi.suspicionPercent.toFixed(
            0
          )}%); se desaconseja clasificar el documento como íntegro.`
        });
      }
    }
    const finalDecision =
      mergedAnomalies.length === decision.anomalies.length
        ? decision
        : rebuildDecision(mergedAnomalies, parsed.wordCount, decision.ratioWordsPerMinute);

    return new Response(
      JSON.stringify({
        suite: 'Jamalajam',
        mode: 'document_audit',
        fileName: file.name,
        extension,
        hashPendingClientSide: true,
        timeline: {
          created: parsed.metadata.created ?? null,
          modified: parsed.metadata.modified ?? null
        },
        metrics: {
          wordCount: parsed.wordCount,
          editingMinutes: parsed.editingMinutes,
          pageCount: parsed.pageCount ?? null,
          ratioWordsPerMinute: decision.ratioWordsPerMinute,
          textEntropy: Number(entropy.toFixed(3)),
          syntaxUniformityCoefficient: uniformity ? Number(uniformity.coefficient.toFixed(3)) : null
        },
        metadata: parsed.metadata,
        anomalies: finalDecision.anomalies,
        anomalyIndex: finalDecision.anomalyIndex,
        verdict: finalDecision.verdict,
        linguisticAi,
        linguisticAiStatus
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' }
      }
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const lower = msg.toLowerCase();
    const isEncrypted =
      extension === 'pdf' &&
      (lower.includes('password') ||
        lower.includes('encrypted') ||
        lower.includes('encryption') ||
        lower.includes('secure'));

    const status = isEncrypted ? 422 : 500;
    const userMessage = isEncrypted
      ? 'El PDF parece estar protegido/cifrado. Exportalo sin contraseña y vuelve a intentarlo.'
      : 'Fallo al auditar el documento. El archivo podria estar dañado, ser un PDF no estandar o estar corrupto.';

    return new Response(
      JSON.stringify({
        error: userMessage,
        details: msg,
        extension,
        fileName: file.name
      }),
      { status, headers: { 'content-type': 'application/json' } }
    );
  }
};
