import type { RequestHandler } from './$types';
import Groq from 'groq-sdk';
import { env } from '$env/dynamic/private';

type ImageAiVerdict = {
  suspicionPercent: number;
  reasons: string[];
  origin: 'Origen: Dispositivo Digital (Captura)' | 'Origen: Captura Óptica (Cámara)';
  ocrTextSample: string;
  ocrEstimatedChars: number;
  styleConsistency: number;
};

type ImageAiStatus = {
  state: 'ok' | 'omitted' | 'error' | 'blocked';
  reason: string;
};

type VisualPrecheck = {
  allowed: boolean;
  category: 'documento' | 'captura_software' | 'texto_academico' | 'irrelevante';
  reason: string;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(err: unknown) {
  const e = err as any;
  const status = Number(e?.status ?? e?.response?.status ?? 0);
  const msg = String(e?.message ?? '').toLowerCase();
  return status === 429 || msg.includes('rate limit') || msg.includes('too many requests') || msg.includes('429');
}

function clamp01to100(n: number) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

function guessMimeType(fileName: string, fallback: string) {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  return fallback || 'image/jpeg';
}

function normalizeOrigin(raw: unknown): 'Origen: Dispositivo Digital (Captura)' | 'Origen: Captura Óptica (Cámara)' {
  const v = String(raw ?? '').toLowerCase();
  if (
    v.includes('dispositivo') ||
    v.includes('captura') ||
    v.includes('screenshot') ||
    v.includes('screen')
  ) {
    return 'Origen: Dispositivo Digital (Captura)';
  }
  return 'Origen: Captura Óptica (Cámara)';
}

function normalizeCategory(raw: unknown): VisualPrecheck['category'] {
  const v = String(raw ?? '').toLowerCase();
  if (v.includes('document')) return 'documento';
  if (v.includes('captura') || v.includes('software') || v.includes('screenshot')) return 'captura_software';
  if (v.includes('academ') || v.includes('texto')) return 'texto_academico';
  return 'irrelevante';
}

function parseGroqJsonTolerant(content: string): any | null {
  const s = String(content ?? '').trim();
  if (!s) return null;
  // 1) Si es JSON puro, lo parseamos directo.
  try {
    return JSON.parse(s);
  } catch {
    // 2) Si Groq mete texto alrededor, intentamos extraer el primer objeto JSON.
    const jsonCandidate = s.match(/\{[\s\S]*\}/)?.[0] ?? '';
    if (!jsonCandidate) return null;
    try {
      return JSON.parse(jsonCandidate);
    } catch {
      return null;
    }
  }
}

function parseGroqReasonsSection(reasonsSection: string): string[] {
  const section = String(reasonsSection ?? '').trim();
  if (!section) return [];
  if (section.includes('|')) {
    return section
      .split('|')
      .map((r) => r.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
  }
  // razones como lista JSON simple: ["a","b","c"]
  if (section.startsWith('[')) {
    const listCandidate = section.match(/^\[[\s\S]*\]/)?.[0] ?? '';
    if (!listCandidate) return [];
    const parsed = parseGroqJsonTolerant(listCandidate);
    if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
  }
  // razones en texto con comillas
  const quoted = section.match(/"([^"]+)"|'([^']+)'/g) ?? [];
  if (quoted.length) {
    return quoted.map((q) => q.replace(/^["']|["']$/g, '')).filter(Boolean);
  }
  return [];
}

async function runVisualPrecheck(groq: Groq, dataUrl: string): Promise<VisualPrecheck> {
  let response: any;
  try {
    response = await groq.chat.completions.create({
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      temperature: 0,
      max_tokens: 130,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'Clasificador visual estricto para ScanIt. Determina si la imagen es evidencia documental válida. SOLO devuelve JSON con: allowed (boolean), category ("documento"|"captura_software"|"texto_academico"|"irrelevante"), reason (string breve). Marca irrelevante cuando detectes personas, paisajes, selfies, objetos cotidianos, memes, dibujos/ilustraciones o contenido no académico/documental.'
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Valida si esta imagen es evidencia documental académica apta para análisis forense.' },
            { type: 'image_url', image_url: { url: dataUrl } }
          ] as any
        }
      ]
    });
  } catch (e) {
    const msg = String((e as any)?.message ?? '').toLowerCase();
    // Si Groq falla al generar JSON estricto, reintentamos sin response_format.
    if (msg.includes('failed to generate json') || msg.includes('invalid_request_error')) {
      response = await groq.chat.completions.create({
        model: 'meta-llama/llama-4-scout-17b-16e-instruct',
        temperature: 0,
        max_tokens: 130,
        messages: [
          {
            role: 'system',
            content:
              'Clasificador visual estricto para ScanIt. Devuelve SOLO un JSON válido en una sola respuesta con: allowed (boolean), category ("documento"|"captura_software"|"texto_academico"|"irrelevante"), reason (string breve).'
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Valida si esta imagen es evidencia documental académica apta para análisis forense.' },
              { type: 'image_url', image_url: { url: dataUrl } }
            ] as any
          }
        ]
      });
    } else {
      throw e;
    }
  }

  const content = response?.choices?.[0]?.message?.content ?? '';
  if (!content) {
    return {
      allowed: false,
      category: 'irrelevante',
      reason: 'No se pudo validar el tipo de evidencia visual.'
    };
  }

  const parsed = parseGroqJsonTolerant(content);
  if (!parsed) {
    return {
      allowed: false,
      category: 'irrelevante',
      reason: 'Respuesta de prevalidación visual no interpretable.'
    };
  }

  try {
    const category = normalizeCategory(parsed?.category);
    const allowed = Boolean(parsed?.allowed) && category !== 'irrelevante';
    return {
      allowed,
      category,
      reason: String(parsed?.reason ?? 'Clasificacion visual completada.')
    };
  } catch {
    return {
      allowed: false,
      category: 'irrelevante',
      reason: 'Respuesta de prevalidación visual inválida.'
    };
  }
}

