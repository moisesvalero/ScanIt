import mediaInfoFactory from 'mediainfo.js';
import mediaInfoWasmUrl from 'mediainfo.js/MediaInfoModule.wasm?url';

type AuditRequest = {
  type: 'audit';
  id: string;
  file: File;
  doMediaInfo: boolean;
};

type AuditProgress = {
  type: 'progress';
  id: string;
  stage: 'READING' | 'HASHING' | 'MEDIAINFO' | 'DONE';
};

type AuditResult = {
  type: 'result';
  id: string;
  hashHex: string;
  mi: { thirdParty: boolean; encoderHints: string[] };
};

type AuditError = {
  type: 'error';
  id: string;
  message: string;
};

let mediaInfoInstance: { analyzeData: Function; close: Function } | null = null;
let mediaInfoLoading = false;

async function ensureMediaInfoLoaded() {
  if (mediaInfoInstance || mediaInfoLoading) return;
  mediaInfoLoading = true;
  try {
    mediaInfoInstance = (await mediaInfoFactory({
      format: 'object',
      full: true,
      locateFile: () => mediaInfoWasmUrl
    })) as unknown as { analyzeData: Function; close: Function };
  } finally {
    mediaInfoLoading = false;
  }
}

function toHex(bytes: Uint8Array) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

async function sha256Hex(file: File) {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return toHex(new Uint8Array(digest));
}

async function scanMediaInfoHints(result: unknown) {
  const encoderHints: string[] = [];
  const pushHint = (label: string) => {
    if (!encoderHints.includes(label)) encoderHints.push(label);
  };

  let visited = 0;
  const maxVisited = 18_000;
  const maxStringLen = 14_000;

  const walk = (v: unknown) => {
    if (visited++ > maxVisited) return;
    if (v == null) return;

    if (typeof v === 'string') {
      const s = v.length > maxStringLen ? v.slice(0, maxStringLen) : v;
      // Huellas de encoder (ojo: muchas cámaras/plataformas exponen campos "encoder" benignos).
      // Solo consideramos "terceros" cuando hay nombres claros de software de edición/transcodificación.
      const sLower = s.toLowerCase();
      if (sLower.includes('lavf')) pushHint('Lavf');
      if (sLower.includes('ffmpeg')) pushHint('FFmpeg');
      if (sLower.includes('handbrake')) pushHint('HandBrake');
      if (/(adobe|premiere|after effects)/i.test(s)) pushHint('Adobe');
      if (/davinci|resolve/i.test(s)) pushHint('DaVinci');
      if (/capcut/i.test(s)) pushHint('CapCut');
      if (/final cut/i.test(s)) pushHint('FinalCut');
      if (/kinemaster/i.test(s)) pushHint('KineMaster');

      if (/(encoded_?application|writing_?library|encoder)/i.test(s)) {
        // No marcamos genéricamente como "Editor" porque casi cualquier archivo puede tener
        // campos "encoder/writing library" legítimos (cámara / plataforma / pipeline).
        // Solo se considera señal fuerte si aparece un software de edición conocido.
        if (/adobe|premiere|after effects|davinci|resolve|capcut|final cut|kinemaster/i.test(s)) pushHint('Editor');
      }
      return;
    }

    if (typeof v === 'number' || typeof v === 'boolean') return;

    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }

    if (typeof v === 'object') {
      for (const x of Object.values(v as Record<string, unknown>)) walk(x);
    }
  };

  walk(result);
  const strongThirdParty =
    encoderHints.includes('Editor') ||
    encoderHints.includes('HandBrake') ||
    encoderHints.includes('Adobe') ||
    encoderHints.includes('DaVinci') ||
    encoderHints.includes('CapCut') ||
    encoderHints.includes('FinalCut') ||
    encoderHints.includes('KineMaster');

  // Nota: 'FFmpeg'/'Lavf' pueden aparecer por transcodificación legítima. Los dejamos como hint,
  // pero no elevan por sí solos "thirdParty".
  return { thirdParty: strongThirdParty, encoderHints };
}

async function auditMediaInfo(file: File) {
  await ensureMediaInfoLoaded();
  if (!mediaInfoInstance) return { thirdParty: false, encoderHints: [] as string[] };

  const readChunk = async (chunkSize: number, offset: number) => {
    const buffer = await file.slice(offset, offset + chunkSize).arrayBuffer();
    return new Uint8Array(buffer);
  };

  const result = await (mediaInfoInstance.analyzeData as any)(file.size, readChunk);
  return await scanMediaInfoHints(result);
}

self.onmessage = async (ev: MessageEvent<AuditRequest>) => {
  const msg = ev.data;
  if (!msg || msg.type !== 'audit') return;

  const post = (m: AuditProgress | AuditResult | AuditError) => (self as any).postMessage(m);

  try {
    post({ type: 'progress', id: msg.id, stage: 'READING' });
    post({ type: 'progress', id: msg.id, stage: 'HASHING' });
    const hashHex = await sha256Hex(msg.file);

    let mi = { thirdParty: false, encoderHints: [] as string[] };
    if (msg.doMediaInfo) {
      post({ type: 'progress', id: msg.id, stage: 'MEDIAINFO' });
      mi = await auditMediaInfo(msg.file);
    }

    post({ type: 'progress', id: msg.id, stage: 'DONE' });
    post({ type: 'result', id: msg.id, hashHex, mi });
  } catch (err) {
    post({ type: 'error', id: msg.id, message: String((err as any)?.message ?? err) });
  }
};

