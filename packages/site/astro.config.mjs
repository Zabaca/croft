import starlight from '@astrojs/starlight'
import { defineConfig } from 'astro/config'
import { SITE } from './site.mjs'

// Static output only: the homepage is src/pages/index.astro, the docs are Starlight under /docs/, and the
// agent-facing files (llms.txt, llms-full.txt, a .md twin of every docs page, robots.txt) are endpoints in
// src/pages that Astro renders to files at build time. worker/index.ts only picks between those files.
export default defineConfig({
  site: SITE,
  trailingSlash: 'always',
  // The CLI's pages are full of flags and quoted values: `--rebuild` must not become an en dash.
  markdown: { smartypants: false },
  integrations: [
    starlight({
      title: 'croft',
      description:
        'Local data pipelines in TypeScript, on one DuckDB file. Ingest APIs and files, transform with SQL or TypeScript, keep the tables fresh, and let an agent drive it all.',
      logo: { src: './src/assets/mark.svg', replacesTitle: false },
      favicon: '/favicon.svg',
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/Zabaca/croft' }],
      editLink: { baseUrl: 'https://github.com/Zabaca/croft/edit/main/packages/site/' },
      customCss: ['./src/styles/docs.css'],
      routeMiddleware: './src/route-data.ts',
      head: [
        {
          tag: 'link',
          attrs: { rel: 'alternate', type: 'text/plain', href: '/llms.txt', title: 'croft docs, for agents' },
        },
      ],
      sidebar: [
        {
          label: 'Start here',
          items: [
            { label: 'What croft is', slug: 'docs' },
            { label: 'Install', slug: 'docs/install' },
            { label: 'Quickstart', slug: 'docs/quickstart' },
            { label: 'With Claude Code and other agents', slug: 'docs/agents' },
          ],
        },
        {
          label: 'Concepts',
          items: [
            { label: 'The seven concepts', slug: 'docs/concepts' },
            { label: 'Runs, staleness and previews', slug: 'docs/runs' },
            { label: 'Safety: confirm, trash, restore', slug: 'docs/safety' },
          ],
        },
        { label: 'Guides', items: [{ autogenerate: { directory: 'docs/guides' } }] },
        {
          label: 'Reference',
          items: [
            { label: 'Commands', slug: 'docs/reference/cli' },
            { label: 'croft.json', slug: 'docs/reference/config' },
            { label: 'The --json envelope', slug: 'docs/reference/json' },
            { label: 'Problems and error codes', slug: 'docs/reference/errors' },
            { label: 'Exit codes', slug: 'docs/reference/exit-codes' },
            { label: 'Internals', slug: 'docs/reference/internals' },
            {
              label: 'Every error code',
              collapsed: true,
              items: [{ autogenerate: { directory: 'docs/reference/errors' } }],
            },
          ],
        },
      ],
    }),
  ],
  devToolbar: { enabled: false },
})
