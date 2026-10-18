import { defineRouteMiddleware } from '@astrojs/starlight/route-data'

// Every docs page names its Markdown twin (src/pages/[...slug].md.ts), so an agent that fetched the HTML finds the
// version written for it without parsing the page.
export const onRequest = defineRouteMiddleware((context) => {
  const { id, head } = context.locals.starlightRoute
  head.push({
    tag: 'link',
    attrs: { rel: 'alternate', type: 'text/markdown', href: `/${id}.md`, title: 'This page as Markdown' },
  })
})
