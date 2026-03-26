/**
 * Heurística de contenedor MP4: recorrido de boxes de nivel superior y ftyp.
 * Objetivo: marcar reencodes / muxers atípicos frente a captura móvil típica.
 */

export type Mp4BoxEntry = { type: string; size: number; offset: number };

export type Mp4ForensicResult = {
  applicable: boolean;
  /** 0 = parece coherente con captura típica, 100 = muy sospechoso */
  fakeScore0to100: number;
  notes: string[];
  ftypMajorBrand: string | null;
  ftypCompatibleBrands: string[];
  topLevelOrder: string[];
};

function readFourCC(dv: DataView, offset: number): string {
  let s = '';
  for (let i = 0; i < 4; i++) {
    const c = dv.getUint8(offset + i);
    s += c >= 32 && c < 127 ? String.fromCharCode(c) : '?';
  }
  return s;
}

/** Marcas habituales en captura móvil / cámara (no exhaustivo). */
const CAPTURE_LIKE_BRANDS = new Set([
  'qt  ',
  'isom',
  'iso2',
  'iso5',
  'iso6',
  'avc1',
  'mp41',
  'mp42',
  'M4V ',
  'M4A ',
  'M4B ',
  'M4P ',
  '3gp4',
  '3gp5',
  '3gp6',
  '3g2a',
  '3g2b',
  'msnv',
  'XAVC',
  'apcn',
  'apch',
  'apcs',
  'apco',
  'ap4h'
]);

/** Sospechosos como firma única de reencode / streaming. */
const SUSPECT_MAJOR = new Set(['dash', 'dsms', 'msdh']);

function parseTopLevelBoxes(buffer: ArrayBuffer, maxRead: number): Mp4BoxEntry[] {
  const dv = new DataView(buffer);
  const end = Math.min(buffer.byteLength, maxRead);
  const out: Mp4BoxEntry[] = [];
  let offset = 0;

  while (offset + 8 <= end) {
    let size = dv.getUint32(offset, false);
    const type = readFourCC(dv, offset + 4);
    let header = 8;

    if (size === 0) {
      size = end - offset;
    } else if (size === 1) {
      if (offset + 16 > end) break;
      const hi = dv.getUint32(offset + 8, false);
      const lo = dv.getUint32(offset + 12, false);
      size = hi * 0x100000000 + lo;
      header = 16;
    }

    if (size < header || offset + size > end) break;

    out.push({ type, size, offset });
    offset += size;
    if (size === 0) break;
  }

  return out;
}

function parseFtyp(dv: DataView, boxOffset: number, boxSize: number): {
  major: string;
  compatible: string[];
} {
  const compatible: string[] = [];
  if (boxSize < 16) return { major: '', compatible };
  const major = readFourCC(dv, boxOffset + 8);
  let o = boxOffset + 12;
  const end = boxOffset + boxSize;
  while (o + 4 <= end) {
    compatible.push(readFourCC(dv, o));
    o += 4;
  }
  return { major, compatible };
}

/**
 * Escanea los primeros `maxBytes` del buffer (típico: cabecera MP4).
 */
export function scanMp4Container(buffer: ArrayBuffer, maxBytes = 2 * 1024 * 1024): Mp4ForensicResult {
  const notes: string[] = [];
  if (buffer.byteLength < 16) {
    return {
      applicable: true,
      fakeScore0to100: 55,
      notes: ['Buffer demasiado corto para análisis de contenedor.'],
      ftypMajorBrand: null,
      ftypCompatibleBrands: [],
      topLevelOrder: []
    };
  }

  const dv = new DataView(buffer);
  const scanLen = Math.min(buffer.byteLength, maxBytes);
  const boxes = parseTopLevelBoxes(buffer.slice(0, scanLen), scanLen);
  const order = boxes.map((b) => b.type);

  const ftypBox = boxes.find((b) => b.type === 'ftyp');
  let major: string | null = null;
  let compatible: string[] = [];

  if (!ftypBox) {
    notes.push('No se encontró box ftyp en el tramo analizado (contenedor no estándar o corrupto).');
    return {
      applicable: true,
      fakeScore0to100: 78,
      notes,
      ftypMajorBrand: null,
      ftypCompatibleBrands: [],
      topLevelOrder: order
    };
  }

  const parsed = parseFtyp(dv, ftypBox.offset, Math.min(ftypBox.size, scanLen - ftypBox.offset));
  major = parsed.major || null;
  compatible = parsed.compatible;

  let score = 0;

  if (ftypBox.offset !== 0) {
    notes.push('ftyp no está al inicio del archivo (posible prefijo / empaquetado atípico).');
    score += 35;
  }

  if (!major || major === '????' || major.trim().length < 3) {
    notes.push('Marca mayor ftyp ilegible o vacía.');
    score += 40;
  }

  if (major && SUSPECT_MAJOR.has(major.trim())) {
    notes.push(`Marca mayor "${major}" asociada a fragmentación DASH / reempaquetado (no típico de captura directa).`);
    score += 42;
  }

  const allBrands = new Set<string>();
  if (major) allBrands.add(major.trim());
  for (const c of compatible) allBrands.add(c.trim());

  let captureHint = false;
  for (const b of allBrands) {
    if (CAPTURE_LIKE_BRANDS.has(b)) {
      captureHint = true;
      break;
    }
  }

  if (!captureHint && major) {
    notes.push('ftyp sin marcas compatibles habituales de captura móvil/cámara (posible reencode o muxer genérico).');
    score += 28;
  }

  // Orden atípico: moov muy tarde sin mdat previo en ventana (algunos editores); free enorme al inicio
  const idxMoov = order.indexOf('moov');
  const idxMdat = order.indexOf('mdat');
  const idxFree = order.indexOf('free');
  if (idxFree === 0 && boxes[0] && boxes[0].size > 512 * 1024) {
    notes.push('Box "free" inicial muy grande (posible padding de herramienta).');
    score += 18;
  }
  if (idxMdat >= 0 && idxMoov >= 0 && idxMdat < idxMoov) {
    notes.push('mdat antes que moov (fast start inverso o mux atípico; no implica fake por sí solo).');
    score += 12;
  }

  // Sin moov en cabecera: posible solo fragmento o archivo incompleto
  if (idxMoov < 0 && !order.includes('moof')) {
    notes.push('No aparece moov en la cabecera analizada (puede ser fragmentado u offline parcial).');
    score += 22;
  }

  return {
    applicable: true,
    fakeScore0to100: Math.min(100, score),
    notes,
    ftypMajorBrand: major,
    ftypCompatibleBrands: compatible,
    topLevelOrder: order
  };
}
