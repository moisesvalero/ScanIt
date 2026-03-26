import { defineConfig } from 'sanity';
import { structureTool } from 'sanity/structure';
import { deskStructure } from './sanity/deskStructure';
import { schemaTypes } from './sanity/schemaTypes';

const projectId =
  process.env.SANITY_STUDIO_PROJECT_ID || process.env.SANITY_PROJECT_ID || '5zhz6irf';
const dataset = process.env.SANITY_STUDIO_DATASET || process.env.SANITY_DATASET || 'production';

export default defineConfig({
  name: 'portfolio',
  title: 'Portfolio - CMS',
  projectId,
  dataset,
  plugins: [structureTool({ structure: deskStructure })],
  schema: {
    types: schemaTypes,
    templates: (templates) => templates.filter(({ schemaType }) => schemaType !== 'sitePortfolio')
  }
});