export const POST: RequestHandler = async ({ request }) => {
  const form = await request.formData();
  const file = form.get('file');
  if (!(file instanceof File)) {
    return new Response(JSON.stringify({ error: 'Archivo no valido.' }), { status: 400 });
  }

  if (!file.type.startsWith('image/')) {
    return new Response(JSON.stringify({ error: 'Formato no soportado. Sube una imagen.' }), { status: 400 });
  }

  const key = env.GROQ_API_KEY || process.env.GROQ_API_KEY;
  if (!key) {
    return new Response(
      JSON.stringify({
        verdict: null,
        status: { state: 'omitted', reason: 'GROQ_API_KEY ausente en el entorno del servidor.' } satisfies ImageAiStatus
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }

  // Límite conservador para plan free y evitar payloads enormes.
  if (file.size > 4_500_000) {
    return new Response(
      JSON.stringify({
        verdict: null,
        status: {
          state: 'omitted',
          reason: 'Imagen demasiado pesada para analisis IA en tiempo real (max recomendado ~4.5MB).'
        } satisfies ImageAiStatus
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }

  try {
    const bytes = Buffer.from(await file.arrayBuffer());
    const mime = guessMimeType(file.name, file.type);
    const dataUrl = `data:${mime};base64,${bytes.toString('base64')}`;

    const groq = new Groq({ apiKey: key });
    let precheck: VisualPrecheck = {
      allowed: false,
      category: 'irrelevante',
      reason: 'Prevalidacion no ejecutada.'
    };
    const precheckAttempts = 2;
    for (let attempt = 1; attempt <= precheckAttempts; attempt += 1) {
      try {
        precheck = await runVisualPrecheck(groq, dataUrl);
        break;
      } catch (e) {
        if (!isRateLimitError(e) || attempt >= precheckAttempts) throw e;
        const waitMs = 5000 * 2 ** (attempt - 1);
        await sleep(waitMs);
      }
    }

    if (!precheck.allowed) {
      return new Response(
        JSON.stringify({
          precheck,
          verdict: null,
          status: {
            state: 'blocked',
            reason: 'Contenido no apto para auditoría académica.'
          } satisfies ImageAiStatus
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    let response: any = null;
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        response = await groq.chat.completions.create({
          model: 'meta-llama/llama-4-scout-17b-16e-instruct',
          temperature: 0.2,
          max_tokens: 280,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content:
                'Eres un perito forense de documentos académicos visuales. NO analices personas, paisajes ni objetos generales: céntrate en hojas, textos, tablas, sellos, firmas, capturas de plataformas educativas y documentos de colegio/instituto/universidad. Evalúa coherencia tipográfica, bordes de elementos, compresión/artefactos y ruido de sensor para detectar manipulación digital o creación sintética. Devuelve SOLO JSON con: suspicionPercent (0-100), origin ("Origen: Dispositivo Digital (Captura)" o "Origen: Captura Óptica (Cámara)"), reasons (array de 3 strings técnicas), ocrTextSample (string con 1-2 líneas), ocrEstimatedChars (número aprox de caracteres legibles), styleConsistency (0-100; mayor = estilo visual más consistente).'
            },
            {
              role: 'user',
              content: [
                { type: 'text', text: 'Analiza esta evidencia visual para detección forense de manipulación/sintético.' },
                { type: 'image_url', image_url: { url: dataUrl } }
              ] as any
            }
          ]
        });
        break;
      } catch (e) {
        const msg = String((e as any)?.message ?? '').toLowerCase();
        if (msg.includes('failed to generate json') || msg.includes('invalid_request_error')) {
          response = await groq.chat.completions.create({
            model: 'meta-llama/llama-4-scout-17b-16e-instruct',
            temperature: 0.2,
            max_tokens: 280,
            messages: [
              {
                role: 'system',
                content:
                  'Eres un perito forense de documentos académicos visuales. Devuelve SOLO un JSON válido en una sola respuesta con: suspicionPercent (0-100), origin ("Origen: Dispositivo Digital (Captura)" o "Origen: Captura Óptica (Cámara)"), reasons (array de 3 strings técnicas), ocrTextSample (string), ocrEstimatedChars (número), styleConsistency (0-100).'
              },
              {
                role: 'user',
                content: [
                  { type: 'text', text: 'Analiza esta evidencia visual para detección forense de manipulación/sintético.' },
                  { type: 'image_url', image_url: { url: dataUrl } }
                ] as any
              }
            ]
          });
          break;
        }
        if (!isRateLimitError(e) || attempt >= maxAttempts) throw e;
        const waitMs = 5000 * 2 ** (attempt - 1); // 5s, 10s...
        await sleep(waitMs);
      }
    }

    const content = response?.choices?.[0]?.message?.content ?? '';
    if (!content) {
      return new Response(
        JSON.stringify({
          verdict: null,
          status: { state: 'omitted', reason: 'Groq no devolvio contenido para esta imagen.' } satisfies ImageAiStatus
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    let parsed: any;
    parsed = parseGroqJsonTolerant(content);
    if (!parsed) {
      // Último recurso: regex muy básica para seguir el flujo sin romper.
      const pctStr = content.match(/suspicionPercent\s*[:=]\s*(\d{1,3})/i)?.[1];
      const originRaw = content.match(/origin\s*[:=]\s*["']?([^,"']+)["']?/i)?.[1] ?? '';
      const reasonsSection = content.split(/reasons\s*[:=]/i)[1] ?? '';
      const reasons = parseGroqReasonsSection(reasonsSection).slice(0, 3);
      const suspicionPercent = pctStr ? clamp01to100(Number(pctStr)) : 0;
      const origin = normalizeOrigin(originRaw);
      while (reasons.length < 3) reasons.push('No concluyente: evidencia visual insuficiente en la muestra.');

      const ocrTextSample = content.match(/ocrTextSample\s*[:=]\s*["']([\s\S]*?)["']/)?.[1] ?? '';
      const ocrEstimatedCharsStr = content.match(/ocrEstimatedChars\s*[:=]\s*(\d+)/i)?.[1];
      const ocrEstimatedChars = ocrEstimatedCharsStr ? Math.max(0, Math.round(Number(ocrEstimatedCharsStr))) : ocrTextSample.length;
      const styleConsistencyStr = content.match(/styleConsistency\s*[:=]\s*(\d{1,3})/i)?.[1];
      const styleConsistency = styleConsistencyStr ? clamp01to100(Number(styleConsistencyStr)) : 50;

      parsed = {
        suspicionPercent,
        origin,
        reasons,
        ocrTextSample,
        ocrEstimatedChars,
        styleConsistency
      };
    }

    const suspicionPercent = clamp01to100(Number(parsed?.suspicionPercent ?? parsed?.porcentaje ?? 0));
    const origin = normalizeOrigin(parsed?.origin ?? parsed?.origen);
    const ocrTextSample = String(parsed?.ocrTextSample ?? '').trim().slice(0, 240);
    const ocrEstimatedCharsRaw = Number(parsed?.ocrEstimatedChars ?? ocrTextSample.length ?? 0);
    const ocrEstimatedChars = Number.isFinite(ocrEstimatedCharsRaw) ? Math.max(0, Math.round(ocrEstimatedCharsRaw)) : 0;
    const styleConsistency = clamp01to100(Number(parsed?.styleConsistency ?? 50));
    const reasonsRaw = Array.isArray(parsed?.reasons) ? parsed.reasons : [];
    const reasons = reasonsRaw.map(String).filter(Boolean).slice(0, 3);
    while (reasons.length < 3) reasons.push('No concluyente: evidencia visual insuficiente en la muestra.');

    return new Response(
      JSON.stringify({
        precheck,
        verdict: { suspicionPercent, reasons, origin, ocrTextSample, ocrEstimatedChars, styleConsistency } satisfies ImageAiVerdict,
        status: {
          state: 'ok',
          reason: `Analisis visual completado. ${origin}. Sospecha estimada: ${suspicionPercent.toFixed(0)}%.`
        } satisfies ImageAiStatus
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (isRateLimitError(e)) {
      return new Response(
        JSON.stringify({
          precheck: {
            allowed: false,
            category: 'irrelevante',
            reason: 'Rate limit durante validacion/analisis visual.'
          } satisfies VisualPrecheck,
          verdict: null,
          status: { state: 'error', reason: 'Servidores saturados, reintentando en 5 segundos...' } satisfies ImageAiStatus
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response(
      JSON.stringify({
        precheck: {
          allowed: false,
          category: 'irrelevante',
          reason: 'Error inesperado durante validacion/analisis visual.'
        } satisfies VisualPrecheck,
        verdict: null,
        status: { state: 'error', reason: `Fallo en Groq Vision: ${msg.slice(0, 140)}` } satisfies ImageAiStatus
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }
};
