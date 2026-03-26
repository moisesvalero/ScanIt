export default {
  layout: {
    title: 'ScanIt | التحقق من المستندات'
  },
  scanit: {
    header: {
      title: 'أمان المستندات والتحقق منها',
      subtitle: 'تحقق من أصالة ملفاتك ومصدرها بطريقة بسيطة.'
    },
    badges: {
      fileIdentity: 'هوية الملف',
      workTime: 'وقت العمل',
      realData: 'بيانات حقيقية'
    },
    modules: {
      verifyDocument: 'التحقق من المستند',
      reviewCapture: 'مراجعة اللقطة'
    },
    main: {
      title: 'محلل الملفات',
      description: 'نراجع سجل التعديل وبنية المستند للتأكد من أنه أصلي.'
    },
    dropzone: {
      document: 'اسحب ملفك هنا (Word أو PDF)'
    },
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
