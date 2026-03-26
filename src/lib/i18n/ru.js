export default {
  layout: {
    title: 'ScanIt | Проверка документов'
  },
  scanit: {
    header: {
      title: 'Безопасность и проверка документов',
      subtitle: 'Проверяйте подлинность и происхождение файлов простым способом.'
    },
    badges: {
      fileIdentity: 'Идентичность файла',
      workTime: 'Время работы',
      realData: 'Реальные данные'
    },
    modules: {
      verifyDocument: 'Проверить документ',
      reviewCapture: 'Проверить снимок'
    },
    main: {
      title: 'Анализатор файлов',
      description: 'Мы проверяем историю изменений и структуру документа, чтобы подтвердить его оригинальность.'
    },
    dropzone: {
      document: 'Перетащите файл сюда (Word или PDF)'
    },
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
