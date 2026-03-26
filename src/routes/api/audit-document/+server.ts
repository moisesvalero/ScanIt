import type { RequestHandler } from './$types';
import mammoth from 'mammoth';
// Nota: evitamos pdf-parse porque puede mezclar versiones de pdf.js (API/Worker) y fallar con mismatch.
import JSZip from 'jszip';
import Groq from 'groq-sdk';
import { env } from '$env/dynamic/private';
import { createHash } from 'node:crypto';

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

function lexicalDiversity(text: string) {
  const tokens = (text.toLowerCase().match(/\b[\p{L}\p{N}'-]+\b/gu) ?? []).map((t) => t.trim()).filter(Boolean);
  if (!tokens.length) return 0;
  const unique = new Set(tokens).size;
  return unique / tokens.length;
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
      company,
      producer: null,
      hasDigitalSignature: false
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
  const rawPdf = buffer.toString('latin1');
  const hasDigitalSignature =
    rawPdf.includes('/Type/Sig') || rawPdf.includes('/ByteRange[') || rawPdf.includes('/SubFilter');

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
      producer,
      hasDigitalSignature
    }
  };
}

function isOfficialPdfSource(metadata: Record<string, unknown>) {
  const base = `${String(metadata.creator ?? '')} ${String(metadata.application ?? '')} ${String(metadata.producer ?? '')}`.toLowerCase();
  return (
    base.includes('agencia tributaria') ||
    base.includes('aeat') ||
    base.includes('gobierno de espa') ||
    base.includes('ministerio') ||
    base.includes('sede electr') ||
    base.includes('boe') ||
    base.includes('fnmt')
  );
}

function buildAnomalies(input: {
  extension: 'docx' | 'pdf';
  wordCount: number;
  editingMinutes: number | null;
  entropy: number;
  uniformity: { mean: number; coefficient: number } | null;
  metadata: Record<string, unknown>;
  lexicalDiversity?: number;
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
  if (typeof input.lexicalDiversity === 'number' && input.lexicalDiversity < 0.22 && input.wordCount > 260) {
    anomalies.push({
      code: 'LOW_LEXICAL_DIVERSITY',
      severity: 'amber',
      message: 'Diversidad lexical baja para la longitud observada; posible uniformidad estilistica excesiva.'
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

function computeDocumentConfidence(input: {
  extension: 'docx' | 'pdf';
  wordCount: number;
  editingMinutes: number | null;
  timelineCreated: string | null;
  timelineModified: string | null;
  ratioWordsPerMinute: number | null;
  linguisticState: LinguisticAiStatus['state'];
  anomalyIndex: number;
  hasDigitalSignature: boolean;
  officialPdfSource: boolean;
}) {
  let score = 100;
  const reasons: string[] = [];
  if (!input.timelineCreated || !input.timelineModified) {
    score -= 22;
    reasons.push('Timeline incompleto: falta marca de creacion o modificacion.');
  }
  if (input.editingMinutes === null && input.extension !== 'pdf') {
    score -= 22;
    reasons.push('No hay tiempo de edicion verificable en metadatos.');
  }
  if (input.editingMinutes === null && input.extension === 'pdf') {
    score -= 6;
    reasons.push('PDF final sin tiempo de edicion interno (normal en documentos cerrados).');
  }
  if (input.ratioWordsPerMinute === null) {
    score -= 14;
    reasons.push('No se pudo calcular ratio palabras/minuto por evidencia insuficiente.');
  }
  if (input.wordCount < 180) {
    score -= 18;
    reasons.push('Muestra textual reducida para inferencia forense robusta.');
  }
  if (input.linguisticState !== 'ok') {
    score -= 10;
    reasons.push('Analisis lingüistico IA no disponible en esta ejecucion.');
  }
  if (input.anomalyIndex > 0) {
    score -= Math.min(20, input.anomalyIndex * 3);
  }
  if (input.hasDigitalSignature) {
    score += 14;
    reasons.push('Firma digital detectada en el PDF.');
  }
  if (input.officialPdfSource) {
    score += 10;
    reasons.push('Productor/creador compatible con emisor oficial.');
  }
  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    reasons
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
    const serverSha256 = createHash('sha256').update(buffer).digest('hex');
    const parsed = extension === 'docx' ? await parseDocx(buffer) : await parsePdf(buffer);
    const entropy = calcTextEntropy(parsed.text);
    const uniformity = sentenceUniformity(parsed.text);
    const diversity = lexicalDiversity(parsed.text);
    const styleConsistencyIndex = Number(
      Math.max(
        0,
        Math.min(100, ((uniformity ? Math.max(0, 1 - uniformity.coefficient) : 0.42) * 60 + Math.min(1, entropy / 4.5) * 25 + diversity * 15) * 100 / 100)
      ).toFixed(1)
    );
    const decision = buildAnomalies({
      extension,
      wordCount: parsed.wordCount,
      editingMinutes: parsed.editingMinutes,
      entropy,
      uniformity,
      metadata: parsed.metadata,
      lexicalDiversity: diversity
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

    let policyDecision = finalDecision.verdict;
    let forcedNoConclusive = false;
    let forcedReason: string | null = null;
    const hasDigitalSignature = Boolean(parsed.metadata.hasDigitalSignature);
    const officialPdfSource = extension === 'pdf' ? isOfficialPdfSource(parsed.metadata) : false;
    const missingCriticalEvidence =
      extension === 'docx'
        ? parsed.editingMinutes === null || !parsed.metadata.created || !parsed.metadata.modified || parsed.wordCount < 180
        : parsed.wordCount < 180 && !hasDigitalSignature && !officialPdfSource;
    if (policyDecision === 'integro' && missingCriticalEvidence) {
      policyDecision = 'no_concluyente';
      forcedNoConclusive = true;
      forcedReason =
        extension === 'docx'
          ? 'Zero Guessing Policy: no se clasifica como integro cuando faltan señales críticas (timeline completo, editing time y/o muestra textual suficiente).'
          : 'Zero Guessing Policy: PDF con evidencia insuficiente (sin firma oficial ni trazas sólidas de procedencia).';
    }

    const confidence = computeDocumentConfidence({
      extension,
      wordCount: parsed.wordCount,
      editingMinutes: parsed.editingMinutes,
      timelineCreated: (parsed.metadata.created as string | null) ?? null,
      timelineModified: (parsed.metadata.modified as string | null) ?? null,
      ratioWordsPerMinute: finalDecision.ratioWordsPerMinute,
      linguisticState: linguisticAiStatus.state,
      anomalyIndex: finalDecision.anomalyIndex,
      hasDigitalSignature,
      officialPdfSource
    });

    return new Response(
      JSON.stringify({
        suite: 'Jamalajam',
        mode: 'document_audit',
        analysisVersion: 'jamalajam-forensics-1.0.0',
        fileName: file.name,
        extension,
        serverSha256,
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
          syntaxUniformityCoefficient: uniformity ? Number(uniformity.coefficient.toFixed(3)) : null,
          lexicalDiversity: Number(diversity.toFixed(3)),
          styleConsistencyIndex
        },
        metadata: parsed.metadata,
        anomalies: finalDecision.anomalies,
        anomalyIndex: finalDecision.anomalyIndex,
        verdict: policyDecision,
        policy: {
          zeroGuessing: true,
          forcedNoConclusive,
          reason: forcedReason
        },
        evidenceCoverage: {
          timelineComplete: Boolean(parsed.metadata.created && parsed.metadata.modified),
          editingTimeAvailable: parsed.editingMinutes !== null,
          ratioAvailable: finalDecision.ratioWordsPerMinute !== null,
          textualSampleSufficient: parsed.wordCount >= 180,
          linguisticAiAvailable: linguisticAiStatus.state === 'ok',
          digitalSignature: hasDigitalSignature,
          officialPdfSource
        },
        ocrStatus:
          extension === 'pdf' && parsed.wordCount < 40
            ? {
                state: 'recommended',
                reason: 'PDF con poco texto extraible: se recomienda OCR sobre copia imagen para aumentar cobertura.'
              }
            : {
                state: 'not_required',
                reason: 'Extraccion textual suficiente; OCR no necesario en esta fase.'
              },
        confidence,
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
