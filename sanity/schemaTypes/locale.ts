import { defineType } from 'sanity';

export const localeString = defineType({
  name: 'localeString',
  title: 'Texto (ES / EN)',
  type: 'object',
  fields: [
    { name: 'es', type: 'string', title: 'Espanol' },
    { name: 'en', type: 'string', title: 'English' }
  ],
  preview: {
    select: { es: 'es', en: 'en' },
    prepare({ es, en }) {
      return { title: [es, en].filter(Boolean).join(' - ') || 'Vacio' };
    }
  }
});

export const localeText = defineType({
  name: 'localeText',
  title: 'Texto largo (ES / EN)',
  type: 'object',
  fields: [
    { name: 'es', type: 'text', title: 'Espanol', rows: 5 },
    { name: 'en', type: 'text', title: 'English', rows: 5 }
  ],
  preview: {
    select: { es: 'es', en: 'en' },
    prepare({ es, en }) {
      const t = (es || en || '').slice(0, 60);
      return { title: t ? `${t}...` : 'Vacio' };
    }
  }
});
