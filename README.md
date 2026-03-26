# ScanIt

Suite forense web para auditoria de integridad academica en documentos e imagenes, con enfoque en evidencia tecnica reproducible.

## Vision del proyecto

ScanIt ayuda a responder una pregunta concreta: **"¿hay señales tecnicas de manipulacion o generacion sintética en esta evidencia?"**  
No pretende adivinar; aplica una politica conservadora (**Zero Guessing Policy**) para evitar falsos positivos agresivos.

Principios:

- Evidencia primero (SHA-256, timeline, metadatos y huellas tecnicas).
- Trazabilidad de decisiones (anomalias explicitas y cobertura de evidencia).
- Salida conservadora (`no_concluyente`) cuando faltan pruebas suficientes.

## Funcionalidades principales (MVP)

### 1) Auditoria de documentos (`.docx` y `.pdf`)

- Extraccion de metadatos de creacion/modificacion y autoria.
- Calculo de ratio palabras/minuto y comprobaciones de coherencia temporal.
- Analisis de entropia textual, uniformidad sintactica y diversidad lexical.
- Deteccion de inconsistencias internas DOCX (`core.xml` / `app.xml`).
- Verificacion estructural de firma PDF (ByteRange y posible manipulacion post-firma).
- Politica de correlacion obligatoria para endurecer veredictos positivos.

### 2) Certificacion de captura/imagen

- ELA (Error Level Analysis) para detectar retoque localizado.
- PRNU aproximado para consistencia de ruido de sensor.
- Metricas de ruido por zonas y grid JPEG inconsistente.
- Clasificacion visual con IA para validar que la evidencia es documental.

### 3) Telemetria y reporte

- Consola de telemetria estilo terminal durante el flujo de auditoria.
- Prefijos operativos: `[AUDIT]`, `[CHECK]`, `[FAIL]`, `[ALERTA]`.
- Informe PDF tecnico (estilo maquina de escribir) con hallazgos y contexto.
- Cadena de custodia local (hash, timestamp, veredicto, indice de anomalias).

## Stack tecnico

- **Frontend:** SvelteKit + Svelte 5
- **Backend API:** Endpoints `+server.ts` en SvelteKit
- **Procesado documento:** `mammoth`, `jszip`, `pdfjs-dist`
- **OCR basico en PDF sin texto:** `tesseract.js`
- **IA:** Groq (linguistico y visual)
- **PDF report:** `jspdf`

## Estructura relevante

- `src/routes/+page.svelte` -> UI principal, telemetria, flujo de auditoria y generacion de informe.
- `src/routes/api/audit-document/+server.ts` -> pipeline forense de documentos.
- `src/routes/api/audit-image-ai/+server.ts` -> clasificacion/analisis visual IA.
- `src/lib/components/` -> componentes de interfaz.

## Variables de entorno

Crea `.env` local (no versionar):

```bash
GROQ_API_KEY=tu_api_key
PUBLIC_SITE_URL=http://localhost:5173
```

## Ejecutar en local

```bash
npm install
npm run dev
```

Chequeos recomendados:

```bash
npm run check
npm run build
```

## Despliegue en Vercel

1. Sube el repo a GitHub.
2. Importa el repo en Vercel.
3. Verifica deteccion de framework (SvelteKit).
4. Configura variables:
   - `GROQ_API_KEY`
   - `PUBLIC_SITE_URL` (url final de Vercel)
5. Despliega.

## Politica de veredictos

- `integro`: señales consistentes y cobertura suficiente.
- `anomalias_detectadas`: presencia de señales tecnicas relevantes.
- `no_concluyente`: evidencia insuficiente o inconsistente para afirmar.

El sistema prioriza reducir falsos positivos en contextos academicos y periciales.

## Limitaciones conocidas

- La validacion de firma PDF en MVP es **estructural**, no PKI completa.
- OCR basico se ejecuta en primer bloque/portada en PDFs sin capa textual.
- Ningun detector es infalible: el veredicto final siempre requiere criterio humano.

## Uso responsable

ScanIt es una herramienta de apoyo tecnico.  
No sustituye evaluacion humana ni asesoramiento legal/pericial formal.
