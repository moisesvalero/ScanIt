# ScanIt

Suite forense web para auditoria de integridad documental (`.pdf` y `.docx`) e imagen, con enfoque en evidencia tecnica reproducible y politica conservadora.

![SvelteKit](https://img.shields.io/badge/SvelteKit-2.x-ff3e00?logo=svelte&logoColor=white)
![Node](https://img.shields.io/badge/Node-18%2B-339933?logo=nodedotjs&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-7.x-646cff?logo=vite&logoColor=white)
![Estado](https://img.shields.io/badge/estado-MVP%20calibrado-1f8f4e)
![Licencia](https://img.shields.io/badge/licencia-PolyForm%20Noncommercial-yellow)

## Vision

ScanIt responde una pregunta concreta: **"¿hay señales tecnicas de manipulacion o generacion sintetica?"**

No adivina. Aplica **Zero Guessing Policy** para priorizar trazabilidad y reducir falsos positivos agresivos.

Principios del proyecto:

- Evidencia primero (timeline, metadatos, hashes, señales tecnicas).
- Decisiones auditables (anomalias explicitas + cobertura de evidencia).
- Salida conservadora (`no_concluyente`) cuando falta soporte suficiente.

## Quick Start (2 minutos)

```bash
npm install
npm run dev
```

Abre `http://127.0.0.1:5173`, sube un `.pdf` o `.docx` y ejecuta la auditoria.

Si quieres evaluar el dataset completo:

```bash
npm run eval:dataset
```

Se generaran reportes en `dataset/reports/`.

## Demo rapida (flujo recomendado)

1. Arrancar app en local (`npm run dev`).
2. Probar 1 documento real y 1 IA desde `dataset/`.
3. Revisar en UI:
   - `verdict`
   - `anomalies`
   - `evidenceCoverage`
   - `confidence`
4. Ejecutar `npm run eval:dataset` para validar comportamiento global.

## Funcionalidades clave

### 1) Auditoria de documentos

- Extraccion de texto, timeline y metadatos de `docx` y `pdf`.
- Metricas forenses: entropia, uniformidad sintactica, diversidad lexical, ratio palabras/minuto.
- Comprobaciones DOCX: autor/ultimo editor, coherencia temporal interna.
- Comprobaciones PDF: firma estructural (ByteRange) y posible tampering post-firma.
- Capa linguistica con Groq (si hay clave y muestra textual suficiente).
- Veredicto final con politica conservadora y cobertura de evidencia.

### 2) Auditoria visual / imagen

- ELA (Error Level Analysis), PRNU aproximado y ruido por zonas.
- Clasificacion visual IA para validar que la evidencia es documental.

### 3) Telemetria y salida

- Flujo con logs operativos (`[AUDIT]`, `[CHECK]`, `[FAIL]`, `[ALERTA]`).
- Informe tecnico PDF.
- Reporte JSON de evaluaciones masivas del dataset.

## Stack tecnico

- Frontend: `SvelteKit` + `Svelte 5`
- Backend API: endpoints `+server.ts`
- Procesado docs: `mammoth`, `jszip`, `pdfjs-dist`, `pdf-parse`
- OCR base: `tesseract.js`
- IA: `groq-sdk`
- Reportes PDF: `jspdf`

## Licencia

Este proyecto se distribuye bajo licencia **PolyForm Noncommercial 1.0.0** (ver `LICENSE`).

Para uso comercial, licencia comercial separada y acuerdo directo con el autor.

## Estructura relevante

- `src/routes/+page.svelte`: UI principal y flujo de auditoria.
- `src/routes/api/audit-document/+server.ts`: pipeline forense documental.
- `src/routes/api/audit-image-ai/+server.ts`: capa visual IA.
- `scripts/eval-dataset.mjs`: evaluacion masiva del dataset.
- `scripts/eval-until-noon.ps1`: bucle de reintentos hasta ventana horaria.
- `dataset/real` y `dataset/ia`: corpus etiquetado para calibracion.
- `dataset/reports`: resultados (`eval-details-*`, `eval-metrics-*`, parciales).

## Estado actual de calibracion (dataset local)

Pasada completa mas reciente documentada:

- Dataset: 153 documentos (63 real / 90 IA)
- Failed HTTP: 0
- Undecided: 50 (32.68%)
- Decididos: 103
- TP: 50 / TN: 53 / FP: 0 / FN: 0

Archivo de referencia:

- `dataset/reports/eval-metrics-2026-03-28T17-42-27.106Z.json`

> Nota: los valores cambian al recalibrar reglas o variar el estado de servicios IA.

## Variables de entorno

### Minimas

```bash
GROQ_API_KEY=tu_api_key
PUBLIC_SITE_URL=http://localhost:5173
```

### Politicas del endpoint documental

```bash
# Opcional: pausa capa linguistica en PDF
SCANIT_SAFE_MODE=false

# Umbral para permitir "anomalias_detectadas" en PDF
# cuando solo existe LINGUISTIC_AI_VERY_HIGH
SCANIT_PDF_LINGUISTIC_DECISIVE_MIN=90

# Si Groq falla en PDF breve, no permitir "integro"
SCANIT_PDF_INTEGRO_MAX_WORDS_IF_LINGUISTIC_ERROR=600
```

### Evaluacion de dataset (`scripts/eval-dataset.mjs`)

```bash
SCANIT_EVAL_URL=http://127.0.0.1:5173/api/audit-document
SCANIT_EVAL_FETCH_ATTEMPTS=6
SCANIT_EVAL_MAX_PER_CLASS=0
SCANIT_EVAL_PARTIAL_EVERY=10
SCANIT_EVAL_RUN_MS=0
```

## Ejecutar en local

```bash
npm install
npm run dev
```

Servidor local fijado en:

- `http://127.0.0.1:5173` (`strictPort: true` en Vite)

Chequeos recomendados:

```bash
npm run check
npm run build
```

## Evaluacion y calibracion

### Pasada completa del dataset

```bash
npm run eval:dataset
```

### Ejecucion explicita (recomendada en Windows)

```bash
set NODE_OPTIONS=--dns-result-order=ipv4first
set SCANIT_EVAL_URL=http://127.0.0.1:5173/api/audit-document
node scripts/eval-dataset.mjs
```

### Bucle con reintentos por ventana horaria

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\eval-until-noon.ps1
```

## Politica de veredictos

- `integro`: señales consistentes y cobertura suficiente.
- `anomalias_detectadas`: presencia de señales tecnicas relevantes.
- `no_concluyente`: evidencia insuficiente, conflictiva o no robusta.

Reglas destacadas:

- En PDF, señal linguistica aislada no fuerza anomalia salvo umbral alto configurable.
- En PDF breve con error linguistico, no se declara `integro`.
- Se prioriza minimizar falsos positivos sin perder trazabilidad de decisiones.

## Limitaciones conocidas

- Firma PDF en modo estructural (no PKI completa end-to-end).
- OCR es basico en PDFs sin capa textual.
- Servicios IA externos pueden saturarse y afectar cobertura linguistica.
- Ningun detector es infalible: siempre requiere criterio humano.

## Despliegue (Vercel)

1. Subir repo a GitHub.
2. Importar en Vercel como SvelteKit.
3. Configurar variables (`GROQ_API_KEY`, `PUBLIC_SITE_URL`, opcionales `SCANIT_*`).
4. Desplegar.

## Publicacion segura del repo

Antes de publicar el repositorio:

- No subas documentos con datos personales (`dataset/real` privado).
- No subas reportes generados localmente (`dataset/reports`).
- No subas `.env` ni secretos (`GROQ_API_KEY`).
- Si necesitas ejemplos, usa un corpus anonimo/sintetico.

## Uso responsable

ScanIt es una herramienta de apoyo tecnico.
No sustituye evaluacion humana ni asesoramiento legal/pericial formal.
