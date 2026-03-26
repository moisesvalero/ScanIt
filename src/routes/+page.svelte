<script lang="ts">
  import { jsPDF } from 'jspdf';
  import { env } from '$env/dynamic/public';
  import { seo, setSeo } from '$lib/seo';
  import LanguageSelect from '$lib/components/LanguageSelect.svelte';
  import { locale, t } from '$lib/i18n/index.js';
  import { onDestroy, onMount } from 'svelte';
  import { fade, fly } from 'svelte/transition';
  import mammoth from 'mammoth';
  import { tick } from 'svelte';

  type Verdict = 'integro' | 'anomalias_detectadas' | 'no_concluyente';
  type Anomaly = { code: string; severity: 'green' | 'amber' | 'red'; message: string };

  type DocumentResult = {
    suite: string;
    mode: string;
    analysisVersion?: string;
    fileName: string;
    extension: 'docx' | 'pdf';
    serverSha256?: string;
    timeline: { created: string | null; modified: string | null };
    metrics: {
      wordCount: number;
      editingMinutes: number | null;
      pageCount: number | null;
      ratioWordsPerMinute: number | null;
      textEntropy: number;
      syntaxUniformityCoefficient: number | null;
      lexicalDiversity?: number;
      styleConsistencyIndex?: number;
    };
    metadata: Record<string, unknown>;
    anomalies: Anomaly[];
    anomalyIndex: number;
    verdict: Verdict;
    policy?: { zeroGuessing: boolean; forcedNoConclusive: boolean; reason: string | null };
    evidenceCoverage?: {
      timelineComplete: boolean;
      editingTimeAvailable: boolean;
      ratioAvailable: boolean;
      textualSampleSufficient: boolean;
      linguisticAiAvailable: boolean;
      digitalSignature?: boolean;
      officialPdfSource?: boolean;
      docxInternalMetadataConsistent?: boolean;
      pdfSignatureStatus?: string;
    };
    ocrStatus?: { state: 'recommended' | 'not_required'; reason: string };
    pdfSignature?: { hasSignature: boolean; status: string; reason: string };
    ocrProbe?: { sample: string; chars: number; source: 'tesseract-first-page' };
    confidence?: { score: number; reasons: string[] };
    linguisticAi: { suspicionPercent: number; reasons: string[] } | null;
    linguisticAiStatus?: { state: 'ok' | 'omitted' | 'error'; reason: string } | null;
  };

  type ImageResult = {
    fileName: string;
    width: number;
    height: number;
    elaScore: number;
    prnuScore: number;
    noiseConsistency?: number;
    jpegGridInconsistency?: number;
    anomalyIndex: number;
    anomalies: Anomaly[];
    verdict: Verdict;
    visualAi: {
      suspicionPercent: number;
      reasons: string[];
      origin: 'Origen: Dispositivo Digital (Captura)' | 'Origen: Captura Óptica (Cámara)';
      ocrTextSample?: string;
      ocrEstimatedChars?: number;
      styleConsistency?: number;
    } | null;
    visualAiStatus?: { state: 'ok' | 'omitted' | 'error' | 'blocked'; reason: string } | null;
    visualPrecheck?: {
      allowed: boolean;
      category: 'documento' | 'captura_software' | 'texto_academico' | 'irrelevante';
      reason: string;
    } | null;
    evidenceCoverage?: {
      ocrReadable: boolean;
      styleConsistencyAvailable: boolean;
      pixelForensicsAvailable: boolean;
      visualAiAvailable: boolean;
    };
    confidence?: { score: number; reasons: string[] };
    policy?: { zeroGuessing: boolean; forcedNoConclusive: boolean; reason: string | null };
  };

  const baseUrl = new URL(env.PUBLIC_SITE_URL || 'http://localhost:5173').toString().replace(/\/$/, '');
  setSeo({
    title: 'ScanIt | Suite Forense de Integridad Academica',
    description:
      'Auditoria pericial de documentos e imagenes con evidencias tecnicas verificables y politica conservadora de no concluyente.',
    ogTitle: 'ScanIt - Certificacion Forense Academica',
    ogDescription: 'Suite de auditoria para institutos y universidades.',
    canonical: `${baseUrl}/`,
    ogUrl: `${baseUrl}/`,
    ogImage: `${baseUrl}/og-image.png`,
    twitterCard: 'summary_large_image'
  });

  let mode = $state<'document' | 'image'>('document');
  let busy = $state(false);
  let documentFile = $state<File | null>(null);
  let imageFile = $state<File | null>(null);
  let imagePreview = $state('');
  let documentHash = $state('');
  let imageHash = $state('');
  let documentResult = $state<DocumentResult | null>(null);
  let imageResult = $state<ImageResult | null>(null);
  let error = $state('');
  let generatedAt = $state('');
  let dragActive = $state(false);
  let scanLogs = $state<string[]>([]);
  let scanStep = $state(0);
  let activeTelemetryKind = $state<'document' | 'image' | null>(null);
  let showResult = $state(false);
  let visualScanning = $state(false);
  let scanStartedAt = $state(0);
  const MIN_CINEMATIC_MS = 15_000;
  const MAX_LOG_LINES = 42;

  let documentInputRef: HTMLInputElement | null = $state(null);
  let imageInputRef: HTMLInputElement | null = $state(null);
  let telemetryTimer: ReturnType<typeof setInterval> | null = null;
  let docPreviewKind = $state<'pdf' | 'docx' | null>(null);
  let docPreviewHtml = $state('');
  let docPreviewLoading = $state(false);
  let docPreviewPdfUrl = $state('');
  let pendingDocPreviewFile = $state<File | null>(null);
  let docPreviewError = $state('');
  let footerClock = $state('--:--');
  let footerGeo = $state('Local');
  let footerTimer: ReturnType<typeof setInterval> | null = null;
  let idleTelemetryTimer: ReturnType<typeof setInterval> | null = null;
  let showScienceModal = $state(false);
  let showResultModal = $state(false);
  let cursorX = $state(0);
  let cursorY = $state(0);
  let cursorVisible = $state(false);
  let cursorHover = $state(false);
  let customCursorEnabled = $state(true);
  let glitchSha = $state('');
  let glitchPercent = $state('');
  let glitchActive = $state(false);
  let glitchTimer: ReturnType<typeof setInterval> | null = null;

  function l(map: Record<string, string>) {
    return map[$locale] ?? map.en ?? map.es ?? '';
  }

  function appendCustodyRecord(entry: {
    mode: 'document' | 'image';
    fileName: string;
    hash: string;
    verdict: Verdict;
    anomalyIndex: number;
    confidenceScore?: number | null;
  }) {
    try {
      const key = 'scanit_chain_of_custody_v1';
      const current = JSON.parse(localStorage.getItem(key) || '[]') as any[];
      const next = [
        ...current.slice(-39),
        {
          ...entry,
          timestamp: new Date().toISOString(),
          appVersion: 'scanit-forensics-1.0.0'
        }
      ];
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      // No rompe auditoria si el almacenamiento local falla.
    }
  }

  function docLogs() {
    return [
      l({ es: '[SISTEMA] Listo para analizar...', en: '[SYSTEM] Ready to analyze...', fr: '[SYSTEME] Pret pour analyser...', de: '[SYSTEM] Bereit zur Analyse...', pt: '[SISTEMA] Pronto para analisar...', ru: '[СИСТЕМА] Готово к анализу...', zh: '[系统] 已准备分析...', ar: '[النظام] جاهز للتحليل...', hi: '[सिस्टम] विश्लेषण के लिए तैयार...' }),
      l({ es: '[CHECK] Esperando archivo...', en: '[CHECK] Waiting for file...', fr: '[CHECK] En attente du fichier...', de: '[CHECK] Warte auf Datei...', pt: '[CHECK] Aguardando arquivo...', ru: '[CHECK] Ожидание файла...', zh: '[CHECK] 等待文件中...', ar: '[CHECK] في انتظار الملف...', hi: '[CHECK] फ़ाइल की प्रतीक्षा...' }),
      l({ es: 'Analizando SHA-256...', en: 'Analyzing SHA-256...', fr: 'Analyse de SHA-256...', de: 'SHA-256 wird analysiert...', pt: 'Analisando SHA-256...', ru: 'Анализ SHA-256...', zh: '正在分析 SHA-256...', ar: 'جار تحليل SHA-256...', hi: 'SHA-256 का विश्लेषण...' }),
      l({ es: 'Verificando firmas digitales del archivo...', en: 'Checking file digital signatures...', fr: 'Verification des signatures numeriques du fichier...', de: 'Digitale Signaturen der Datei werden geprueft...', pt: 'Verificando assinaturas digitais do arquivo...', ru: 'Проверка цифровых подписей файла...', zh: '正在验证文件数字签名...', ar: 'جار التحقق من التواقيع الرقمية للملف...', hi: 'फ़ाइल के डिजिटल हस्ताक्षर जाँचे जा रहे हैं...' }),
      l({ es: 'Extrayendo metadatos DOCX/PDF...', en: 'Extracting DOCX/PDF metadata...', fr: 'Extraction des metadonnees DOCX/PDF...', de: 'DOCX/PDF-Metadaten werden extrahiert...', pt: 'Extraindo metadados DOCX/PDF...', ru: 'Извлечение метаданных DOCX/PDF...', zh: '正在提取 DOCX/PDF 元数据...', ar: 'جار استخراج بيانات DOCX/PDF الوصفية...', hi: 'DOCX/PDF मेटाडेटा निकाला जा रहा है...' }),
      l({ es: 'Analizando estructura XML del DOCX...', en: 'Analyzing DOCX XML structure...', fr: 'Analyse de la structure XML du DOCX...', de: 'DOCX-XML-Struktur wird analysiert...', pt: 'Analisando estrutura XML do DOCX...', ru: 'Анализ XML-структуры DOCX...', zh: '正在分析 DOCX XML 结构...', ar: 'جار تحليل بنية XML في DOCX...', hi: 'DOCX XML संरचना का विश्लेषण...' }),
      l({ es: 'Leyendo propiedades de creacion/modificacion...', en: 'Reading creation/modification properties...', fr: 'Lecture des proprietes de creation/modification...', de: 'Eigenschaften fuer Erstellung/Aenderung werden gelesen...', pt: 'Lendo propriedades de criacao/modificacao...', ru: 'Чтение свойств создания/изменения...', zh: '正在读取创建/修改属性...', ar: 'جار قراءة خصائص الإنشاء/التعديل...', hi: 'निर्माण/संशोधन गुण पढ़े जा रहे हैं...' }),
      l({ es: 'Calculando editing time vs word count...', en: 'Calculating editing time vs word count...', fr: 'Calcul du temps d edition vs nombre de mots...', de: 'Bearbeitungszeit vs. Wortanzahl wird berechnet...', pt: 'Calculando tempo de edicao vs contagem de palavras...', ru: 'Расчет времени редактирования и количества слов...', zh: '正在计算编辑时间与词数比...', ar: 'جار حساب وقت التحرير مقابل عدد الكلمات...', hi: 'एडिटिंग समय बनाम शब्द संख्या की गणना...' }),
      l({ es: 'Analizando estructura y huellas de exportacion...', en: 'Analyzing structure and export traces...', fr: 'Analyse de la structure et des traces d export...', de: 'Struktur und Exportspuren werden analysiert...', pt: 'Analisando estrutura e rastros de exportacao...', ru: 'Анализ структуры и следов экспорта...', zh: '正在分析结构与导出痕迹...', ar: 'جار تحليل البنية وآثار التصدير...', hi: 'संरचना और एक्सपोर्ट ट्रेस का विश्लेषण...' }),
      l({ es: 'Calculando entropia y uniformidad sintactica...', en: 'Calculating entropy and syntactic uniformity...', fr: 'Calcul de l entropie et de l uniformite syntaxique...', de: 'Entropie und syntaktische Gleichfoermigkeit werden berechnet...', pt: 'Calculando entropia e uniformidade sintatica...', ru: 'Расчет энтропии и синтаксической однородности...', zh: '正在计算熵与句法一致性...', ar: 'جار حساب الإنتروبيا والاتساق النحوي...', hi: 'एंट्रॉपी और वाक्य-विन्यास एकरूपता की गणना...' }),
      l({ es: 'CAPA 2: Ejecutando analisis de consistencia de estilo...', en: 'LAYER 2: Running style consistency analysis...', fr: 'COUCHE 2 : Analyse de la coherence de style...', de: 'SCHICHT 2: Stilkonsistenz-Analyse wird ausgefuehrt...', pt: 'CAMADA 2: Executando analise de consistencia de estilo...', ru: 'СЛОЙ 2: Анализ согласованности стиля...', zh: '第2层：正在执行风格一致性分析...', ar: 'الطبقة 2: تنفيذ تحليل اتساق الأسلوب...', hi: 'परत 2: शैली सुसंगतता विश्लेषण चल रहा है...' }),
      l({ es: 'Correlacionando señales IA + metadatos forenses...', en: 'Correlating AI signals + forensic metadata...', fr: 'Correlation des signaux IA + metadonnees techniques...', de: 'KI-Signale + forensische Metadaten werden korreliert...', pt: 'Correlacionando sinais de IA + metadados tecnicos...', ru: 'Сопоставление сигналов ИИ и технических метаданных...', zh: '正在关联 AI 信号与技术元数据...', ar: 'جار ربط إشارات الذكاء الاصطناعي مع البيانات الوصفية التقنية...', hi: 'AI संकेत + तकनीकी मेटाडेटा का सहसंबंध...' }),
      l({ es: 'Correlacionando anomalias...', en: 'Correlating anomalies...', fr: 'Correlation des anomalies...', de: 'Anomalien werden korreliert...', pt: 'Correlacionando anomalias...', ru: 'Сопоставление аномалий...', zh: '正在关联异常...', ar: 'جار ربط الشذوذات...', hi: 'विसंगतियों का सहसंबंध...' }),
      l({ es: 'CAPA 4: Calculando cobertura de evidencia y confianza...', en: 'LAYER 4: Calculating evidence coverage and confidence...', fr: 'COUCHE 4 : Calcul de la couverture des preuves et confiance...', de: 'SCHICHT 4: Belegabdeckung und Vertrauen werden berechnet...', pt: 'CAMADA 4: Calculando cobertura de evidencias e confianca...', ru: 'СЛОЙ 4: Расчет покрытия доказательств и уверенности...', zh: '第4层：正在计算证据覆盖率与置信度...', ar: 'الطبقة 4: حساب تغطية الأدلة والثقة...', hi: 'परत 4: साक्ष्य कवरेज और कॉन्फिडेंस की गणना...' }),
      l({ es: 'CAPA 5: Aplicando reglas conservadoras Zero Guessing...', en: 'LAYER 5: Applying conservative Zero Guessing rules...', fr: 'COUCHE 5 : Application des regles conservatrices Zero Guessing...', de: 'SCHICHT 5: Konservative Zero-Guessing-Regeln werden angewandt...', pt: 'CAMADA 5: Aplicando regras conservadoras Zero Guessing...', ru: 'СЛОЙ 5: Применение консервативных правил Zero Guessing...', zh: '第5层：正在应用保守的 Zero Guessing 规则...', ar: 'الطبقة 5: تطبيق قواعد Zero Guessing المحافظة...', hi: 'परत 5: Zero Guessing के सतर्क नियम लागू...' }),
      l({ es: 'Compilando acta pericial...', en: 'Compiling technical report...', fr: 'Compilation du rapport technique...', de: 'Technischer Bericht wird erstellt...', pt: 'Compilando relatorio tecnico...', ru: 'Формирование технического отчета...', zh: '正在生成技术报告...', ar: 'جار إعداد التقرير التقني...', hi: 'तकनीकी रिपोर्ट संकलित की जा रही है...' })
    ];
  }

  function imgLogs() {
    return [
      l({ es: '[SISTEMA] Listo para analizar...', en: '[SYSTEM] Ready to analyze...', fr: '[SYSTEME] Pret pour analyser...', de: '[SYSTEM] Bereit zur Analyse...', pt: '[SISTEMA] Pronto para analisar...', ru: '[СИСТЕМА] Готово к анализу...', zh: '[系统] 已准备分析...', ar: '[النظام] جاهز للتحليل...', hi: '[सिस्टम] विश्लेषण के लिए तैयार...' }),
      l({ es: '[CHECK] Esperando archivo...', en: '[CHECK] Waiting for file...', fr: '[CHECK] En attente du fichier...', de: '[CHECK] Warte auf Datei...', pt: '[CHECK] Aguardando arquivo...', ru: '[CHECK] Ожидание файла...', zh: '[CHECK] 等待文件中...', ar: '[CHECK] في انتظار الملف...', hi: '[CHECK] फ़ाइल की प्रतीक्षा...' }),
      l({ es: 'Analizando SHA-256...', en: 'Analyzing SHA-256...', fr: 'Analyse de SHA-256...', de: 'SHA-256 wird analysiert...', pt: 'Analisando SHA-256...', ru: 'Анализ SHA-256...', zh: '正在分析 SHA-256...', ar: 'جار تحليل SHA-256...', hi: 'SHA-256 का विश्लेषण...' }),
      l({ es: 'Verificando consistencia de captura y compresion...', en: 'Checking capture and compression consistency...', fr: 'Verification de la coherence capture/compression...', de: 'Konsistenz von Aufnahme und Kompression wird geprueft...', pt: 'Verificando consistencia de captura e compressao...', ru: 'Проверка согласованности захвата и сжатия...', zh: '正在验证采集与压缩一致性...', ar: 'جار التحقق من اتساق الالتقاط والضغط...', hi: 'कैप्चर और कंप्रेशन की सुसंगतता जाँची जा रही है...' }),
      l({ es: 'Decodificando evidencia...', en: 'Decoding evidence...', fr: 'Decodage de la preuve...', de: 'Beweisdaten werden decodiert...', pt: 'Decodificando evidencia...', ru: 'Декодирование материала...', zh: '正在解码证据...', ar: 'جار فك ترميز الدليل...', hi: 'साक्ष्य डिकोड किया जा रहा है...' }),
      l({ es: 'Clasificando tipo de contenido con IA de pre-validacion...', en: 'Classifying content type with AI pre-validation...', fr: 'Classification du contenu avec pre-validation IA...', de: 'Inhaltstyp mit KI-Vorvalidierung wird klassifiziert...', pt: 'Classificando tipo de conteudo com pre-validacao de IA...', ru: 'Классификация типа контента с ИИ-предпроверкой...', zh: '正在使用 AI 预校验分类内容类型...', ar: 'جار تصنيف نوع المحتوى عبر تحقق أولي بالذكاء الاصطناعي...', hi: 'AI प्री-वैलिडेशन से कंटेंट टाइप वर्गीकृत हो रहा है...' }),
      l({ es: 'Revisando zonas con posible edicion...', en: 'Reviewing areas with possible edits...', fr: 'Analyse des zones avec edition possible...', de: 'Bereiche mit moeglicher Bearbeitung werden geprueft...', pt: 'Revisando zonas com possivel edicao...', ru: 'Проверка зон с возможным редактированием...', zh: '正在检查可能编辑区域...', ar: 'جار مراجعة المناطق ذات التعديل المحتمل...', hi: 'संभावित एडिट वाले क्षेत्रों की समीक्षा...' }),
      l({ es: 'CAPA 2: Extrayendo OCR y consistencia tipografica visual...', en: 'LAYER 2: Extracting OCR and visual typography consistency...', fr: 'COUCHE 2 : Extraction OCR et coherence typographique visuelle...', de: 'SCHICHT 2: OCR und visuelle Typokonsistenz werden extrahiert...', pt: 'CAMADA 2: Extraindo OCR e consistencia tipografica visual...', ru: 'СЛОЙ 2: Извлечение OCR и визуальной типографики...', zh: '第2层：提取 OCR 与视觉排版一致性...', ar: 'الطبقة 2: استخراج OCR واتساق الطباعة بصريا...', hi: 'परत 2: OCR और दृश्य टाइपोग्राफी सुसंगतता निकाली जा रही है...' }),
      l({ es: 'Comprobando si viene de foto real de camara...', en: 'Checking if it comes from a real camera photo...', fr: 'Verification d une origine photo camera reelle...', de: 'Pruefung, ob es von einem echten Kamerafoto stammt...', pt: 'Verificando se vem de foto real de camera...', ru: 'Проверка, получено ли с реальной камеры...', zh: '正在检查是否来自真实相机照片...', ar: 'جار التحقق مما إذا كانت من صورة كاميرا حقيقية...', hi: 'जांच रहे हैं कि यह असली कैमरा फोटो से आया है या नहीं...' }),
      l({ es: 'Correlacionando PRNU/ELA con veredicto visual IA...', en: 'Correlating PRNU/ELA with AI visual verdict...', fr: 'Correlation PRNU/ELA avec verdict visuel IA...', de: 'PRNU/ELA wird mit KI-Bildurteil korreliert...', pt: 'Correlacionando PRNU/ELA com veredito visual da IA...', ru: 'Сопоставление PRNU/ELA с визуальным вердиктом ИИ...', zh: '正在关联 PRNU/ELA 与 AI 视觉结论...', ar: 'جار ربط PRNU/ELA مع الحكم البصري للذكاء الاصطناعي...', hi: 'PRNU/ELA को AI विज़ुअल निर्णय से जोड़ा जा रहा है...' }),
      l({ es: 'CAPA 3: Analisis de ruido y pixeles de frontera...', en: 'LAYER 3: Noise and edge-pixel analysis...', fr: 'COUCHE 3 : Analyse du bruit et des pixels de bord...', de: 'SCHICHT 3: Rausch- und Randpixelanalyse...', pt: 'CAMADA 3: Analise de ruido e pixels de borda...', ru: 'СЛОЙ 3: Анализ шума и граничных пикселей...', zh: '第3层：噪声与边界像素分析...', ar: 'الطبقة 3: تحليل الضوضاء وبكسلات الحواف...', hi: 'परत 3: शोर और किनारे-पिक्सेल विश्लेषण...' }),
      l({ es: 'Normalizando metricas...', en: 'Normalizing metrics...', fr: 'Normalisation des metriques...', de: 'Metriken werden normalisiert...', pt: 'Normalizando metricas...', ru: 'Нормализация метрик...', zh: '正在标准化指标...', ar: 'جار توحيد المقاييس...', hi: 'मेट्रिक्स नॉर्मलाइज़ किए जा रहे हैं...' }),
      l({ es: 'CAPA 4: Calculando cobertura visual y confianza...', en: 'LAYER 4: Calculating visual coverage and confidence...', fr: 'COUCHE 4 : Calcul de couverture visuelle et confiance...', de: 'SCHICHT 4: Visuelle Abdeckung und Vertrauen werden berechnet...', pt: 'CAMADA 4: Calculando cobertura visual e confianca...', ru: 'СЛОЙ 4: Расчет визуального покрытия и уверенности...', zh: '第4层：正在计算视觉覆盖率与置信度...', ar: 'الطبقة 4: حساب التغطية البصرية والثقة...', hi: 'परत 4: दृश्य कवरेज और कॉन्फिडेंस की गणना...' }),
      l({ es: 'CAPA 5: Aplicando reglas conservadoras Zero Guessing...', en: 'LAYER 5: Applying conservative Zero Guessing rules...', fr: 'COUCHE 5 : Application des regles conservatrices Zero Guessing...', de: 'SCHICHT 5: Konservative Zero-Guessing-Regeln werden angewandt...', pt: 'CAMADA 5: Aplicando regras conservadoras Zero Guessing...', ru: 'СЛОЙ 5: Применение консервативных правил Zero Guessing...', zh: '第5层：正在应用保守的 Zero Guessing 规则...', ar: 'الطبقة 5: تطبيق قواعد Zero Guessing المحافظة...', hi: 'परत 5: Zero Guessing के सतर्क नियम लागू...' }),
      l({ es: 'Correlacionando anomalias...', en: 'Correlating anomalies...', fr: 'Correlation des anomalies...', de: 'Anomalien werden korreliert...', pt: 'Correlacionando anomalias...', ru: 'Сопоставление аномалий...', zh: '正在关联异常...', ar: 'جار ربط الشذوذات...', hi: 'विसंगतियों का सहसंबंध...' }),
      l({ es: 'Compilando acta pericial...', en: 'Compiling technical report...', fr: 'Compilation du rapport technique...', de: 'Technischer Bericht wird erstellt...', pt: 'Compilando relatorio tecnico...', ru: 'Формирование технического отчета...', zh: '正在生成技术报告...', ar: 'جار إعداد التقرير التقني...', hi: 'तकनीकी रिपोर्ट संकलित की जा रही है...' })
    ];
  }
  function docKeepaliveLogs() {
    return [
      l({ es: 'Esperando respuesta del motor IA', en: 'Waiting for AI engine response', fr: 'En attente de la reponse du moteur IA', de: 'Warte auf Antwort der KI-Engine', pt: 'Aguardando resposta do motor de IA', ru: 'Ожидание ответа ИИ-движка', zh: '等待 AI 引擎响应', ar: 'في انتظار استجابة محرك الذكاء الاصطناعي', hi: 'AI इंजन के उत्तर की प्रतीक्षा' }),
      l({ es: 'Correlacionando trazas de metadatos', en: 'Correlating metadata traces', fr: 'Correlation des traces de metadonnees', de: 'Metadaten-Spuren werden korreliert', pt: 'Correlacionando rastros de metadados', ru: 'Сопоставление следов метаданных', zh: '正在关联元数据轨迹', ar: 'جار ربط آثار البيانات الوصفية', hi: 'मेटाडेटा ट्रेस का सहसंबंध' }),
      l({ es: 'Validando consistencia pericial', en: 'Validating technical consistency', fr: 'Validation de la coherence technique', de: 'Technische Konsistenz wird validiert', pt: 'Validando consistencia tecnica', ru: 'Проверка технической согласованности', zh: '正在验证技术一致性', ar: 'جار التحقق من الاتساق التقني', hi: 'तकनीकी सुसंगतता सत्यापित की जा रही है' })
    ];
  }
  function imgKeepaliveLogs() {
    return [
      l({ es: 'Esperando respuesta del detector visual IA', en: 'Waiting for AI visual detector response', fr: 'En attente de la reponse du detecteur visuel IA', de: 'Warte auf Antwort des KI-Bilddetektors', pt: 'Aguardando resposta do detector visual de IA', ru: 'Ожидание ответа визуального ИИ-детектора', zh: '等待 AI 视觉检测器响应', ar: 'في انتظار استجابة كاشف الذكاء الاصطناعي البصري', hi: 'AI विज़ुअल डिटेक्टर के उत्तर की प्रतीक्षा' }),
      l({ es: 'Fusionando señales PRNU/ELA', en: 'Merging PRNU/ELA signals', fr: 'Fusion des signaux PRNU/ELA', de: 'PRNU/ELA-Signale werden zusammengefuehrt', pt: 'Fundindo sinais PRNU/ELA', ru: 'Объединение сигналов PRNU/ELA', zh: '正在融合 PRNU/ELA 信号', ar: 'جار دمج إشارات PRNU/ELA', hi: 'PRNU/ELA संकेतों का एकीकरण' }),
      l({ es: 'Ajustando indice de riesgo visual', en: 'Adjusting visual risk index', fr: 'Ajustement de l indice de risque visuel', de: 'Visueller Risikoindex wird angepasst', pt: 'Ajustando indice de risco visual', ru: 'Настройка индекса визуального риска', zh: '正在调整视觉风险指数', ar: 'جار ضبط مؤشر المخاطر البصرية', hi: 'विज़ुअल जोखिम सूचकांक समायोजित किया जा रहा है' })
    ];
  }

  const IDLE_TELEMETRY_LINES = [
    '[SISTEMA] Listo para analizar...',
    '[CHECK] Esperando archivo...',
    '[SISTEMA] Preparando entorno...',
    '[CHECK] Todo listo para comenzar.',
    '[SISTEMA] ScanIt disponible.'
  ];

  function telemetryLocaleTag(code: string) {
    const map: Record<string, string> = {
      es: 'es-ES',
      en: 'en-US',
      fr: 'fr-FR',
      de: 'de-DE',
      pt: 'pt-PT',
      ru: 'ru-RU',
      zh: 'zh-CN',
      ar: 'ar-SA',
      hi: 'hi-IN'
    };
    return map[code] ?? 'en-US';
  }

  function telemetrySequence(kind: 'document' | 'image') {
    return kind === 'document' ? docLogs() : imgLogs();
  }

  function telemetryKeepalive(kind: 'document' | 'image') {
    return kind === 'document' ? docKeepaliveLogs() : imgKeepaliveLogs();
  }

  function telemetryLineAt(kind: 'document' | 'image', idx: number) {
    const seq = telemetrySequence(kind);
    if (idx < seq.length) return seq[idx] ?? '';
    const keepalive = telemetryKeepalive(kind);
    const base = keepalive[idx % keepalive.length] ?? keepalive[0] ?? '';
    return `${base}${'.'.repeat((idx % 3) + 1)}`;
  }

  function rebuildTelemetryLogs(kind: 'document' | 'image', steps: number) {
    const rebuilt: string[] = [];
    for (let i = 0; i < steps; i += 1) {
      rebuilt.push(telemetryLineAt(kind, i));
    }
    return rebuilt.slice(-MAX_LOG_LINES);
  }

  function idleLine(idx: number) {
    const keys = [
      'scanit.telemetry.idle.ready',
      'scanit.telemetry.idle.waiting',
      'scanit.telemetry.idle.preparing',
      'scanit.telemetry.idle.done',
      'scanit.telemetry.idle.available'
    ];
    return $t(keys[idx] ?? keys[0]);
  }

  function startIdleTelemetry() {
    if (busy || visualScanning || idleTelemetryTimer) return;
    const localeTag = telemetryLocaleTag($locale);
    if (scanLogs.length === 0) {
      scanLogs = [`${idleLine(0)} ${new Date().toLocaleTimeString(localeTag)}`];
    }
    let idx = 1;
    idleTelemetryTimer = setInterval(() => {
      if (busy || visualScanning) return;
      if (idx >= IDLE_TELEMETRY_LINES.length) {
        stopIdleTelemetry();
        return;
      }
      const line = `${idleLine(idx % IDLE_TELEMETRY_LINES.length)} ${new Date().toLocaleTimeString(localeTag)}`;
      scanLogs = [...scanLogs, line].slice(-MAX_LOG_LINES);
      idx += 1;
    }, 2400);
  }

  function stopIdleTelemetry() {
    if (!idleTelemetryTimer) return;
    clearInterval(idleTelemetryTimer);
    idleTelemetryTimer = null;
  }

  function randomHexChar() {
    const chars = '0123456789abcdef';
    return chars[Math.floor(Math.random() * chars.length)];
  }

  function randomDigit() {
    return String(Math.floor(Math.random() * 10));
  }

  function nowStamp() {
    return new Date().toLocaleTimeString(telemetryLocaleTag($locale), { hour12: false });
  }

  $effect(() => {
    const activeLocale = $locale;
    if (typeof window === 'undefined') return;
    if (busy || visualScanning) return;
    stopIdleTelemetry();
    scanLogs = [`${idleLine(0)} ${new Date().toLocaleTimeString(telemetryLocaleTag(activeLocale))}`];
    startIdleTelemetry();
  });

  $effect(() => {
    const activeLocale = $locale;
    if (!activeLocale) return;
    if (!activeTelemetryKind) return;
    if (!busy && !visualScanning) return;
    scanLogs = rebuildTelemetryLogs(activeTelemetryKind, scanStep);
  });

  function telemetryLevel(line: string) {
    const l = line.toLowerCase();
    if (
      l.startsWith('error:') ||
      l.includes('[fail]') ||
      l.includes('alerta') ||
      l.includes('sospecha') ||
      l.includes('anomalia') ||
      l.includes('anomal')
    ) {
      return 'ALERT';
    }
    if (l.includes('[check]')) return 'CHECK';
    if (l.includes('[audit]')) return 'AUDIT';
    if (l.includes('groq') || l.includes('ia')) return 'AI';
    return 'SYSTEM';
  }

  function telemetryRenderLine(line: string) {
    if (/^\[\d{2}:\d{2}:\d{2}\]\s\[[A-Z]+\]/.test(line)) return line;
    return `[${nowStamp()}] [${telemetryLevel(line)}] ${line}`;
  }

  function isAnomalyTelemetryLine(line: string) {
    const l = line.toLowerCase();
    return l.includes('alerta') || l.includes('sospecha') || l.includes('timeline') || l.includes('ratio');
  }

  function telemetryPrefixClass(line: string) {
    const l = line.toLowerCase();
    if (l.includes('[fail]') || l.startsWith('error:')) return 'telemetry-line-fail';
    if (l.includes('[check]')) return 'telemetry-line-check';
    if (l.includes('[audit]')) return 'telemetry-line-audit';
    return '';
  }

  function startDataGlitch(finalSha: string, finalPercent: string) {
    if (glitchTimer) {
      clearInterval(glitchTimer);
      glitchTimer = null;
    }
    glitchActive = true;
    const start = Date.now();
    const duration = 520;
    glitchTimer = setInterval(() => {
      const elapsed = Date.now() - start;
      if (elapsed >= duration) {
        if (glitchTimer) clearInterval(glitchTimer);
        glitchTimer = null;
        glitchSha = finalSha;
        glitchPercent = finalPercent;
        glitchActive = false;
        return;
      }
      glitchSha = finalSha
        .split('')
        .map((ch) => (/^[0-9a-f]$/i.test(ch) ? randomHexChar() : ch))
        .join('');
      glitchPercent = finalPercent
        .split('')
        .map((ch) => (/\d/.test(ch) ? randomDigit() : ch))
        .join('');
    }, 55);
  }

  function resetTelemetry() {
    stopIdleTelemetry();
    scanLogs = [];
    scanStep = 0;
    activeTelemetryKind = null;
    showResult = false;
    showResultModal = false;
    visualScanning = false;
    scanStartedAt = 0;
    if (telemetryTimer) {
      clearInterval(telemetryTimer);
      telemetryTimer = null;
    }
  }

  function startTelemetry(kind: 'document' | 'image') {
    stopIdleTelemetry();
    resetTelemetry();
    activeTelemetryKind = kind;
    visualScanning = true;
    scanStartedAt = Date.now();
    const seq = telemetrySequence(kind);
    scanLogs = [seq[0]];
    scanStep = 1;
    telemetryTimer = setInterval(() => {
      if (scanStep < seq.length) {
        const liveSeq = telemetrySequence(kind);
        scanLogs = [...scanLogs, liveSeq[scanStep]].slice(-MAX_LOG_LINES);
        scanStep += 1;
        return;
      }
      const keepAlive = telemetryKeepalive(kind);
      const dots = '.'.repeat((scanStep % 3) + 1);
      const msg = `${keepAlive[scanStep % keepAlive.length]}${dots}`;
      scanLogs = [...scanLogs, msg].slice(-MAX_LOG_LINES);
      scanStep += 1;
    }, 780);
  }

  function finishTelemetry() {
    if (telemetryTimer) {
      clearInterval(telemetryTimer);
      telemetryTimer = null;
    }
    const elapsed = scanStartedAt ? Date.now() - scanStartedAt : MIN_CINEMATIC_MS;
    const remaining = Math.max(0, MIN_CINEMATIC_MS - elapsed);
    window.setTimeout(() => {
      showResult = true;
      visualScanning = false;
      activeTelemetryKind = null;
      if (documentResult || imageResult) {
        showResultModal = true;
        if (mode === 'document' && documentResult) {
          const pct = documentResult.linguisticAi ? `${documentResult.linguisticAi.suspicionPercent.toFixed(0)}%` : 'N/D';
          startDataGlitch(documentHash, pct);
        } else if (mode === 'image' && imageResult) {
          const pct = imageResult.visualAi ? `${imageResult.visualAi.suspicionPercent.toFixed(0)}%` : 'N/D';
          startDataGlitch(imageHash, pct);
        }
        startIdleTelemetry();
      } else {
        startIdleTelemetry();
      }
    }, remaining);
  }

  function reopenResultModal() {
    if (!showResult) return;
    if (mode === 'document' && !documentResult) return;
    if (mode === 'image' && !imageResult) return;
    showResultModal = true;
  }

  function updateFooterClock() {
    const now = new Date();
    footerClock = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Local';
    const city = tz.split('/').pop()?.replace(/_/g, ' ') || 'Local';
    const locale = (navigator.language || 'es-ES').toUpperCase();
    const region = locale.includes('-') ? locale.split('-').pop() : locale;
    footerGeo = `${city} / ${region}`;
  }

  onMount(() => {
    updateFooterClock();
    footerTimer = setInterval(updateFooterClock, 1000);
    customCursorEnabled = !('ontouchstart' in window) && (navigator.maxTouchPoints ?? 0) === 0;
    startIdleTelemetry();
    const isInteractive = (el: EventTarget | null) =>
      el instanceof Element && Boolean(el.closest('button, a, input, [role="button"]'));
    const onMouseMove = (e: MouseEvent) => {
      if (!customCursorEnabled) return;
      cursorX = e.clientX;
      cursorY = e.clientY;
      cursorVisible = true;
      cursorHover = isInteractive(e.target);
    };
    const onMouseLeave = () => {
      cursorVisible = false;
      cursorHover = false;
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseout', onMouseLeave);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseout', onMouseLeave);
    };
  });

  onDestroy(() => {
    if (telemetryTimer) clearInterval(telemetryTimer);
    if (footerTimer) clearInterval(footerTimer);
    if (idleTelemetryTimer) clearInterval(idleTelemetryTimer);
    if (glitchTimer) clearInterval(glitchTimer);
    if (docPreviewPdfUrl) URL.revokeObjectURL(docPreviewPdfUrl);
  });

  function requestDocumentPreview(file: File) {
    const lower = file.name.toLowerCase();
    docPreviewHtml = '';
    docPreviewLoading = false;
    docPreviewError = '';
    if (docPreviewPdfUrl) URL.revokeObjectURL(docPreviewPdfUrl);
    docPreviewPdfUrl = '';
    pendingDocPreviewFile = file;
    if (lower.endsWith('.pdf')) {
      docPreviewKind = 'pdf';
      docPreviewPdfUrl = URL.createObjectURL(file);
      pendingDocPreviewFile = null;
      return;
    }
    if (lower.endsWith('.docx')) {
      docPreviewKind = 'docx';
      docPreviewLoading = true;
      return;
    }
    docPreviewKind = null;
    pendingDocPreviewFile = null;
  }

  $effect(() => {
    const f = pendingDocPreviewFile;
    const kind = docPreviewKind;
    void (async () => {
      if (!f || kind !== 'docx') return;
      try {
        await tick();
        const buf = await f.arrayBuffer();
        const converted = await mammoth.convertToHtml({ arrayBuffer: buf as any });
        const htmlBody = String(converted?.value ?? '').trim();
        const safeBody = htmlBody || '<p>Documento sin contenido extraible en vista previa.</p>';
        docPreviewHtml = `<!doctype html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root { color-scheme: light; }
    html, body {
      margin: 0;
      padding: 0;
      background: #0a1018;
      font-family: Inter, Arial, sans-serif;
    }
    .sheet-wrap {
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: flex-start;
      padding: 20px;
      box-sizing: border-box;
    }
    .sheet {
      width: min(820px, 100%);
      background: #fff;
      color: #111827;
      border-radius: 8px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.28);
      padding: 36px 44px;
      box-sizing: border-box;
      overflow-wrap: anywhere;
      line-height: 1.45;
      font-size: 14px;
    }
    p { margin: 0 0 0.8em; }
  </style>
</head>
<body>
  <div class="sheet-wrap">
    <article class="sheet">${safeBody}</article>
  </div>
</body>
</html>`;
      } catch {
        docPreviewError = 'No se pudo generar la vista previa del documento.';
        docPreviewHtml = '';
      } finally {
        docPreviewLoading = false;
        pendingDocPreviewFile = null;
      }
    })();
  });

  const verdictLabel: Record<Verdict, string> = {
    integro: 'Integro',
    anomalias_detectadas: 'Anomalias detectadas',
    no_concluyente: 'No concluyente'
  };

  function currentVerdict(): Verdict | null {
    if (mode === 'document') return documentResult?.verdict ?? null;
    return imageResult?.verdict ?? null;
  }

  function downloadToneClass() {
    const verdict = currentVerdict();
    if (verdict === 'integro') return 'is-clean';
    if (verdict === 'anomalias_detectadas') return 'is-suspicious';
    if (verdict === 'no_concluyente') return 'is-inconclusive';
    return '';
  }

  function panicCriticalActive() {
    const docCritical = (documentResult?.linguisticAi?.suspicionPercent ?? 0) >= 100;
    const imgCritical = (imageResult?.visualAi?.suspicionPercent ?? 0) >= 100;
    return docCritical || imgCritical;
  }

  function coverageTone(score: number | null | undefined) {
    if (typeof score !== 'number') return 'coverage-amber';
    if (score >= 80) return 'coverage-green';
    if (score >= 55) return 'coverage-amber';
    return 'coverage-red';
  }

  async function hashSha256(file: File) {
    const data = await file.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', data);
    const arr = Array.from(new Uint8Array(digest));
    return arr.map((x) => x.toString(16).padStart(2, '0')).join('');
  }

  function onSelectDocument(event: Event) {
    const target = event.currentTarget as HTMLInputElement;
    documentFile = target.files?.[0] ?? null;
    documentResult = null;
    error = '';
    showResult = false;
    if (documentFile) requestDocumentPreview(documentFile);
    startIdleTelemetry();
  }

  function onSelectImage(event: Event) {
    const target = event.currentTarget as HTMLInputElement;
    imageFile = target.files?.[0] ?? null;
    imageResult = null;
    error = '';
    showResult = false;
    if (imagePreview) URL.revokeObjectURL(imagePreview);
    imagePreview = imageFile ? URL.createObjectURL(imageFile) : '';
    startIdleTelemetry();
  }

  function onDragOver(e: DragEvent) {
    e.preventDefault();
    dragActive = true;
  }
  function onDragLeave(e: DragEvent) {
    e.preventDefault();
    dragActive = false;
  }
  function onDrop(e: DragEvent) {
    e.preventDefault();
    dragActive = false;
    const file = e.dataTransfer?.files?.[0] ?? null;
    if (!file) return;
    if (mode === 'document') {
      if (!/\.(docx|pdf)$/i.test(file.name)) {
        error = 'Formato no soportado. Usa .docx o .pdf.';
        return;
      }
      documentFile = file;
      documentResult = null;
      showResult = false;
      error = '';
      requestDocumentPreview(file);
      startIdleTelemetry();
      return;
    }
    if (!file.type.startsWith('image/')) {
      error = 'Formato no soportado. Usa una imagen.';
      return;
    }
    imageFile = file;
    imageResult = null;
    showResult = false;
    error = '';
    if (imagePreview) URL.revokeObjectURL(imagePreview);
    imagePreview = URL.createObjectURL(file);
    startIdleTelemetry();
  }

  async function auditDocument() {
    if (!documentFile) return;
    busy = true;
    error = '';
    startTelemetry('document');
    try {
      scanLogs = [...scanLogs, 'Preparando hash SHA-256...'];
      documentHash = await hashSha256(documentFile);
      scanLogs = [...scanLogs, 'Enviando a extractor forense...'];
      const form = new FormData();
      form.append('file', documentFile);
      const response = await fetch('/api/audit-document', { method: 'POST', body: form });
      if (!response.ok) {
        let serverMsg = '';
        try {
          const body = await response.json();
          serverMsg = String(body?.error || body?.message || '').trim();
          if (body?.details)
            scanLogs = [...scanLogs, `Diagnostico: ${String(body.details).slice(0, 160)}`].slice(-MAX_LOG_LINES);
        } catch {
          serverMsg = (await response.text()).slice(0, 180);
        }
        throw new Error(serverMsg || 'No se pudo auditar el documento.');
      }
      scanLogs = [...scanLogs, 'Verificando consistencia de respuesta...'];
      documentResult = await response.json();
      scanLogs = [...scanLogs, '[AUDIT] Correlacion de metadatos y firma interna completada.'].slice(-MAX_LOG_LINES);
      if (documentResult?.anomalies?.some((a) => a.code === 'DOCX_AUTHOR_MISMATCH' || a.code === 'DOCX_TIMELINE_MISMATCH')) {
        scanLogs = [...scanLogs, '[ALERTA] Inconsistencia en metadatos internos DOCX.'].slice(-MAX_LOG_LINES);
      }
      if (documentResult?.pdfSignature) {
        const sigStatus = String(documentResult.pdfSignature.status || 'unknown');
        const sigPrefix = sigStatus === 'structural_tampered' ? '[FAIL]' : '[CHECK]';
        scanLogs = [...scanLogs, `${sigPrefix} Firma PDF: ${documentResult.pdfSignature.reason}`].slice(-MAX_LOG_LINES);
      }
      scanLogs = [...scanLogs, 'CAPA 2: evaluando consistencia de estilo y entropia textual...'].slice(-MAX_LOG_LINES);
      if (documentResult?.extension === 'pdf') {
        const pages = documentResult.metrics?.pageCount;
        if (typeof pages === 'number' && pages > 0) {
          scanLogs = [...scanLogs, `Paginas detectadas: ${pages}`].slice(-MAX_LOG_LINES);
          scanLogs = [...scanLogs, `Extraccion de texto completada: ${pages}/${pages} paginas.`].slice(
            -MAX_LOG_LINES
          );
        }
      }
      if (documentResult?.linguisticAi) {
        scanLogs = [...scanLogs, 'Veredicto lingüistico (Groq) recibido...'];
        if (documentResult.linguisticAi.suspicionPercent >= 100) {
          scanLogs = [...scanLogs, 'ALERTA CRITICA: sospecha del 100% detectada.'].slice(-MAX_LOG_LINES);
        }
      } else {
        const reason =
          documentResult?.linguisticAiStatus?.reason ?? 'Analisis lingüistico opcional omitido en esta auditoria.';
        scanLogs = [...scanLogs, `Analisis lingüistico omitido: ${reason}`].slice(-MAX_LOG_LINES);
        const lowerReason = reason.toLowerCase();
        if (lowerReason.includes('dibujo') || lowerReason.includes('no textual') || lowerReason.includes('insuficiente')) {
          scanLogs = [...scanLogs, 'ERROR: Contenido no apto para auditoría académica.'].slice(-MAX_LOG_LINES);
        }
      }
      if (documentResult?.policy?.forcedNoConclusive && documentResult?.policy?.reason) {
        scanLogs = [...scanLogs, `ALERTA: ${documentResult.policy.reason}`].slice(-MAX_LOG_LINES);
      }
      if (documentResult?.confidence) {
        scanLogs = [...scanLogs, `CAPA 4: cobertura de evidencia ${documentResult.confidence.score}/100`].slice(-MAX_LOG_LINES);
      }
      if (documentResult?.ocrStatus?.state === 'recommended') {
        scanLogs = [...scanLogs, `[AUDIT] OCR requerido: ${documentResult.ocrStatus.reason}`].slice(-MAX_LOG_LINES);
        const ocrProbe = await runBasicPdfOcrProbe(documentFile, (line) => {
          scanLogs = [...scanLogs, line].slice(-MAX_LOG_LINES);
        });
        if (ocrProbe) {
          documentResult.ocrProbe = ocrProbe;
          if (ocrProbe.chars < 20) {
            scanLogs = [...scanLogs, '[FAIL] OCR detecta contenido insuficiente en portada/bloque inicial.'].slice(-MAX_LOG_LINES);
            documentResult.anomalies = [
              ...documentResult.anomalies,
              {
                code: 'PDF_OCR_EMPTY',
                severity: 'red',
                message: 'OCR basico: portada y primer bloque con texto insuficiente para sostener veredicto positivo.'
              }
            ];
            documentResult.verdict = 'no_concluyente';
            documentResult.policy = {
              zeroGuessing: true,
              forcedNoConclusive: true,
              reason: 'Zero Guessing Policy: OCR basico no encuentra contenido textual suficiente en el PDF sin capa de texto.'
            };
          } else {
            scanLogs = [...scanLogs, `[CHECK] OCR basico OK (${ocrProbe.chars} caracteres estimados).`].slice(-MAX_LOG_LINES);
          }
        } else {
          scanLogs = [...scanLogs, '[FAIL] OCR basico no pudo ejecutarse.'].slice(-MAX_LOG_LINES);
        }
      }
      if (
        documentResult &&
        documentResult.metrics.wordCount > 1000 &&
        typeof documentResult.metrics.editingMinutes === 'number' &&
        documentResult.metrics.editingMinutes < 20 &&
        documentResult.verdict === 'integro'
      ) {
        scanLogs = [...scanLogs, '[FAIL] Correlacion obligatoria: ratio temporal incompatible con veredicto integro.'].slice(-MAX_LOG_LINES);
        documentResult.verdict = 'no_concluyente';
        documentResult.policy = {
          zeroGuessing: true,
          forcedNoConclusive: true,
          reason:
            'Correlacion obligatoria: texto extenso generado en ventana temporal anomala para una sesion nueva; se bloquea veredicto positivo.'
        };
      } else {
        scanLogs = [...scanLogs, '[CHECK] Correlacion obligatoria de timeline/volumen completada.'].slice(-MAX_LOG_LINES);
      }
      if (documentResult) {
        appendCustodyRecord({
          mode: 'document',
          fileName: documentResult.fileName,
          hash: documentHash,
          verdict: documentResult.verdict,
          anomalyIndex: documentResult.anomalyIndex,
          confidenceScore: documentResult.confidence?.score ?? null
        });
      }
      generatedAt = new Date().toISOString();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Error inesperado.';
    } finally {
      busy = false;
      finishTelemetry();
    }
  }

  async function auditImage() {
    if (!imageFile || !imagePreview) return;
    busy = true;
    error = '';
    startTelemetry('image');
    try {
      scanLogs = [...scanLogs, 'Preparando hash SHA-256...'];
      imageHash = await hashSha256(imageFile);
      scanLogs = [...scanLogs, 'Pre-validacion visual IA: tipo de evidencia...'].slice(-MAX_LOG_LINES);

      const form = new FormData();
      form.append('file', imageFile);

      let visualAi: {
        suspicionPercent: number;
        reasons: string[];
        origin: 'Origen: Dispositivo Digital (Captura)' | 'Origen: Captura Óptica (Cámara)';
        ocrTextSample?: string;
        ocrEstimatedChars?: number;
        styleConsistency?: number;
      } | null = null;
      let visualAiStatus: { state: 'ok' | 'omitted' | 'error' | 'blocked'; reason: string } | null = null;
      let visualPrecheck:
        | { allowed: boolean; category: 'documento' | 'captura_software' | 'texto_academico' | 'irrelevante'; reason: string }
        | null = null;
      try {
        scanLogs = [...scanLogs, 'Enviando imagen al detective visual (Groq)...'].slice(-MAX_LOG_LINES);
        const aiResp = await fetch('/api/audit-image-ai', { method: 'POST', body: form });
        if (aiResp.ok) {
          const aiBody = await aiResp.json();
          visualPrecheck = aiBody?.precheck ?? null;
          visualAi = aiBody?.verdict ?? null;
          visualAiStatus = aiBody?.status ?? null;
        } else {
          visualAiStatus = { state: 'error', reason: 'No se pudo consultar el modulo visual IA.' };
        }
      } catch (e) {
        visualAiStatus = {
          state: 'error',
          reason: `Fallo de red en analisis visual IA: ${e instanceof Error ? e.message : String(e)}`
        };
      }

      if (visualAiStatus?.state === 'blocked') {
        scanLogs = [
          ...scanLogs,
          'ERROR: Contenido no apto para auditoría académica.',
          `Motivo tecnico: ${visualPrecheck?.reason ?? 'Contenido no documental o irrelevante.'}`
        ].slice(-MAX_LOG_LINES);
        error = 'Contenido no apto para auditoría académica. Sube una evidencia documental válida.';
        return;
      }

      scanLogs = [...scanLogs, 'Cargando imagen en visor...'];
      const img = await loadImage(imagePreview);
      scanLogs = [...scanLogs, 'Analizando posibles retoques locales...'];
      const ela = runEla(img, 0.76);
      scanLogs = [...scanLogs, 'Comprobando huella de captura de camara...'];
      const prnu = estimatePrnu(img);
      scanLogs = [...scanLogs, 'CAPA 3: evaluando consistencia de ruido entre zonas...'].slice(-MAX_LOG_LINES);
      const noiseConsistency = estimateNoiseConsistency(img);
      scanLogs = [...scanLogs, 'CAPA 3: evaluando bloques de compresion y pixeles frontera...'].slice(-MAX_LOG_LINES);
      const jpegGridInconsistency = estimateJpegGridInconsistency(img);
      const anomalies: Anomaly[] = [];

      if (visualAi && visualAi.suspicionPercent >= 85) {
        anomalies.push({
          code: 'VISUAL_AI_VERY_HIGH',
          severity: 'red',
          message: `Sospecha visual IA muy alta (${visualAi.suspicionPercent.toFixed(0)}%).`
        });
      } else if (visualAi && visualAi.suspicionPercent >= 70) {
        anomalies.push({
          code: 'VISUAL_AI_HIGH',
          severity: 'amber',
          message: `Sospecha visual IA elevada (${visualAi.suspicionPercent.toFixed(0)}%).`
        });
      }
      if (noiseConsistency < 0.42) {
        anomalies.push({
          code: 'NOISE_CONSISTENCY_LOW',
          severity: 'amber',
          message: `Consistencia de ruido baja (${(noiseConsistency * 100).toFixed(0)}%): posible composicion por zonas.`
        });
      }
      if (jpegGridInconsistency > 0.5) {
        anomalies.push({
          code: 'JPEG_GRID_INCONSISTENT',
          severity: 'amber',
          message: `Patron de bloques inconsistente (${(jpegGridInconsistency * 100).toFixed(0)}%): posible edicion localizada.`
        });
      }

      const red = anomalies.filter((a) => a.severity === 'red').length;
      const amber = anomalies.filter((a) => a.severity === 'amber').length;
      let verdict: Verdict = 'no_concluyente';
      if (red > 0 || amber >= 2) verdict = 'anomalias_detectadas';
      else if (amber === 0 && prnu >= 0.15) verdict = 'integro';
      let forcedNoConclusive = false;
      let forcedReason: string | null = null;
      if (verdict === 'integro' && (!visualAi || (visualAi.ocrEstimatedChars ?? 0) < 50)) {
        verdict = 'no_concluyente';
        forcedNoConclusive = true;
        forcedReason =
          'Zero Guessing Policy: no se clasifica como integro sin cobertura OCR/visual suficiente para evidencia documental.';
      }

      if (visualAi) {
        scanLogs = [
          ...scanLogs,
          `Veredicto visual IA recibido (${visualAi.suspicionPercent.toFixed(0)}%) - ${visualAi.origin}.`
        ].slice(-MAX_LOG_LINES);
        if (visualAi.suspicionPercent >= 100) {
          scanLogs = [...scanLogs, 'ALERTA CRITICA: sospecha del 100% detectada.'].slice(-MAX_LOG_LINES);
        }
      } else if (visualAiStatus?.reason) {
        scanLogs = [...scanLogs, `Analisis visual IA omitido: ${visualAiStatus.reason}`].slice(-MAX_LOG_LINES);
      }

      imageResult = {
        fileName: imageFile.name,
        width: img.width,
        height: img.height,
        elaScore: Number(ela.toFixed(2)),
        prnuScore: Number(prnu.toFixed(4)),
        noiseConsistency: Number(noiseConsistency.toFixed(4)),
        jpegGridInconsistency: Number(jpegGridInconsistency.toFixed(4)),
        anomalyIndex: red * 3 + amber,
        anomalies,
        verdict,
        visualAi,
        visualAiStatus,
        visualPrecheck,
        evidenceCoverage: {
          ocrReadable: (visualAi?.ocrEstimatedChars ?? 0) >= 50,
          styleConsistencyAvailable: typeof visualAi?.styleConsistency === 'number',
          pixelForensicsAvailable: true,
          visualAiAvailable: Boolean(visualAi)
        },
        confidence: {
          score: Math.max(
            0,
            Math.min(
              100,
              Math.round(
                100 -
                  (anomalies.filter((a) => a.severity === 'red').length * 18 + anomalies.filter((a) => a.severity === 'amber').length * 9) -
                  ((visualAi?.ocrEstimatedChars ?? 0) < 50 ? 16 : 0)
              )
            )
          ),
          reasons: [
            ...(visualAi?.ocrEstimatedChars ?? 0) < 50 ? ['OCR visual limitado para esta evidencia.'] : [],
            ...(jpegGridInconsistency > 0.5 ? ['Patron de compresion con inestabilidad por zonas.'] : []),
            ...(noiseConsistency < 0.42 ? ['Ruido de imagen heterogeneo entre regiones.'] : [])
          ]
        },
        policy: { zeroGuessing: true, forcedNoConclusive, reason: forcedReason }
      };
      if (imageResult.policy?.forcedNoConclusive && imageResult.policy.reason) {
        scanLogs = [...scanLogs, `ALERTA: ${imageResult.policy.reason}`].slice(-MAX_LOG_LINES);
      }
      if (imageResult.confidence) {
        scanLogs = [...scanLogs, `CAPA 4: cobertura visual ${imageResult.confidence.score}/100`].slice(-MAX_LOG_LINES);
      }
      appendCustodyRecord({
        mode: 'image',
        fileName: imageResult.fileName,
        hash: imageHash,
        verdict: imageResult.verdict,
        anomalyIndex: imageResult.anomalyIndex
      });
      generatedAt = new Date().toISOString();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Error analizando imagen.';
    } finally {
      busy = false;
      finishTelemetry();
    }
  }

  async function loadImage(url: string) {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('No se pudo leer la imagen.'));
      img.src = url;
    });
  }

  async function runBasicPdfOcrProbe(file: File, pushLog: (line: string) => void) {
    try {
      pushLog('[AUDIT] OCR basico: render de portada PDF.');
      const [{ getDocument }, tesseract] = await Promise.all([
        import('pdfjs-dist'),
        import('tesseract.js')
      ]);
      const data = new Uint8Array(await file.arrayBuffer());
      const loadingTask = getDocument({ data, useWorkerFetch: false, isEvalSupported: false, disableFontFace: true });
      const pdf = await loadingTask.promise;
      const page = await pdf.getPage(1);
      const viewport = page.getViewport({ scale: 1.35 });
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({ canvasContext: ctx as any, viewport, canvas } as any).promise;
      pushLog('[CHECK] OCR basico: reconocimiento primer bloque.');
      const result = await tesseract.recognize(canvas, 'spa');
      const text = String(result?.data?.text ?? '').replace(/\s+/g, ' ').trim();
      const sample = text.slice(0, 220);
      return { sample, chars: text.length, source: 'tesseract-first-page' as const };
    } catch {
      return null;
    }
  }

  function runEla(img: HTMLImageElement, quality: number) {
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas no disponible.');
    ctx.drawImage(img, 0, 0);
    const original = ctx.getImageData(0, 0, img.width, img.height);
    const recompressedDataUrl = canvas.toDataURL('image/jpeg', quality);
    const rec = new Image();
    rec.src = recompressedDataUrl;

    const c2 = document.createElement('canvas');
    c2.width = img.width;
    c2.height = img.height;
    const x2 = c2.getContext('2d');
    if (!x2) throw new Error('Canvas no disponible.');
    x2.drawImage(rec, 0, 0);
    const recompressed = x2.getImageData(0, 0, img.width, img.height);

    let sum = 0;
    for (let i = 0; i < original.data.length; i += 4) {
      sum +=
        Math.abs(original.data[i] - recompressed.data[i]) +
        Math.abs(original.data[i + 1] - recompressed.data[i + 1]) +
        Math.abs(original.data[i + 2] - recompressed.data[i + 2]);
    }
    const avg = sum / (img.width * img.height * 3);
    return avg;
  }

  function estimatePrnu(img: HTMLImageElement) {
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas no disponible.');
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, img.width, img.height).data;

    let highFreqEnergy = 0;
    let sampleCount = 0;
    const w = img.width;

    for (let y = 1; y < img.height - 1; y += 2) {
      for (let x = 1; x < img.width - 1; x += 2) {
        const i = (y * w + x) * 4;
        const n = ((y - 1) * w + x) * 4;
        const s = ((y + 1) * w + x) * 4;
        const e = (y * w + x + 1) * 4;
        const west = (y * w + x - 1) * 4;
        const gray = (data[i] + data[i + 1] + data[i + 2]) / 3;
        const laplace =
          4 * gray -
          (data[n] + data[n + 1] + data[n + 2]) / 3 -
          (data[s] + data[s + 1] + data[s + 2]) / 3 -
          (data[e] + data[e + 1] + data[e + 2]) / 3 -
          (data[west] + data[west + 1] + data[west + 2]) / 3;
        highFreqEnergy += Math.abs(laplace);
        sampleCount += 1;
      }
    }

    const normalized = sampleCount ? highFreqEnergy / sampleCount / 255 : 0;
    return Math.max(0, Math.min(1, normalized / 0.9));
  }

  function estimateNoiseConsistency(img: HTMLImageElement) {
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas no disponible.');
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, img.width, img.height).data;
    const blocks = 4;
    const bw = Math.max(8, Math.floor(img.width / blocks));
    const bh = Math.max(8, Math.floor(img.height / blocks));
    const energies: number[] = [];
    for (let by = 0; by < blocks; by += 1) {
      for (let bx = 0; bx < blocks; bx += 1) {
        let sum = 0;
        let n = 0;
        for (let y = by * bh + 1; y < Math.min((by + 1) * bh - 1, img.height - 1); y += 2) {
          for (let x = bx * bw + 1; x < Math.min((bx + 1) * bw - 1, img.width - 1); x += 2) {
            const i = (y * img.width + x) * 4;
            const e = (y * img.width + x + 1) * 4;
            const s = ((y + 1) * img.width + x) * 4;
            const g = (data[i] + data[i + 1] + data[i + 2]) / 3;
            const ge = (data[e] + data[e + 1] + data[e + 2]) / 3;
            const gs = (data[s] + data[s + 1] + data[s + 2]) / 3;
            sum += Math.abs(g - ge) + Math.abs(g - gs);
            n += 1;
          }
        }
        energies.push(n ? sum / n : 0);
      }
    }
    if (!energies.length) return 0;
    const mean = energies.reduce((a, b) => a + b, 0) / energies.length;
    const variance = energies.reduce((a, b) => a + (b - mean) ** 2, 0) / energies.length;
    const cv = mean > 0 ? Math.sqrt(variance) / mean : 1;
    return Math.max(0, Math.min(1, 1 - cv));
  }

  function estimateJpegGridInconsistency(img: HTMLImageElement) {
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas no disponible.');
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, img.width, img.height).data;
    let edge8 = 0;
    let edgeOther = 0;
    let n8 = 0;
    let nOther = 0;
    for (let y = 1; y < img.height - 1; y += 2) {
      for (let x = 1; x < img.width - 2; x += 2) {
        const i = (y * img.width + x) * 4;
        const j = (y * img.width + x + 1) * 4;
        const g1 = (data[i] + data[i + 1] + data[i + 2]) / 3;
        const g2 = (data[j] + data[j + 1] + data[j + 2]) / 3;
        const d = Math.abs(g1 - g2);
        if (x % 8 === 0) {
          edge8 += d;
          n8 += 1;
        } else {
          edgeOther += d;
          nOther += 1;
        }
      }
    }
    const m8 = n8 ? edge8 / n8 : 0;
    const mO = nOther ? edgeOther / nOther : 0.0001;
    return Math.max(0, Math.min(1, Math.abs(m8 - mO) / (mO + 0.0001)));
  }

  function resetAll() {
    resetTelemetry();
    if (imagePreview) URL.revokeObjectURL(imagePreview);
    if (docPreviewPdfUrl) URL.revokeObjectURL(docPreviewPdfUrl);
    imagePreview = '';
    docPreviewPdfUrl = '';
    documentFile = null;
    imageFile = null;
    documentResult = null;
    imageResult = null;
    documentHash = '';
    imageHash = '';
    error = '';
    generatedAt = '';
    docPreviewKind = null;
    docPreviewHtml = '';
    docPreviewLoading = false;
    docPreviewError = '';
    pendingDocPreviewFile = null;
  }

  function downloadCertificate() {
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    const now = new Date(generatedAt || Date.now()).toLocaleString('es-ES');
    const left = 36;
    const right = 560;
    const bottom = 790;
    const BLACK: [number, number, number] = [20, 20, 20];
    const GRAY: [number, number, number] = [60, 60, 60];
    let y = 46;

    const ensure = (need = 14) => {
      if (y + need <= bottom) return;
      doc.addPage();
      y = 52;
    };

    const line = (text: string, color: [number, number, number] = BLACK, delta = 14, bold = false) => {
      ensure(delta + 2);
      doc.setFont('courier', bold ? 'bold' : 'normal');
      doc.setFontSize(10);
      doc.setTextColor(color[0], color[1], color[2]);
      // Mantiene acentos/ñ; limpia solo controles y algunos símbolos problemáticos para la fuente base.
      const safeText = text
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
        .replace(/[⚠️]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      const wrapped = doc.splitTextToSize(safeText, right - left);
      doc.text(wrapped, left, y);
      y += delta * Math.max(1, wrapped.length);
    };

    const separator = () => {
      line('--------------------------------------------------------------------------', BLACK);
    };

    const bar = (value: number, size = 20) => {
      const clamped = Math.max(0, Math.min(100, value));
      const filled = Math.round((clamped / 100) * size);
      return `[${'#'.repeat(filled)}${'-'.repeat(size - filled)}] ${clamped.toFixed(0)}%`;
    };

    // Cabecera terminal legible
    doc.setFillColor(245, 245, 245);
    doc.rect(28, 28, 540, 64, 'F');
    line('##  _JAMALAJAM_TERMINAL_FORENSE_v1', BLACK, 12, true);
    line('##  INFORME PERICIAL DE INTEGRIDAD ACADEMICA', BLACK, 14, true);
    line('> INFORME PERICIAL / TERMINAL FORENSE', BLACK);
    separator();

    line(`[+] Fecha de emision: ${now}`);
    line('[+] Naturaleza: Informe pericial tecnico');
    separator();
    line('# EVIDENCIA FISICA (NUCLEO DEL INFORME)', BLACK, 14, true);
    if (mode === 'document' && documentResult) {
      line(`[+] Archivo: ${documentResult.fileName}`);
      line(`[+] SHA-256 (huella unica): ${documentHash}`, BLACK, 14, true);
      line(
        `[+] Timeline verificable: Creacion ${documentResult.timeline.created ?? 'N/D'} | Modificacion ${documentResult.timeline.modified ?? 'N/D'}`,
        BLACK,
        14,
        true
      );
      line(`[+] Veredicto final: ${verdictLabel[documentResult.verdict]}`, BLACK, 14, true);
      if (documentResult.evidenceCoverage?.officialPdfSource) {
        line('[+] Fuente oficial detectada: SI (emisor gubernamental/organismo publico reconocido).', BLACK, 14, true);
      } else if (documentResult.extension === 'pdf') {
        line('[+] Fuente oficial detectada: NO/NO CONCLUYENTE en metadatos de emisor.');
      }
    } else if (mode === 'image' && imageResult) {
      line(`[+] Archivo: ${imageResult.fileName}`);
      line(`[+] SHA-256 (huella unica): ${imageHash}`, BLACK, 14, true);
      line(`[+] Timeline verificable: N/D (evidencia visual)`, BLACK, 14, true);
      line(`[+] Veredicto final: ${verdictLabel[imageResult.verdict]}`, BLACK, 14, true);
      line(`[+] Resolucion: ${imageResult.width}x${imageResult.height}`);
    }
    separator();

    line('# INDICADORES CUANTIFICABLES (ZERO GUESSING POLICY)');
    if (mode === 'document' && documentResult) {
      const anomalyPct = Math.max(0, Math.min(100, (documentResult.anomalyIndex / 10) * 100));
      const ratioRaw = documentResult.metrics.ratioWordsPerMinute ?? 0;
      const ratioPct = Math.max(0, Math.min(100, (ratioRaw / 120) * 100));
      line(`> Indice de Anomalias: ${bar(anomalyPct)}`, BLACK, 14, true);
      line(`> Ratio palabras/min: ${bar(ratioPct)}`, BLACK, 14, true);
      line(`> Ratio bruto: ${ratioRaw ? ratioRaw.toFixed(2) : 'N/D'}`);
      line(`> Entropia textual: ${documentResult.metrics.textEntropy}`);
      line(`> Uniformidad sintactica: ${documentResult.metrics.syntaxUniformityCoefficient ?? 'N/D'}`);
      line(`> Diversidad lexical: ${documentResult.metrics.lexicalDiversity ?? 'N/D'}`);
      line(`> Consistencia de estilo (capa 2): ${documentResult.metrics.styleConsistencyIndex ?? 'N/D'}`);
      line(`> Confianza del informe: ${documentResult.confidence ? `${documentResult.confidence.score}/100` : 'N/D'}`);
    } else if (mode === 'image' && imageResult) {
      const anomalyPct = Math.max(0, Math.min(100, (imageResult.anomalyIndex / 10) * 100));
      const visualPct = Math.max(0, Math.min(100, imageResult.visualAi?.suspicionPercent ?? 0));
      line(`> Indice de Anomalias: ${bar(anomalyPct)}`, BLACK, 14, true);
      line(`> Sospecha visual IA: ${bar(visualPct)}`, BLACK, 14, true);
      line(`> Huella de camara: ${imageResult.prnuScore}`);
      line(`> Riesgo de retoque local: ${imageResult.elaScore}`);
      line(`> Consistencia de ruido (capa 3): ${imageResult.noiseConsistency ?? 'N/D'}`);
      line(`> Inconsistencia bloques JPEG (capa 3): ${imageResult.jpegGridInconsistency ?? 'N/D'}`);
      line(`> OCR estimado (capa 2): ${imageResult.visualAi?.ocrEstimatedChars ?? 'N/D'} caracteres`);
      line(`> Consistencia estilo visual (capa 2): ${imageResult.visualAi?.styleConsistency ?? 'N/D'}`);
      line(`> Origen estimado: ${imageResult.visualAi?.origin ?? 'N/D'}`);
    }
    separator();

    line('# HALLAZGOS');
    if (mode === 'document' && documentResult) {
      line(`> Palabras: ${documentResult.metrics.wordCount}`);
      line(`> Tiempo de edicion (min): ${documentResult.metrics.editingMinutes ?? 'N/D'}`);
      line(`> Ratio palabras/min: ${documentResult.metrics.ratioWordsPerMinute?.toFixed(2) ?? 'N/D'}`);
      if (documentResult.anomalies.some((a) => a.code === 'TIMELINE_SPEED_MISMATCH')) {
        line('> [ALERTA ROJA] CORRELACION OBLIGATORIA: velocidad de generacion textual incompatible con veredicto positivo.', BLACK, 14, true);
      }
      if (documentResult.anomalies.some((a) => a.code === 'DOCX_AUTHOR_MISMATCH' || a.code === 'DOCX_TIMELINE_MISMATCH')) {
        line('> [ALERTA] DOCX FORENSICS: inconsistencia detectada en metadatos internos (autor/fechas).', BLACK, 14, true);
      }
      if (!documentResult.anomalies.length) line('[+] Sin anomalias relevantes');
      for (const a of documentResult.anomalies) {
        const prefix = a.severity === 'red' ? '[ALERTA ROJA] ' : '';
        line(`- ${prefix}[${a.severity}] ${a.message}`, BLACK, 14, a.severity === 'red');
      }
      separator();
      line('# INFORME EXTENDIDO (DETALLE TECNICO)');
      line(`> Total de palabras detectadas: ${documentResult.metrics.wordCount}`);
      line(`> Paginas analizadas: ${documentResult.metrics.pageCount ?? 'N/D'}`);
      line(`> Coeficiente sintactico: ${documentResult.metrics.syntaxUniformityCoefficient ?? 'N/D'}`);
      line(
        `> Fuente oficial detectada: ${
          documentResult.evidenceCoverage?.officialPdfSource ? 'SI (metadatos compatibles con organismo oficial)' : 'NO/NO CONCLUYENTE'
        }`
      );
      if (documentResult.linguisticAi) {
        line(`> Sospecha IA linguistica: ${documentResult.linguisticAi.suspicionPercent.toFixed(0)}%`);
        for (const r of documentResult.linguisticAi.reasons) line(`> Motivo tecnico: ${r}`);
      } else {
        line(`> Estado IA linguistica: ${documentResult.linguisticAiStatus?.reason ?? 'No disponible'}`);
      }
      if (documentResult.ocrStatus) line(`> Estado OCR: ${documentResult.ocrStatus.reason}`);
      if (documentResult.policy?.forcedNoConclusive && documentResult.policy.reason) {
        line(`> Salvaguarda anti-falso positivo: ${documentResult.policy.reason}`);
      }
    } else if (mode === 'image' && imageResult) {
      line(`> Indice de anomalias: ${imageResult.anomalyIndex}`);
      line(`> Sospecha visual IA: ${imageResult.visualAi ? `${imageResult.visualAi.suspicionPercent.toFixed(0)}%` : 'N/D'}`);
      if (!imageResult.anomalies.length) line('[+] Sin anomalias relevantes');
      for (const a of imageResult.anomalies) {
        const prefix = a.severity === 'red' ? '[ALERTA ROJA] ' : '';
        line(`- ${prefix}[${a.severity}] ${a.message}`, BLACK, 14, a.severity === 'red');
      }
      separator();
      line('# INFORME EXTENDIDO (DETALLE VISUAL)');
      line(`> Resolucion analizada: ${imageResult.width}x${imageResult.height}`);
      line(`> Huella de camara (PRNU): ${imageResult.prnuScore}`);
      line(`> Riesgo de retoque local (ELA): ${imageResult.elaScore}`);
      line(`> Consistencia de ruido por zonas: ${imageResult.noiseConsistency ?? 'N/D'}`);
      line(`> Inconsistencia bloques JPEG: ${imageResult.jpegGridInconsistency ?? 'N/D'}`);
      line(`> OCR estimado: ${imageResult.visualAi?.ocrEstimatedChars ?? 'N/D'} caracteres`);
      if (imageResult.visualAi?.ocrTextSample) line(`> Muestra OCR: ${imageResult.visualAi.ocrTextSample}`);
      line(`> Origen estimado: ${imageResult.visualAi?.origin ?? 'N/D'}`);
      if (imageResult.visualAi?.reasons?.length) {
        line('# DETECTIVE VISUAL (GROQ)', BLACK, 14, true);
        for (const r of imageResult.visualAi.reasons) line(`> ${r}`);
      }
    }
    separator();

    line('# GLOSARIO TECNICO');
    line('> SHA-256: huella criptografica unica del archivo.');
    line('> Timeline: marcas temporales de creacion y modificacion.');
    line('> Ratio palabras/min: densidad de escritura frente a tiempo reportado.');
    line('> Indice de anomalias: pondera alertas rojas y ambar.');
    line('> Zero Guessing Policy: decisiones con metrica cuantificable (entropia, ratio, timeline, hash), no por intuicion de estilo.');

    doc.save(`ScanIt-Certificado-${Date.now()}.pdf`);
  }
</script>

<svelte:head>
  <title>{$seo.title}</title>
  <meta name="description" content={$seo.description} />
</svelte:head>

<main class="dashboard" class:panic-mode={panicCriticalActive()} dir={$locale === 'ar' ? 'rtl' : 'ltr'}>
  <section class="hero glass">
    <div class="hero-left">
      <p class="eyebrow">{$t('scanit.header.title')}</p>
      <h1>ScanIt</h1>
      <p class="subtitle">{$t('scanit.header.subtitle')}</p>
      <div class="hero-badges">
        <span>{$t('scanit.badges.fileIdentity')}</span>
        <span>{$t('scanit.badges.workTime')}</span>
        <span>{$t('scanit.badges.realData')}</span>
      </div>
    </div>
    <div class="hero-right">
      <div class="hero-actions">
        <LanguageSelect />
        <button class="ghost ghost-info" onclick={() => (showScienceModal = true)}>
          {l({ es: 'Como funciona', en: 'How it works', fr: 'Comment ca marche', de: 'So funktioniert es', pt: 'Como funciona', ru: 'Как это работает', zh: '工作原理', ar: 'كيف يعمل', hi: 'यह कैसे काम करता है' })}
        </button>
        <button class="ghost" onclick={resetAll}>
          {l({ es: 'Limpiar sesion', en: 'Clear session', fr: 'Nettoyer la session', de: 'Sitzung leeren', pt: 'Limpar sessao', ru: 'Очистить сессию', zh: '清除会话', ar: 'مسح الجلسة', hi: 'सत्र साफ करें' })}
        </button>
      </div>
    </div>
  </section>

  <section class="workspace">
    <aside class="mode-rail glass">
      <p class="rail-title">Modulos</p>
      <button class:active={mode === 'document'} onclick={() => (mode = 'document')}>
        <span class="module-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none">
            <path d="M7 3.5h7l4 4V20a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z" />
            <path d="M14 3.5v4h4" />
            <path d="M9 12h6M9 16h6" />
          </svg>
        </span>
        <span>
          <strong>{$t('scanit.modules.verifyDocument')}</strong>
          <small>Word/PDF</small>
        </span>
      </button>
      <button class:active={mode === 'image'} onclick={() => (mode = 'image')}>
        <span class="module-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none">
            <rect x="3.5" y="5.5" width="17" height="13" rx="2.5" />
            <path d="M8 15l2.2-2.2a1 1 0 0 1 1.4 0l1.2 1.2 2.4-2.4a1 1 0 0 1 1.4 0L19 14" />
            <circle cx="9" cy="9.5" r="1.4" />
          </svg>
        </span>
        <span>
          <strong>{$t('scanit.modules.reviewCapture')}</strong>
          <small>Imagen o captura</small>
        </span>
      </button>
    </aside>

    <section class="panel glass">
      {#if mode === 'document'}
        <h2>{$t('scanit.main.title')}</h2>
        <p class="panel-sub">
          {$t('scanit.main.description')}
        </p>
        <section class="scan-grid">
          <div
            class="viewer glass"
            class:active-zone={mode === 'document'}
            class:drag={dragActive}
            ondragover={onDragOver}
            ondragleave={onDragLeave}
            ondrop={onDrop}
            role="button"
            tabindex="0"
            aria-label="Zona de carga de documento"
            onclick={() => documentInputRef?.click()}
            onkeydown={(e) => e.key === 'Enter' && documentInputRef?.click()}
          >
            <div class="viewer-head">
              <div class="viewer-title">
                <span class="dot"></span>
                <span>Visor Forense</span>
              </div>
              <div class="viewer-meta">{documentFile ? documentFile.name : $t('scanit.dropzone.document')}</div>
            </div>

            <input
              bind:this={documentInputRef}
              class="file-input-hidden"
              type="file"
              accept=".docx,.pdf"
              onchange={onSelectDocument}
            />

            <div class="viewer-body">
              <div class="doc-frame">
                {#if documentFile && docPreviewKind === 'pdf'}
                  <div class="pdf-frame">
                    {#if docPreviewPdfUrl}
                      <div class="pdf-viewport">
                        <iframe
                          class="pdf-canvas"
                          src={`${docPreviewPdfUrl}#view=FitH&zoom=page-fit&toolbar=0&navpanes=0&statusbar=0`}
                          title="Vista previa PDF"
                          loading="lazy"
                        ></iframe>
                      </div>
                    {:else}
                      <div class="pdf-fallback">No se pudo cargar la vista previa PDF.</div>
                    {/if}
                    <div class="pdf-neon"></div>
                  </div>
                {:else if documentFile && docPreviewKind === 'docx'}
                  <div class="docx-preview">
                    {#if docPreviewHtml}
                      <iframe class="docx-iframe" srcdoc={docPreviewHtml} title="Vista previa DOCX"></iframe>
                    {:else}
                      <div class="pdf-fallback">{docPreviewLoading ? 'Renderizando vista previa...' : 'No se pudo cargar la vista previa DOCX.'}</div>
                    {/if}
                  </div>
                {:else}
                  <div class="doc-icon">
                    <svg viewBox="0 0 24 24" fill="none">
                      <path d="M7 3.5h7l4 4V20a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z" />
                      <path d="M14 3.5v4h4" />
                      <path d="M9 12h6M9 16h6" />
                    </svg>
                  </div>
                {/if}
                <div class="doc-glow"></div>

                {#if documentFile && (docPreviewLoading || docPreviewError)}
                  <div class="preview-status" aria-live="polite">
                    {#if docPreviewLoading}Renderizando vista previa…{/if}
                    {#if docPreviewError}{docPreviewError}{/if}
                  </div>
                {/if}
              </div>

              {#if busy || visualScanning}
                <div class="scan-overlay" aria-hidden="true">
                  <div class="scan-line"></div>
                  <div class="particles"></div>
                </div>
              {/if}
            </div>
          </div>

          <aside class="telemetry glass" aria-label="Telemetria en vivo">
            <div class="telemetry-head">
              <span class="telemetry-title">Telemetria</span>
              <span class="telemetry-state">{busy || visualScanning ? 'EN PROCESO' : 'LISTO'}</span>
            </div>
            <div class="telemetry-action">
              {#if documentFile}
                <button class="cta cta-side" disabled={busy || visualScanning} onclick={auditDocument}>
                  {busy ? 'Auditando...' : 'Iniciar Auditoria Forense'}
                </button>
              {:else}
                <p class="telemetry-hint">Sube un archivo para iniciar la auditoria.</p>
              {/if}
              {#if documentResult && showResult && !busy && !visualScanning}
                <button class="ghost reopen-result" onclick={reopenResultModal}>Ver resultado</button>
                <button class={`download ${downloadToneClass()}`} onclick={downloadCertificate}>
                  Descargar Informe Completo
                </button>
              {/if}
            </div>
            <div class="telemetry-body">
              {#if scanLogs.length === 0}
                <p class="telemetry-empty">La consola aparecera aqui durante el escaneo.</p>
              {:else}
                {#each scanLogs as line, i (i)}
                  <p
                    class={`telemetry-line ${line.startsWith('ERROR:') ? 'telemetry-line-error' : ''} ${telemetryPrefixClass(line)} ${isAnomalyTelemetryLine(line) ? 'telemetry-line-alert-once' : ''}`}
                    in:fade={{ duration: 160 }}
                  >
                    {telemetryRenderLine(line)}
                  </p>
                {/each}
              {/if}
              <p class="telemetry-cursor" aria-hidden="true">_</p>
            </div>
            {#if error}
              <p class="error">{error}</p>
            {/if}
          </aside>
        </section>
      {:else}
        <h2>{l({ es: 'Modulo de Imagen', en: 'Image Module', fr: 'Module Image', de: 'Bildmodul', pt: 'Modulo de Imagem', ru: 'Модуль изображений', zh: '图像模块', ar: 'وحدة الصور', hi: 'इमेज मॉड्यूल' })}</h2>
        <p class="panel-sub">
          {l({
            es: 'Verifica si la evidencia viene de una foto real de camara y detecta posibles retoques o pegados.',
            en: 'Checks whether evidence comes from a real camera photo and detects possible edits or pasted areas.',
            fr: 'Verifie si la preuve provient d une vraie photo de camera et detecte les retouches ou collages possibles.',
            de: 'Prueft, ob der Nachweis von einem echten Kamerafoto stammt, und erkennt moegliche Bearbeitungen oder Einfuegungen.',
            pt: 'Verifica se a evidencia vem de uma foto real de camera e detecta possiveis retoques ou colagens.',
            ru: 'Проверяет, получено ли доказательство с реальной камеры, и выявляет возможные правки или вставки.',
            zh: '检查证据是否来自真实相机照片，并检测可能的编辑或拼接区域。',
            ar: 'يتحقق مما إذا كانت الأدلة من صورة كاميرا حقيقية ويكشف التعديلات أو اللصق المحتمل.',
            hi: 'जांच करता है कि साक्ष्य वास्तविक कैमरा फोटो से आया है या नहीं और संभावित एडिट या पेस्ट क्षेत्रों का पता लगाता है।'
          })}
        </p>
        <section class="scan-grid">
          <div
            class="viewer glass"
            class:active-zone={mode === 'image'}
            class:drag={dragActive}
            ondragover={onDragOver}
            ondragleave={onDragLeave}
            ondrop={onDrop}
            role="button"
            tabindex="0"
            aria-label="Zona de carga de imagen"
            onclick={() => imageInputRef?.click()}
            onkeydown={(e) => e.key === 'Enter' && imageInputRef?.click()}
          >
            <div class="viewer-head">
              <div class="viewer-title">
                <span class="dot"></span>
                <span>Visor de Evidencia</span>
              </div>
              <div class="viewer-meta">{imageFile ? imageFile.name : l({ es: 'Arrastra una imagen', en: 'Drop an image', fr: 'Deposez une image', de: 'Bild hier ablegen', pt: 'Arraste uma imagem', ru: 'Перетащите изображение', zh: '拖放一张图片', ar: 'اسحب صورة', hi: 'एक छवि ड्रैग करें' })}</div>
            </div>

            <input
              bind:this={imageInputRef}
              class="file-input-hidden"
              type="file"
              accept="image/*"
              onchange={onSelectImage}
            />

            <div class="viewer-body">
              {#if imagePreview}
                <div class="img-frame">
                  <img class="img-preview" src={imagePreview} alt="Previsualizacion de evidencia" />
                </div>
              {:else}
                <div class="img-placeholder" aria-hidden="true">
                  <div class="doc-icon">
                    <svg viewBox="0 0 24 24" fill="none">
                      <rect x="3.5" y="5.5" width="17" height="13" rx="2.5" />
                      <path d="M8 15l2.2-2.2a1 1 0 0 1 1.4 0l1.2 1.2 2.4-2.4a1 1 0 0 1 1.4 0L19 14" />
                      <circle cx="9" cy="9.5" r="1.4" />
                    </svg>
                  </div>
                </div>
              {/if}

              {#if busy || visualScanning}
                <div class="scan-overlay" aria-hidden="true">
                  <div class="scan-line"></div>
                  <div class="particles"></div>
                </div>
              {/if}
            </div>
          </div>

          <aside class="telemetry glass" aria-label="Telemetria en vivo">
            <div class="telemetry-head">
              <span class="telemetry-title">Telemetria</span>
              <span class="telemetry-state">{busy || visualScanning ? 'EN PROCESO' : 'LISTO'}</span>
            </div>
            <div class="telemetry-action">
              {#if imageFile}
                <button class="cta cta-side" disabled={busy || visualScanning} onclick={auditImage}>
                  {busy
                    ? l({ es: 'Certificando...', en: 'Certifying...', fr: 'Certification...', de: 'Zertifiziere...', pt: 'Certificando...', ru: 'Проверка...', zh: '认证中...', ar: 'جارٍ التحقق...', hi: 'सर्टिफाई किया जा रहा है...' })
                    : l({ es: 'Iniciar Certificacion de Evidencia', en: 'Start Evidence Certification', fr: 'Demarrer la certification', de: 'Zertifizierung starten', pt: 'Iniciar certificacao da evidencia', ru: 'Запустить сертификацию', zh: '开始证据认证', ar: 'بدء اعتماد الأدلة', hi: 'साक्ष्य प्रमाणन शुरू करें' })}
                </button>
              {:else}
                <p class="telemetry-hint">{l({ es: 'Sube una imagen para iniciar la certificacion.', en: 'Upload an image to start certification.', fr: 'Importez une image pour demarrer la certification.', de: 'Laden Sie ein Bild hoch, um die Zertifizierung zu starten.', pt: 'Envie uma imagem para iniciar a certificacao.', ru: 'Загрузите изображение, чтобы начать сертификацию.', zh: '上传图片以开始认证。', ar: 'ارفع صورة لبدء الاعتماد.', hi: 'प्रमाणीकरण शुरू करने के लिए छवि अपलोड करें।' })}</p>
              {/if}
              {#if imageResult && showResult && !busy && !visualScanning}
                <button class="ghost reopen-result" onclick={reopenResultModal}>{l({ es: 'Ver resultado', en: 'View result', fr: 'Voir le resultat', de: 'Ergebnis ansehen', pt: 'Ver resultado', ru: 'Посмотреть результат', zh: '查看结果', ar: 'عرض النتيجة', hi: 'परिणाम देखें' })}</button>
                <button class={`download ${downloadToneClass()}`} onclick={downloadCertificate}>
                  {l({ es: 'Descargar Informe Completo', en: 'Download Full Report', fr: 'Telecharger le rapport complet', de: 'Vollbericht herunterladen', pt: 'Baixar relatorio completo', ru: 'Скачать полный отчет', zh: '下载完整报告', ar: 'تنزيل التقرير الكامل', hi: 'पूर्ण रिपोर्ट डाउनलोड करें' })}
                </button>
              {/if}
            </div>
            <div class="telemetry-body">
              {#if scanLogs.length === 0}
                <p class="telemetry-empty">{l({ es: 'La consola aparecera aqui durante el escaneo.', en: 'Console output appears here during scan.', fr: 'La console apparait ici pendant le scan.', de: 'Die Konsole erscheint waehrend des Scans hier.', pt: 'A consola aparecera aqui durante a verificacao.', ru: 'Вывод консоли появится здесь во время сканирования.', zh: '扫描期间控制台输出会显示在这里。', ar: 'سيظهر مخرجات وحدة التحكم هنا أثناء الفحص.', hi: 'स्कैन के दौरान कंसोल आउटपुट यहां दिखाई देगा।' })}</p>
              {:else}
                {#each scanLogs as line, i (i)}
                  <p
                    class={`telemetry-line ${line.startsWith('ERROR:') ? 'telemetry-line-error' : ''} ${telemetryPrefixClass(line)} ${isAnomalyTelemetryLine(line) ? 'telemetry-line-alert-once' : ''}`}
                    in:fade={{ duration: 160 }}
                  >
                    {telemetryRenderLine(line)}
                  </p>
                {/each}
              {/if}
              <p class="telemetry-cursor" aria-hidden="true">_</p>
            </div>
            {#if error}
              <p class="error">{error}</p>
            {/if}
          </aside>
        </section>
      {/if}
    </section>
  </section>

  <footer class="scanit-footer glass" aria-label="Footer ScanIt">
    <div class="kf-left">
      <a href="https://github.com/moisesvalero" target="_blank" rel="noopener noreferrer" aria-label="GitHub">
        <svg viewBox="0 0 24 24" fill="none">
          <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" />
        </svg>
      </a>
      <a href="https://www.linkedin.com/in/moisesvalero" target="_blank" rel="noopener noreferrer" aria-label="LinkedIn">
        <svg viewBox="0 0 24 24" fill="none">
          <path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-2-2 2 2 0 0 0-2 2v7h-4v-7a6 6 0 0 1 6-6z" />
          <rect x="2" y="9" width="4" height="12" />
          <circle cx="4" cy="4" r="2" />
        </svg>
      </a>
      <a href="https://www.malt.es/profile/moisesvalerosanchez" target="_blank" rel="noopener noreferrer" aria-label="Malt">
        <svg viewBox="0 0 24 24" fill="none">
          <path d="M4 6h16v12H4z" />
          <path d="M8 15V9l4 3 4-3v6" />
        </svg>
      </a>
    </div>
    <div class="kf-center">
      <span class="kf-dot" aria-hidden="true"></span>
      <span class="kf-clock">{footerGeo} — {footerClock}</span>
    </div>
    <div class="kf-right">
      <span class="kf-copy">© 2026 · Desarrollado por</span>
      <a class="kf-author" href="https://moisesvalero.es/" target="_blank" rel="noopener noreferrer">Moisés Valero</a>
    </div>
  </footer>

  {#if showScienceModal}
    <div
      class="science-modal-backdrop"
      role="button"
      tabindex="0"
      aria-label="Cerrar modal de metodologia"
      onclick={() => (showScienceModal = false)}
      onkeydown={(e) => e.key === 'Enter' && (showScienceModal = false)}
    >
      <div
        class="science-modal glass"
        role="dialog"
        aria-modal="true"
        aria-label={l({ es: 'Como funciona ScanIt', en: 'How ScanIt works', fr: 'Comment fonctionne ScanIt', de: 'So funktioniert ScanIt', pt: 'Como funciona o ScanIt', ru: 'Как работает ScanIt', zh: 'ScanIt 工作原理', ar: 'كيف يعمل ScanIt', hi: 'ScanIt कैसे काम करता है' })}
        tabindex="0"
        onclick={(e) => e.stopPropagation()}
        onkeydown={(e) => e.key === 'Escape' && (showScienceModal = false)}
      >
        <div class="science-modal-head">
          <h3>{l({ es: 'Como funciona ScanIt', en: 'How ScanIt works', fr: 'Comment fonctionne ScanIt', de: 'So funktioniert ScanIt', pt: 'Como funciona o ScanIt', ru: 'Как работает ScanIt', zh: 'ScanIt 工作原理', ar: 'كيف يعمل ScanIt', hi: 'ScanIt कैसे काम करता है' })}</h3>
          <button class="ghost science-close" onclick={() => (showScienceModal = false)}>{l({ es: 'Cerrar', en: 'Close', fr: 'Fermer', de: 'Schliessen', pt: 'Fechar', ru: 'Закрыть', zh: '关闭', ar: 'إغلاق', hi: 'बंद करें' })}</button>
        </div>
        <div class="science-modal-body">
          <p>
            ScanIt ejecuta una verificacion multicapa para estimar integridad y originalidad del archivo. El proceso
            combina huella SHA-256, timeline de creacion/modificacion, metadatos internos, estructura del formato y
            consistencia del contenido. En documentos, revisa velocidad de escritura, señales de edicion y coherencia
            entre autoria y tiempos; en imagenes, revisa patrones de compresion, ruido y consistencia visual por zonas.
          </p>
          <p>
            La plataforma prioriza evidencia comprobable frente a suposiciones. Por eso, cada resultado incluye tres
            indicadores operativos: veredicto, confianza del informe y semaforo de cobertura. La confianza no es una
            promesa absoluta: es una medida tecnica de cuanta evidencia util se pudo validar en esa sesion concreta.
            Cuanta mas cobertura y mas consistencia entre señales independientes, mayor fiabilidad del resultado.
          </p>
          <p>
            Tambien incorpora controles de seguridad para reducir falsos positivos: si faltan datos clave o hay
            contradicciones entre señales, ScanIt bloquea veredictos optimistas y aplica
            <strong> No concluyente</strong>. Esta regla evita conclusiones fuertes con evidencia parcial y mantiene un
            enfoque prudente para entornos academicos y profesionales.
          </p>
          <p>
            Sobre tasas de exito: no existe un porcentaje universal valido para todos los tipos de archivo y todos los
            contextos. Por transparencia, ScanIt reporta calidad del analisis en cada caso (cobertura + confianza) en
            lugar de ocultarlo tras una cifra fija global.
          </p>
          <p class="science-disclaimer">
            ScanIt es una herramienta de verificacion tecnica y soporte a la decision. La conclusion final siempre debe
            tomarla una persona responsable del proceso.
          </p>
        </div>
      </div>
    </div>
  {/if}

  {#if showResultModal && showResult}
    <div
      class="science-modal-backdrop"
      role="button"
      tabindex="0"
      aria-label="Cerrar resultado"
      onclick={() => (showResultModal = false)}
      onkeydown={(e) => e.key === 'Enter' && (showResultModal = false)}
    >
      <div
        class="science-modal glass result-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Resultado pericial"
        tabindex="0"
        onclick={(e) => e.stopPropagation()}
        onkeydown={(e) => e.key === 'Escape' && (showResultModal = false)}
      >
        <div class="science-modal-head">
          <h3>Resultado pericial</h3>
          <button class="ghost science-close" onclick={() => (showResultModal = false)}>{l({ es: 'Cerrar', en: 'Close', fr: 'Fermer', de: 'Schliessen', pt: 'Fechar', ru: 'Закрыть', zh: '关闭', ar: 'إغلاق', hi: 'बंद करें' })}</button>
        </div>
        <div class="science-modal-body">
          {#if mode === 'document' && documentResult}
            <p><strong>Veredicto:</strong> {verdictLabel[documentResult.verdict]}</p>
            <p><strong>SHA-256:</strong> <span class:glitching={glitchActive}>{glitchSha || documentHash}</span></p>
            <p><strong>Timeline:</strong> {documentResult.timeline.created ?? 'N/D'} -> {documentResult.timeline.modified ?? 'N/D'}</p>
            <p><strong>Indice de anomalias:</strong> {documentResult.anomalyIndex}</p>
            <p><strong>Confianza del informe:</strong> {documentResult.confidence ? `${documentResult.confidence.score}/100` : 'N/D'}</p>
            <p>
              <strong>Semaforo de cobertura:</strong>
              <span class={`coverage-chip ${coverageTone(documentResult.confidence?.score)}`}>
                {documentResult.confidence ? `${documentResult.confidence.score}/100` : 'N/D'}
              </span>
            </p>
            <p><strong>Palabras / Min:</strong> {documentResult.metrics.ratioWordsPerMinute ? documentResult.metrics.ratioWordsPerMinute.toFixed(2) : 'N/D'}</p>
            <p>
              <strong>Sospecha linguistica IA:</strong>
              <span class:glitching={glitchActive}>{glitchPercent || (documentResult.linguisticAi ? `${documentResult.linguisticAi.suspicionPercent.toFixed(0)}%` : 'N/D')}</span>
            </p>
            <p><strong>Politica:</strong> Zero Guessing Policy (metrica cuantificable, no suposiciones).</p>
            {#if documentResult.policy?.forcedNoConclusive && documentResult.policy.reason}
              <p><strong>Salvaguarda anti-falso positivo:</strong> {documentResult.policy.reason}</p>
            {/if}
            {#if documentResult.ocrStatus}
              <p><strong>OCR:</strong> {documentResult.ocrStatus.reason}</p>
            {/if}
            <p>
              Resumen rapido: se detectaron {documentResult.anomalies.length} hallazgos tecnicos.
              Para ver detalle pericial completo, usa "Descargar Informe Completo".
            </p>
            <ul class="modal-list">
              {#if !documentResult.anomalies.length}
                <li>Sin anomalias de severidad relevante en el resumen.</li>
              {/if}
              {#each documentResult.anomalies.slice(0, 3) as anomaly}
                <li>[{anomaly.severity}] {anomaly.message}</li>
              {/each}
            </ul>
          {:else if mode === 'image' && imageResult}
            <p><strong>Veredicto:</strong> {verdictLabel[imageResult.verdict]}</p>
            <p><strong>SHA-256:</strong> <span class:glitching={glitchActive}>{glitchSha || imageHash}</span></p>
            <p><strong>Timeline:</strong> N/D (evidencia visual)</p>
            <p><strong>Indice de anomalias:</strong> {imageResult.anomalyIndex}</p>
            <p>
              <strong>Semaforo de cobertura:</strong>
              <span class={`coverage-chip ${coverageTone(imageResult.confidence?.score)}`}>
                {imageResult.confidence ? `${imageResult.confidence.score}/100` : 'N/D'}
              </span>
            </p>
            <p><strong>Origen estimado:</strong> {imageResult.visualAi?.origin ?? 'N/D'}</p>
            <p>
              <strong>Sospecha visual IA:</strong>
              <span class:glitching={glitchActive}>{glitchPercent || (imageResult.visualAi ? `${imageResult.visualAi.suspicionPercent.toFixed(0)}%` : 'N/D')}</span>
            </p>
            <p><strong>OCR estimado:</strong> {imageResult.visualAi?.ocrEstimatedChars ?? 0} caracteres</p>
            <p><strong>Consistencia de estilo visual:</strong> {imageResult.visualAi?.styleConsistency ?? 'N/D'}</p>
            {#if imageResult.policy?.forcedNoConclusive && imageResult.policy.reason}
              <p><strong>Salvaguarda anti-falso positivo:</strong> {imageResult.policy.reason}</p>
            {/if}
            <p><strong>Politica:</strong> Zero Guessing Policy (metrica cuantificable, no suposiciones).</p>
            <p>
              Resumen rapido: se detectaron {imageResult.anomalies.length} hallazgos tecnicos.
              Para ver el analisis visual completo, descarga el informe extendido.
            </p>
            <ul class="modal-list">
              {#if !imageResult.anomalies.length}
                <li>Sin anomalias de severidad relevante en el resumen.</li>
              {/if}
              {#each imageResult.anomalies.slice(0, 3) as anomaly}
                <li>[{anomaly.severity}] {anomaly.message}</li>
              {/each}
            </ul>
          {/if}
        </div>
        <button class={`download ${downloadToneClass()}`} onclick={downloadCertificate}>
          {l({ es: 'Descargar Informe Completo', en: 'Download Full Report', fr: 'Telecharger le rapport complet', de: 'Vollbericht herunterladen', pt: 'Baixar relatorio completo', ru: 'Скачать полный отчет', zh: '下载完整报告', ar: 'تنزيل التقرير الكامل', hi: 'पूर्ण रिपोर्ट डाउनलोड करें' })}
        </button>
      </div>
    </div>
  {/if}
  {#if customCursorEnabled && cursorVisible}
    <div
      class={`custom-cursor ${cursorHover ? 'hover' : ''}`}
      style={`left:${cursorX}px; top:${cursorY}px;`}
      aria-hidden="true"
    ></div>
  {/if}
</main>

<style>
  .dashboard {
    box-sizing: border-box;
    min-height: 100vh;
    height: auto;
    max-height: none;
    max-width: 1420px;
    margin: 0 auto;
    padding: 0.55rem 0.7rem 0.7rem;
    position: relative;
    overflow: auto;
  }
  :global(body) {
    background:
      radial-gradient(900px 420px at 22% -10%, rgba(0, 229, 255, 0.16), rgba(0, 229, 255, 0) 60%),
      radial-gradient(780px 420px at 88% 10%, rgba(88, 115, 255, 0.16), rgba(88, 115, 255, 0) 62%),
      linear-gradient(180deg, #06070b 0%, #071122 38%, #050713 100%);
  }
  .glass {
    border: 1px solid rgba(0, 229, 255, 0.22);
    background:
      linear-gradient(155deg, rgba(19, 26, 42, 0.7), rgba(9, 12, 18, 0.62)),
      rgba(8, 11, 18, 0.44);
    backdrop-filter: blur(18px);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.05),
      0 30px 65px rgba(1, 8, 18, 0.56),
      0 0 0 1px rgba(0, 229, 255, 0.06),
      0 0 34px rgba(0, 229, 255, 0.08);
  }
  .dashboard.panic-mode .glass {
    border-color: rgba(255, 72, 72, 0.58);
    animation: panicPulse 1.8s ease-in-out infinite;
  }
  .dashboard.panic-mode::before {
    background: radial-gradient(circle, rgba(255, 60, 60, 0.4), rgba(255, 60, 60, 0));
  }
  .dashboard.panic-mode::after {
    background: radial-gradient(circle, rgba(255, 90, 90, 0.35), rgba(255, 90, 90, 0));
  }
  @keyframes panicPulse {
    0%,
    100% {
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.04),
        0 24px 52px rgba(22, 4, 8, 0.5),
        0 0 0 1px rgba(255, 92, 92, 0.18),
        0 0 20px rgba(255, 72, 72, 0.2);
    }
    50% {
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.05),
        0 28px 58px rgba(24, 2, 8, 0.56),
        0 0 0 1px rgba(255, 92, 92, 0.3),
        0 0 28px rgba(255, 72, 72, 0.34);
    }
  }
  .dashboard::before,
  .dashboard::after {
    content: '';
    position: fixed;
    pointer-events: none;
    z-index: -1;
    filter: blur(80px);
    opacity: 0.35;
  }
  .dashboard::before {
    top: -100px;
    left: -60px;
    width: 360px;
    height: 360px;
    background: radial-gradient(circle, rgba(0, 229, 255, 0.55), rgba(0, 229, 255, 0));
  }
  .dashboard::after {
    bottom: -120px;
    right: -90px;
    width: 420px;
    height: 420px;
    background: radial-gradient(circle, rgba(88, 115, 255, 0.5), rgba(88, 115, 255, 0));
  }
  .hero {
    display: flex;
    gap: 0.7rem;
    justify-content: space-between;
    align-items: center;
    border-radius: 14px;
    padding: 0.55rem 0.75rem;
    margin-bottom: 0.55rem;
    position: relative;
    z-index: 120;
    overflow: visible;
  }
  .hero-left {
    max-width: 1000px;
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .hero-right {
    display: flex;
    align-items: flex-start;
  }
  .hero-actions {
    display: flex;
    align-items: center;
    gap: 0.45rem;
  }
  .ghost-info {
    border-color: rgba(0, 229, 255, 0.42);
    color: rgba(206, 234, 255, 0.96);
  }
  .eyebrow {
    color: var(--muted);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    font-size: 0.64rem;
    font-family: 'JetBrains Mono', monospace;
    margin: 0;
  }
  h1 {
    font-size: clamp(1.15rem, 1.9vw, 1.55rem);
    margin: 0;
    letter-spacing: -0.01em;
    background: linear-gradient(120deg, #f3f8ff 20%, #76dcff 55%, #4f74ff 100%);
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    text-shadow:
      0 0 28px rgba(0, 229, 255, 0.32),
      0 0 64px rgba(88, 115, 255, 0.18);
  }
  .subtitle {
    color: var(--muted);
    margin: 0;
    max-width: 58ch;
    font-size: 0.78rem;
    line-height: 1.2;
  }
  .hero-badges {
    margin-top: 0;
    display: flex;
    gap: 0.38rem;
    flex-wrap: wrap;
  }
  .hero-badges span {
    border-radius: 999px;
    border: 1px solid rgba(130, 152, 199, 0.28);
    background: rgba(20, 28, 40, 0.6);
    padding: 0.2rem 0.45rem;
    font-size: 0.62rem;
    color: #c6d5f3;
    letter-spacing: 0.02em;
  }
  .workspace {
    display: grid;
    grid-template-columns: 220px 1fr;
    gap: 0.95rem;
    height: auto;
    max-height: none;
    position: relative;
    z-index: 10;
  }
  .mode-rail {
    border-radius: 18px;
    padding: 0.9rem;
    display: grid;
    align-content: start;
    gap: 0.46rem;
    height: 100%;
  }
  .rail-title {
    color: #8da3cb;
    text-transform: uppercase;
    letter-spacing: 0.11em;
    font-size: 0.7rem;
    margin: 0.15rem 0 0.35rem;
  }
  .mode-rail button {
    position: relative;
    display: grid;
    grid-template-columns: 18px 1fr;
    align-items: start;
    gap: 0.62rem;
    border: 1px solid var(--line);
    background: linear-gradient(165deg, rgba(22, 27, 38, 0.82), rgba(15, 20, 31, 0.72));
    backdrop-filter: blur(12px);
    color: var(--text);
    border-radius: 12px;
    padding: 0.8rem 0.78rem;
    text-align: left;
    cursor: pointer;
    font-weight: 500;
    transition:
      transform 190ms ease,
      border-color 190ms ease,
      box-shadow 190ms ease,
      background 190ms ease;
    overflow: hidden;
  }
  .mode-rail button::after,
  .cta::after,
  .download::after {
    content: '';
    position: absolute;
    inset: 0;
    transform: translateX(-130%);
    background: linear-gradient(112deg, rgba(0, 229, 255, 0) 36%, rgba(0, 229, 255, 0.34) 50%, rgba(0, 229, 255, 0) 64%);
    opacity: 0.95;
    pointer-events: none;
  }
  .mode-rail button strong {
    font-size: 0.9rem;
    line-height: 1.2;
  }
  .mode-rail button small {
    display: block;
    font-size: 0.73rem;
    color: #8ea3cc;
    margin-top: 0.16rem;
    line-height: 1.3;
  }
  .mode-rail button::before {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(110deg, rgba(0, 229, 255, 0.08), rgba(0, 229, 255, 0.32), rgba(88, 115, 255, 0.22));
    opacity: 0.08;
    transition: opacity 190ms ease;
  }
  .mode-rail button.active {
    border-color: rgba(0, 229, 255, 0.9);
    box-shadow:
      inset 0 0 0 1px rgba(41, 211, 255, 0.35),
      0 0 0 1px rgba(41, 211, 255, 0.2),
      0 0 26px rgba(41, 211, 255, 0.18);
    background: linear-gradient(120deg, rgba(0, 229, 255, 0.26), rgba(89, 116, 255, 0.2));
  }
  .mode-rail button.active::before {
    opacity: 0.9;
  }
  .mode-rail button:hover {
    border-color: rgba(0, 229, 255, 0.85);
    transform: translateY(-1px);
    box-shadow:
      0 14px 34px rgba(2, 10, 22, 0.55),
      0 0 28px rgba(0, 229, 255, 0.16);
  }
  .mode-rail button:hover::before {
    opacity: 0.65;
  }
  .mode-rail button:hover::after,
  .cta:hover::after,
  .download:hover::after {
    opacity: 1;
    animation: buttonScan 1.05s linear;
  }
  .module-icon {
    width: 1rem;
    height: 1rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .module-icon svg {
    width: 100%;
    height: 100%;
    stroke: #9fd9ff;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
    filter: drop-shadow(0 0 8px rgba(41, 211, 255, 0.45));
  }
  .panel {
    border-radius: 16px;
    padding: 0.7rem;
    height: 100%;
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
  }
  .scan-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 360px;
    gap: 0.95rem;
    margin: 0.25rem 0 0;
    height: 100%;
    min-height: 0;
    flex: 1;
  }
  .viewer {
    border-radius: 16px;
    padding: 0.9rem;
    position: relative;
    overflow: hidden;
    cursor: pointer;
    transition: transform 180ms ease, box-shadow 180ms ease, border-color 180ms ease;
    min-height: 0;
    height: 100%;
  }
  .viewer.drag {
    border-color: rgba(0, 229, 255, 0.75);
    box-shadow: 0 0 0 1px rgba(0, 229, 255, 0.18), 0 0 38px rgba(0, 229, 255, 0.18);
    transform: translateY(-1px);
  }
  .viewer-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.75rem;
    padding-bottom: 0.65rem;
    border-bottom: 1px solid rgba(130, 152, 199, 0.18);
  }
  .viewer-title {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    font-family: 'JetBrains Mono', monospace;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    font-size: 0.72rem;
    color: rgba(232, 241, 255, 0.82);
  }
  .viewer-meta {
    font-size: 0.82rem;
    color: rgba(220, 235, 255, 0.72);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 58%;
  }
  .dot {
    width: 9px;
    height: 9px;
    border-radius: 999px;
    background: rgba(0, 229, 255, 0.92);
    box-shadow: 0 0 18px rgba(0, 229, 255, 0.55);
  }
  .viewer-body {
    position: relative;
    height: calc(100% - 44px);
    display: grid;
    place-items: start center;
    align-content: start;
    padding-top: 0.12rem;
  }
  .file-input-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    opacity: 0;
    pointer-events: none;
  }
  .doc-frame,
  .img-placeholder {
    width: min(740px, 96%);
    height: min(520px, 50vh);
    border-radius: 18px;
    border: 1px solid rgba(0, 229, 255, 0.42);
    background: linear-gradient(155deg, rgba(6, 10, 18, 0.72), rgba(3, 6, 12, 0.62));
    box-shadow:
      inset 0 0 0 1px rgba(255, 255, 255, 0.06),
      0 0 40px rgba(0, 229, 255, 0.14);
    display: grid;
    place-items: center;
    position: relative;
    overflow: hidden;
  }
  .pdf-frame {
    width: 100%;
    height: 100%;
    position: relative;
    display: grid;
    place-items: center;
    padding: 10px;
  }
  .pdf-viewport {
    width: 100%;
    height: 100%;
    border-radius: 14px;
    overflow: hidden;
    display: grid;
    place-items: center;
    background: rgba(0, 0, 0, 0.28);
  }
  .pdf-canvas {
    width: 100%;
    height: 100%;
    border-radius: 14px;
    border: 0;
    filter: contrast(1.02) saturate(1.05);
    opacity: 0.94;
    background: rgba(0, 0, 0, 0.2);
  }
  .pdf-fallback {
    width: 100%;
    height: 100%;
    border-radius: 14px;
    border: 1px dashed rgba(0, 229, 255, 0.36);
    display: grid;
    place-items: center;
    color: rgba(255, 255, 255, 0.92);
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.82rem;
    background: rgba(2, 6, 12, 0.62);
  }
  .pdf-neon {
    position: absolute;
    inset: 8px;
    border-radius: 14px;
    box-shadow:
      0 0 0 1px rgba(0, 229, 255, 0.22),
      0 0 34px rgba(0, 229, 255, 0.16);
    pointer-events: none;
  }
  .docx-preview {
    width: 100%;
    height: 100%;
    display: block;
    padding: 10px;
  }
  .docx-iframe {
    width: 100%;
    height: 100%;
    border: 0;
    border-radius: 14px;
    background: #0a1018;
  }
  .preview-status {
    position: absolute;
    left: 14px;
    right: 14px;
    bottom: 12px;
    border-radius: 12px;
    border: 1px solid rgba(0, 229, 255, 0.28);
    background: rgba(6, 10, 18, 0.62);
    backdrop-filter: blur(10px);
    padding: 0.55rem 0.7rem;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.78rem;
    color: rgba(255, 255, 255, 0.9);
    text-shadow: 0 0 14px rgba(0, 229, 255, 0.18);
  }
  .doc-icon svg {
    width: 88px;
    height: 88px;
    stroke: rgba(170, 225, 255, 0.96);
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
    filter: drop-shadow(0 0 14px rgba(0, 229, 255, 0.35));
  }
  .doc-glow {
    position: absolute;
    inset: -40%;
    background: radial-gradient(circle at 40% 35%, rgba(0, 229, 255, 0.18), rgba(0, 229, 255, 0));
    filter: blur(18px);
    opacity: 0.9;
  }
  .img-frame {
    width: min(520px, 92%);
    border-radius: 18px;
    border: 1px solid rgba(0, 229, 255, 0.55);
    background: rgba(3, 7, 14, 0.45);
    box-shadow:
      inset 0 0 0 1px rgba(255, 255, 255, 0.06),
      0 0 46px rgba(0, 229, 255, 0.16);
    overflow: hidden;
  }
  .img-preview {
    width: 100%;
    height: 100%;
    display: block;
    max-height: 48vh;
    object-fit: contain;
    background: rgba(0, 0, 0, 0.2);
  }
  .scan-overlay {
    position: absolute;
    inset: 58px 14px 14px;
    border-radius: 16px;
    pointer-events: none;
    overflow: hidden;
  }
  .scan-line {
    position: absolute;
    left: 0;
    right: 0;
    height: 2px;
    top: 0;
    background: linear-gradient(90deg, rgba(0, 229, 255, 0), rgba(0, 229, 255, 1), rgba(88, 115, 255, 0));
    box-shadow: 0 0 18px rgba(0, 229, 255, 0.9);
    animation: scanY 1.35s ease-in-out infinite alternate;
    opacity: 0.95;
  }
  @keyframes scanY {
    0% {
      transform: translateY(4px);
    }
    100% {
      transform: translateY(260px);
    }
  }
  .particles {
    position: absolute;
    inset: 0;
    background:
      radial-gradient(circle at 20% 30%, rgba(0, 229, 255, 0.12), rgba(0, 229, 255, 0) 42%),
      radial-gradient(circle at 70% 60%, rgba(88, 115, 255, 0.1), rgba(88, 115, 255, 0) 48%),
      repeating-linear-gradient(0deg, rgba(0, 229, 255, 0.06) 0 1px, rgba(0, 229, 255, 0) 1px 10px);
    opacity: 0.55;
    mix-blend-mode: screen;
    animation: glitchFloat 1.9s ease-in-out infinite alternate;
    filter: blur(0.2px);
  }
  @keyframes glitchFloat {
    0% {
      transform: translate3d(0, 0, 0);
      opacity: 0.45;
    }
    100% {
      transform: translate3d(0.6px, -0.8px, 0);
      opacity: 0.6;
    }
  }
  .telemetry {
    background:
      linear-gradient(165deg, rgba(2, 4, 8, 0.96), rgba(0, 0, 0, 0.96)),
      rgba(0, 0, 0, 0.94);
    border-color: rgba(0, 229, 255, 0.24);
    border-radius: 16px;
    padding: 0.62rem;
    display: flex;
    flex-direction: column;
    min-height: 0;
    height: 100%;
    overflow: hidden;
    gap: 0.4rem;
  }
  .telemetry-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.75rem;
    padding-bottom: 0.65rem;
    border-bottom: 1px solid rgba(130, 152, 199, 0.18);
  }
  .telemetry-title {
    font-family: 'JetBrains Mono', monospace;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    font-size: 0.72rem;
    color: rgba(232, 241, 255, 0.82);
  }
  .telemetry-state {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.72rem;
    color: rgba(0, 229, 255, 0.9);
  }
  .telemetry-body {
    padding-top: 0.45rem;
    flex: 1;
    min-height: 100px;
    overflow: auto;
    scrollbar-width: thin;
    font-family: 'JetBrains Mono', 'Noto Sans Mono', Consolas, 'Courier New', 'Noto Sans Arabic', 'Noto Sans SC', 'Noto Sans', monospace;
  }
  .telemetry-action {
    margin-top: 0.1rem;
    display: grid;
    gap: 0.35rem;
  }
  .telemetry-empty {
    color: rgba(220, 235, 255, 0.66);
    font-size: 0.9rem;
  }
  .telemetry-line {
    font-family: 'JetBrains Mono', 'Noto Sans Mono', Consolas, 'Courier New', 'Noto Sans Arabic', 'Noto Sans SC', 'Noto Sans', monospace;
    font-size: 0.82rem;
    color: rgba(255, 255, 255, 0.92);
    line-height: 1.4;
    margin-top: 0.32rem;
  }
  .telemetry-line-alert-once {
    animation: telemetryAlertOnce 0.75s ease-out 1;
  }
  @keyframes telemetryAlertOnce {
    0% {
      color: #ff8a8a;
      text-shadow: 0 0 18px rgba(255, 60, 60, 0.85);
      opacity: 0.55;
    }
    55% {
      color: #ff3f3f;
      text-shadow: 0 0 22px rgba(255, 40, 40, 0.95);
      opacity: 1;
    }
    100% {
      color: rgba(255, 255, 255, 0.92);
      text-shadow: none;
      opacity: 1;
    }
  }
  .telemetry-line-error {
    color: #ff6b6b;
    text-shadow: 0 0 10px rgba(255, 0, 0, 0.45);
    animation: telemetryErrorBlink 0.82s step-end 1;
  }
  .telemetry-line-audit {
    color: #95d9ff;
    text-shadow: 0 0 10px rgba(64, 198, 255, 0.28);
  }
  .telemetry-line-check {
    color: #bfffe0;
    text-shadow: 0 0 10px rgba(60, 235, 170, 0.26);
  }
  .telemetry-line-fail {
    color: #ff9a9a;
    text-shadow: 0 0 12px rgba(255, 72, 72, 0.34);
  }
  @keyframes telemetryErrorBlink {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.2;
    }
  }
  .panel-sub {
    color: var(--muted);
    margin: 0.2rem 0 0.45rem;
    font-size: 0.82rem;
  }
  .cta-side {
    margin-top: 0;
    padding: 0.55rem 0.7rem;
    width: 100%;
  }
  .telemetry-hint {
    margin: 0.1rem 0 0;
    font-size: 0.76rem;
    color: rgba(186, 206, 238, 0.72);
    font-family: 'JetBrains Mono', monospace;
  }
  .telemetry-cursor {
    margin: 0.3rem 0 0;
    font-family: 'JetBrains Mono', 'Noto Sans Mono', Consolas, 'Courier New', 'Noto Sans Arabic', 'Noto Sans SC', 'Noto Sans', monospace;
    color: rgba(0, 229, 255, 0.9);
    animation: termCursorBlink 0.9s step-end infinite;
  }
  .coverage-chip {
    display: inline-flex;
    align-items: center;
    margin-left: 0.45rem;
    border-radius: 999px;
    padding: 0.08rem 0.52rem;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.74rem;
    border: 1px solid transparent;
  }
  .coverage-green {
    color: #b7ffd6;
    border-color: rgba(30, 203, 131, 0.65);
    background: rgba(9, 61, 39, 0.44);
  }
  .coverage-amber {
    color: #ffe1b2;
    border-color: rgba(255, 170, 68, 0.7);
    background: rgba(88, 52, 8, 0.36);
  }
  .coverage-red {
    color: #ffd0d7;
    border-color: rgba(255, 78, 94, 0.78);
    background: rgba(84, 12, 20, 0.42);
  }
  @keyframes termCursorBlink {
    0%,
    50% {
      opacity: 1;
    }
    50.01%,
    100% {
      opacity: 0;
    }
  }
  .reopen-result {
    margin-top: 0.2rem;
    width: 100%;
  }
  .side-result {
    margin-top: 0.45rem;
    overflow: auto;
    max-height: 42%;
  }
  input[type='file'] {
    width: 100%;
    border: 1px dashed var(--line);
    border-radius: 10px;
    padding: 0.75rem;
    background: rgba(9, 12, 18, 0.6);
    color: rgba(255, 255, 255, 0.92);
    margin-bottom: 0.75rem;
  }
  input[type='file']::file-selector-button {
    border: 1px solid rgba(0, 229, 255, 0.45);
    border-radius: 10px;
    padding: 0.55rem 0.75rem;
    margin-right: 0.75rem;
    background: linear-gradient(110deg, rgba(0, 229, 255, 0.22), rgba(88, 115, 255, 0.22));
    color: rgba(255, 255, 255, 0.95);
    cursor: pointer;
    box-shadow: 0 0 20px rgba(0, 229, 255, 0.14);
    transition: transform 170ms ease, box-shadow 170ms ease, border-color 170ms ease;
  }
  input[type='file']::file-selector-button:hover {
    transform: translateY(-1px);
    border-color: rgba(0, 229, 255, 0.7);
    box-shadow: 0 0 28px rgba(0, 229, 255, 0.22);
  }
  .cta,
  .download,
  .ghost {
    position: relative;
    overflow: hidden;
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 0.65rem 0.9rem;
    background: linear-gradient(165deg, rgba(23, 29, 43, 0.9), rgba(14, 19, 30, 0.9));
    color: var(--text);
    cursor: pointer;
    transition:
      transform 170ms ease,
      box-shadow 170ms ease,
      border-color 170ms ease;
  }
  .cta {
    border-color: rgba(0, 229, 255, 0.8);
    background: linear-gradient(110deg, rgba(0, 229, 255, 0.55), rgba(84, 111, 255, 0.55));
    font-weight: 700;
    letter-spacing: 0.02em;
    box-shadow:
      inset 0 0 0 1px rgba(255, 255, 255, 0.08),
      0 0 34px rgba(0, 229, 255, 0.28),
      0 18px 40px rgba(2, 10, 22, 0.55);
  }
  .cta:hover:not(:disabled) {
    transform: translateY(-1px);
    box-shadow:
      inset 0 0 0 1px rgba(255, 255, 255, 0.12),
      0 0 44px rgba(0, 229, 255, 0.38),
      0 24px 54px rgba(2, 10, 22, 0.6);
  }
  .cta:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
  .download {
    margin-top: 0.45rem;
    width: 100%;
    font-weight: 700;
  }
  .download.is-clean {
    border-color: rgba(30, 203, 131, 0.75);
    background: linear-gradient(110deg, rgba(30, 203, 131, 0.38), rgba(10, 132, 99, 0.38));
    box-shadow:
      inset 0 0 0 1px rgba(255, 255, 255, 0.08),
      0 0 24px rgba(30, 203, 131, 0.22);
  }
  .download.is-inconclusive {
    border-color: rgba(255, 170, 68, 0.8);
    background: linear-gradient(110deg, rgba(255, 170, 68, 0.42), rgba(204, 122, 16, 0.42));
    box-shadow:
      inset 0 0 0 1px rgba(255, 255, 255, 0.08),
      0 0 24px rgba(255, 170, 68, 0.24);
  }
  .download.is-suspicious {
    border-color: rgba(255, 78, 94, 0.85);
    background: linear-gradient(110deg, rgba(255, 78, 94, 0.44), rgba(168, 26, 50, 0.44));
    box-shadow:
      inset 0 0 0 1px rgba(255, 255, 255, 0.08),
      0 0 24px rgba(255, 78, 94, 0.28);
  }
  .download:hover {
    transform: translateY(-1px);
    filter: brightness(1.06);
  }
  .ghost {
    color: rgba(232, 241, 255, 0.78);
    border-color: rgba(130, 152, 199, 0.22);
    background: rgba(9, 12, 18, 0.18);
  }
  .ghost:hover {
    border-color: rgba(41, 211, 255, 0.4);
    color: #d4e7ff;
  }
  .result {
    margin-top: 1rem;
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 0.85rem;
    background: linear-gradient(150deg, rgba(10, 14, 22, 0.65), rgba(7, 11, 18, 0.75));
    backdrop-filter: blur(12px);
    box-shadow: inset 0 0 0 1px rgba(131, 151, 188, 0.08);
  }
  .result-reveal {
    animation: resultIn 260ms ease both;
  }
  @keyframes resultIn {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
  .result p,
  .result li {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.86rem;
    margin-top: 0.35rem;
    color: #d9e5ff;
    word-break: break-word;
  }
  .result h3 {
    color: #e9f2ff;
    letter-spacing: 0.02em;
    text-shadow: 0 0 16px rgba(41, 211, 255, 0.16);
  }
  .result ul {
    margin-top: 0.4rem;
    padding-left: 1.1rem;
  }
  .active-zone {
    animation: activeZonePulse 6.2s ease-in-out infinite;
  }
  @keyframes activeZonePulse {
    0%,
    100% {
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.05),
        0 30px 65px rgba(1, 8, 18, 0.56),
        0 0 0 1px rgba(0, 229, 255, 0.08),
        0 0 24px rgba(0, 229, 255, 0.1);
    }
    50% {
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.07),
        0 32px 68px rgba(1, 8, 18, 0.6),
        0 0 0 1px rgba(0, 229, 255, 0.22),
        0 0 34px rgba(0, 229, 255, 0.24);
    }
  }
  .glitching {
    font-family: 'JetBrains Mono', monospace;
    text-shadow: 0 0 10px rgba(0, 229, 255, 0.18);
  }
  @keyframes buttonScan {
    from {
      transform: translateX(-130%);
    }
    to {
      transform: translateX(130%);
    }
  }
  .custom-cursor {
    position: fixed;
    width: 22px;
    height: 22px;
    border: 1px solid rgba(0, 229, 255, 0.9);
    border-radius: 50%;
    pointer-events: none;
    transform: translate(-50%, -50%);
    z-index: 9999;
    box-shadow:
      0 0 0 1px rgba(0, 229, 255, 0.25) inset,
      0 0 18px rgba(0, 229, 255, 0.35);
  }
  .custom-cursor::before,
  .custom-cursor::after {
    content: '';
    position: absolute;
    background: rgba(0, 229, 255, 0.85);
  }
  .custom-cursor::before {
    left: 50%;
    top: 3px;
    width: 1px;
    height: 16px;
    transform: translateX(-50%);
  }
  .custom-cursor::after {
    top: 50%;
    left: 3px;
    width: 16px;
    height: 1px;
    transform: translateY(-50%);
  }
  .custom-cursor.hover {
    width: 26px;
    height: 26px;
    border-color: rgba(115, 244, 255, 1);
    border-radius: 6px;
    transform: translate(-50%, -50%) rotate(45deg);
    box-shadow:
      0 0 0 1px rgba(0, 229, 255, 0.4) inset,
      0 0 24px rgba(0, 229, 255, 0.48);
  }
  .custom-cursor.hover::before,
  .custom-cursor.hover::after {
    opacity: 0.95;
  }
  @media (hover: hover) and (pointer: fine) {
    :global(body) {
      cursor: none !important;
    }
    :global(a),
    :global(button),
    :global(input),
    :global(textarea),
    :global(select),
    :global([role='button']),
    :global([onclick]),
    :global(.viewer),
    :global(.mode-rail button),
    :global(.telemetry),
    :global(.science-modal-backdrop),
    :global(.science-modal) {
      cursor: none !important;
    }
  }
  @media (hover: none), (pointer: coarse) {
    .custom-cursor {
      display: none;
    }
  }
  .ai-box {
    margin-top: 0.85rem;
    border-radius: 12px;
    border: 1px solid rgba(0, 229, 255, 0.38);
    background: linear-gradient(120deg, rgba(0, 229, 255, 0.12), rgba(88, 115, 255, 0.09));
    box-shadow: 0 0 26px rgba(0, 229, 255, 0.14);
    padding: 0.8rem 0.85rem;
  }
  .ai-box h4 {
    margin: 0;
    font-family: 'JetBrains Mono', monospace;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    font-size: 0.72rem;
    color: rgba(232, 241, 255, 0.86);
  }
  .ai-score {
    margin-top: 0.45rem;
    font-family: 'JetBrains Mono', monospace;
    color: rgba(255, 255, 255, 0.92);
  }
  .ai-reasons {
    margin-top: 0.45rem;
    padding-left: 1.25rem;
    color: rgba(225, 238, 255, 0.88);
    font-size: 0.9rem;
  }
  .preview {
    margin-top: 0.8rem;
    max-width: 100%;
    max-height: 360px;
    border-radius: 10px;
    border: 1px solid var(--line);
    box-shadow: 0 16px 30px rgba(2, 8, 20, 0.4);
  }
  .error {
    color: var(--danger);
    margin-top: 0.7rem;
  }
  @media (max-width: 760px) {
    .workspace {
      grid-template-columns: 1fr;
      height: auto;
      max-height: none;
    }
    .hero {
      flex-direction: column;
      align-items: flex-start;
    }
    .hero-right {
      width: 100%;
    }
    .ghost {
      width: 100%;
    }
  }
  @media (max-width: 920px) {
    .scan-grid {
      grid-template-columns: 1fr;
      height: auto;
    }
    .panel {
      overflow: visible;
    }
  }
  @media (min-width: 1024px) {
    :global(html),
    :global(body) {
      height: 100%;
      overflow: hidden;
    }
    .dashboard {
      height: 100dvh;
      min-height: 100dvh;
      max-height: 100dvh;
      overflow: hidden;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr) auto;
      gap: 0.5rem;
    }
    .workspace {
      min-height: 0;
      height: 100%;
      max-height: 100%;
      overflow: hidden;
    }
    .panel {
      min-height: 0;
    }
    .scan-grid {
      min-height: 0;
      height: 100%;
    }
    .viewer,
    .telemetry {
      min-height: 0;
      height: 100%;
    }
    .viewer-body {
      place-items: center;
      align-content: center;
      padding-top: 0;
    }
    .doc-frame,
    .img-placeholder {
      width: min(860px, 98%);
      height: min(680px, 66vh);
    }
    .img-frame {
      width: min(820px, 96%);
      height: min(680px, 66vh);
    }
    .img-preview {
      max-height: none;
      height: 100%;
    }
    .telemetry-body,
    .side-result {
      overflow-y: auto;
      scrollbar-width: thin;
      scrollbar-color: rgba(0, 229, 255, 0.78) rgba(8, 14, 26, 0.55);
    }
    .side-result {
      min-height: 0;
      max-height: 40%;
    }
    .telemetry-body::-webkit-scrollbar,
    .side-result::-webkit-scrollbar {
      width: 7px;
      height: 7px;
    }
    .telemetry-body::-webkit-scrollbar-thumb,
    .side-result::-webkit-scrollbar-thumb {
      background: rgba(0, 229, 255, 0.75);
      border-radius: 999px;
    }
    .telemetry-body::-webkit-scrollbar-track,
    .side-result::-webkit-scrollbar-track {
      background: rgba(10, 16, 28, 0.5);
    }
  }
  @media (min-width: 768px) and (max-width: 1024px) {
    .dashboard {
      overflow: auto;
      height: auto;
      max-height: none;
      padding: 0.65rem 0.7rem 0.9rem;
    }
    .workspace {
      grid-template-columns: 180px minmax(0, 1fr);
      height: auto;
      max-height: none;
    }
    .scan-grid {
      grid-template-columns: 1fr;
      height: auto;
    }
    .telemetry {
      min-height: 260px;
      max-height: none;
    }
    .side-result {
      max-height: 300px;
    }
  }
  @media (max-width: 767px) {
    .dashboard {
      overflow: auto;
      height: auto;
      max-height: none;
      padding: 0.55rem 0.55rem 0.9rem;
    }
    .hero {
      padding: 0.5rem 0.55rem;
      gap: 0.5rem;
    }
    .hero-left {
      width: 100%;
      gap: 0.45rem;
      flex-wrap: wrap;
    }
    .subtitle {
      max-width: 100%;
      font-size: 0.74rem;
    }
    .workspace {
      grid-template-columns: 1fr;
      gap: 0.55rem;
      height: auto;
      max-height: none;
    }
    .mode-rail {
      display: grid;
      grid-template-columns: 1fr 1fr;
      align-items: stretch;
      gap: 0.45rem;
      padding: 0.55rem;
      border-radius: 14px;
    }
    .rail-title {
      grid-column: 1 / -1;
      margin: 0 0 0.1rem;
      font-size: 0.62rem;
    }
    .mode-rail button {
      grid-template-columns: 16px 1fr;
      padding: 0.62rem 0.55rem;
      min-height: 54px;
      border-radius: 10px;
    }
    .mode-rail button strong {
      font-size: 0.8rem;
    }
    .mode-rail button small {
      font-size: 0.67rem;
    }
    .panel {
      padding: 0.55rem;
      height: auto;
      overflow: visible;
    }
    .scan-grid {
      grid-template-columns: 1fr;
      gap: 0.55rem;
      height: auto;
      margin-top: 0.2rem;
    }
    .viewer {
      min-height: 280px;
      height: auto;
      padding: 0.62rem;
    }
    .viewer-body {
      min-height: 210px;
    }
    .doc-frame,
    .img-placeholder {
      width: 100%;
      height: min(52vh, 360px);
    }
    .img-frame {
      width: 100%;
    }
    .img-preview {
      width: 100%;
      height: 100%;
      max-height: min(46vh, 320px);
      object-fit: contain;
    }
    .telemetry {
      padding: 0.55rem;
      min-height: 220px;
      height: auto;
      border-radius: 14px;
    }
    .telemetry-line {
      font-size: 0.78rem;
    }
    .cta,
    .cta-side,
    .download,
    .ghost {
      width: 100%;
      min-height: 46px;
      padding: 0.72rem 0.8rem;
      font-size: 0.92rem;
    }
    .side-result {
      max-height: none;
    }
    .scanit-footer {
      flex-direction: column;
      align-items: stretch;
      gap: 0.45rem;
    }
    .kf-left,
    .kf-center,
    .kf-right {
      justify-content: center;
    }
  }
  .scanit-footer {
    margin-top: 0.5rem;
    border-radius: 12px;
    min-height: 40px;
    padding: 0.42rem 0.62rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }
  .dashboard[dir='rtl'] .hero-left,
  .dashboard[dir='rtl'] .panel,
  .dashboard[dir='rtl'] .telemetry,
  .dashboard[dir='rtl'] .viewer-head {
    text-align: right;
  }
  .dashboard[dir='rtl'] .hero-actions,
  .dashboard[dir='rtl'] .telemetry-head,
  .dashboard[dir='rtl'] .viewer-head {
    flex-direction: row-reverse;
  }
  .science-modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(3, 8, 18, 0.72);
    backdrop-filter: blur(5px);
    z-index: 60;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
  }
  .science-modal {
    width: min(760px, 100%);
    max-height: min(82vh, 740px);
    border-radius: 14px;
    padding: 0.8rem 0.9rem;
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
  }
  .science-modal-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.6rem;
  }
  .science-modal-head h3 {
    margin: 0;
    font-size: 0.95rem;
    letter-spacing: 0.04em;
    color: rgba(223, 241, 255, 0.93);
  }
  .science-modal-body {
    overflow: auto;
    padding-right: 0.2rem;
  }
  .science-modal-body p {
    margin: 0.35rem 0;
    font-size: 0.82rem;
    line-height: 1.48;
    color: rgba(203, 221, 244, 0.88);
  }
  .science-close {
    min-height: 34px;
    padding: 0.4rem 0.7rem;
    font-size: 0.78rem;
  }
  .result-modal {
    max-width: 680px;
  }
  .modal-list {
    margin: 0.45rem 0 0.2rem;
    padding-left: 1.15rem;
    color: rgba(216, 231, 249, 0.9);
    font-size: 0.84rem;
  }
  .science-disclaimer {
    margin-top: 0.4rem;
    color: rgba(255, 218, 173, 0.92);
    font-weight: 600;
  }
  .kf-left {
    display: flex;
    align-items: center;
    gap: 0.45rem;
  }
  .kf-center {
    display: flex;
    align-items: center;
    gap: 0.42rem;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.62rem;
    color: rgba(221, 236, 255, 0.76);
  }
  .kf-dot {
    width: 6px;
    height: 6px;
    border-radius: 999px;
    background: #34c759;
    box-shadow: 0 0 10px rgba(52, 199, 89, 0.7);
    animation: kfPulse 1.6s ease-in-out infinite;
  }
  .kf-clock {
    color: rgba(208, 230, 255, 0.82);
    letter-spacing: 0.02em;
  }
  @keyframes kfPulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.32;
    }
  }
  .kf-copy {
    color: rgba(176, 198, 232, 0.58);
    font-size: 0.58rem;
    letter-spacing: 0.01em;
    line-height: 1;
  }
  .kf-author {
    color: rgba(228, 245, 255, 0.94);
    text-decoration: none;
    font-weight: 600;
    font-size: 0.62rem;
    line-height: 1;
  }
  .kf-author:hover {
    color: #9be8ff;
  }
  .kf-right {
    display: flex;
    align-items: center;
    gap: 0.28rem;
    white-space: nowrap;
  }
  .kf-left a {
    width: 24px;
    height: 24px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: rgba(203, 226, 255, 0.86);
    border: 1px solid rgba(130, 152, 199, 0.28);
    border-radius: 8px;
    background: rgba(9, 14, 26, 0.36);
  }
  .kf-left a svg {
    width: 13px;
    height: 13px;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .kf-left a:hover {
    border-color: rgba(0, 229, 255, 0.56);
    color: #e9f6ff;
  }
</style>