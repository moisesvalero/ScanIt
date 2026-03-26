import { writable, derived } from 'svelte/store';
import en from './en.json';
import es from './es.json';
import de from './de.json';
import fr from './fr.json';
import pt from './pt.json';
import zh from './zh.json';

const ru = {
  layout: { title: 'ScanIt | Проверка документов' },
  scanit: {
    header: {
      title: 'Безопасность и проверка документов',
      subtitle: 'Проверяйте подлинность и происхождение файлов простым способом.'
    },
    badges: { fileIdentity: 'Идентичность файла', workTime: 'Время работы', realData: 'Реальные данные' },
    modules: { verifyDocument: 'Проверить документ', reviewCapture: 'Проверить снимок' },
    main: {
      title: 'Анализатор файлов',
      description: 'Мы проверяем, создан ли документ человеком, анализируя его техническую историю и цифровые доказательства.'
    },
    dropzone: { document: 'Перетащите файл сюда (Word или PDF)' },
    telemetry: {
      idle: {
        ready: '[СИСТЕМА] Готово к анализу...',
        waiting: '[CHECK] Ожидание файла...',
        preparing: '[СИСТЕМА] Подготовка окружения...',
        done: '[CHECK] Все готово к запуску.',
        available: '[СИСТЕМА] ScanIt доступен.'
      }
    }
  }
};

const ar = {
  layout: { title: 'ScanIt | التحقق من المستندات' },
  scanit: {
    header: { title: 'أمان المستندات والتحقق منها', subtitle: 'تحقق من أصالة ملفاتك ومصدرها بطريقة بسيطة.' },
    badges: { fileIdentity: 'هوية الملف', workTime: 'وقت العمل', realData: 'بيانات حقيقية' },
    modules: { verifyDocument: 'التحقق من المستند', reviewCapture: 'مراجعة اللقطة' },
    main: { title: 'محلل الملفات', description: 'نتحقق مما إذا كان المستند من إنشاء بشري عبر تحليل تاريخه التقني والأدلة الرقمية.' },
    dropzone: { document: 'اسحب ملفك هنا (Word أو PDF)' },
    telemetry: {
      idle: {
        ready: '[النظام] جاهز للتحليل...',
        waiting: '[CHECK] بانتظار الملف...',
        preparing: '[النظام] جارٍ تجهيز البيئة...',
        done: '[CHECK] كل شيء جاهز للبدء.',
        available: '[النظام] ScanIt متاح.'
      }
    }
  }
};

const hi = {
  layout: { title: 'ScanIt | दस्तावेज़ सत्यापन' },
  scanit: {
    header: {
      title: 'दस्तावेज़ सुरक्षा और सत्यापन',
      subtitle: 'अपने फ़ाइलों की प्रामाणिकता और स्रोत को सरल तरीके से सत्यापित करें।'
    },
    badges: { fileIdentity: 'फ़ाइल पहचान', workTime: 'कार्य समय', realData: 'वास्तविक डेटा' },
    modules: { verifyDocument: 'दस्तावेज़ सत्यापित करें', reviewCapture: 'कैप्चर जाँचें' },
    main: {
      title: 'फ़ाइल विश्लेषक',
      description: 'हम तकनीकी इतिहास और डिजिटल साक्ष्यों का विश्लेषण करके जाँचते हैं कि दस्तावेज़ मानव द्वारा बनाया गया है या नहीं।'
    },
    dropzone: { document: 'अपनी फ़ाइल यहाँ छोड़ें (Word या PDF)' },
    telemetry: {
      idle: {
        ready: '[SYSTEM] विश्लेषण के लिए तैयार...',
        waiting: '[CHECK] फ़ाइल की प्रतीक्षा...',
        preparing: '[SYSTEM] वातावरण तैयार किया जा रहा है...',
        done: '[CHECK] शुरू करने के लिए सब तैयार है।',
        available: '[SYSTEM] ScanIt उपलब्ध है।'
      }
    }
  }
};

/** @type {Record<string, any>} */
const translations = { en, es, de, fr, pt, zh, ru, ar, hi };

const SUPPORTED = /** @type {const} */ (['en', 'es', 'zh', 'de', 'pt', 'fr', 'ru', 'ar', 'hi']);

/** @param {string | null | undefined} lang */
function normalizeLocale(lang) {
  if (!lang) return 'en';
  const lower = lang.toLowerCase();
  if (lower.startsWith('en')) return 'en';
  if (lower.startsWith('es')) return 'es';
  if (lower.startsWith('zh')) return 'zh';
  if (lower.startsWith('de')) return 'de';
  if (lower.startsWith('pt')) return 'pt';
  if (lower.startsWith('fr')) return 'fr';
  if (lower.startsWith('ru')) return 'ru';
  if (lower.startsWith('ar')) return 'ar';
  if (lower.startsWith('hi')) return 'hi';
  return 'en';
}

function detectLocaleFromTimezone() {
  if (typeof Intl === 'undefined') return null;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone?.toLowerCase() ?? '';
  if (!tz) return null;
  if (tz.includes('madrid') || tz.includes('argentina') || tz.includes('mexico') || tz.includes('bogota')) return 'es';
  if (tz.includes('paris')) return 'fr';
  if (tz.includes('berlin')) return 'de';
  if (tz.includes('lisbon') || tz.includes('sao_paulo')) return 'pt';
  if (tz.includes('shanghai') || tz.includes('hong_kong') || tz.includes('chongqing')) return 'zh';
  if (tz.includes('moscow') || tz.includes('yekaterinburg')) return 'ru';
  if (tz.includes('dubai') || tz.includes('riyadh') || tz.includes('cairo') || tz.includes('doha')) return 'ar';
  if (tz.includes('kolkata') || tz.includes('calcutta')) return 'hi';
  return null;
}

function detectBrowserLocale() {
  if (typeof navigator === 'undefined') return 'en';
  const langs = Array.isArray(navigator.languages) && navigator.languages.length ? navigator.languages : [navigator.language];
  for (const l of langs) {
    const n = normalizeLocale(l);
    if (SUPPORTED.includes(n)) return n;
  }
  const byTimezone = detectLocaleFromTimezone();
  if (byTimezone && SUPPORTED.includes(byTimezone)) return byTimezone;
  return 'en';
}

const defaultLang = (() => {
  // En SSR y si no hay info del navegador, fallback EN
  if (typeof window === 'undefined') return 'en';

  const saved = localStorage.getItem('lang');
  const hasManualSelection = localStorage.getItem('lang_manual') === '1';

  // Si el usuario eligió manualmente idioma, respetamos siempre esa preferencia
  if (hasManualSelection && saved) {
    return normalizeLocale(saved);
  }

  return detectBrowserLocale();
})();

export const locale = writable(defaultLang);

if (typeof document !== 'undefined') {
  document.documentElement.lang = defaultLang;
  document.documentElement.dir = defaultLang === 'ar' ? 'rtl' : 'ltr';
}

export const t = derived(locale, ($locale) => {
  return (
    /** @param {string} key */
    (key) => {
    const keys = key.split('.');
    /** @type {any} */
    let value = translations[$locale];
    for (const k of keys) {
      value = value?.[k];
    }
    return value || key;
  });
});

/** @param {string} lang */
export function setLocale(lang) {
  const normalized = normalizeLocale(lang);
  locale.set(normalized);
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('lang', normalized);
    localStorage.setItem('lang_manual', '1');
  }
  if (typeof document !== 'undefined') {
    document.documentElement.lang = normalized;
    document.documentElement.dir = normalized === 'ar' ? 'rtl' : 'ltr';
  }
}
