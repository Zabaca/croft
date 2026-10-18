import type { APIRoute, GetStaticPaths } from 'astro'
import { getCollection } from 'astro:content'
import { asMarkdown, markdownResponse, type Doc } from '../lib/agent-docs'

// The Markdown twin of every docs page: /docs/quickstart/ is also /docs/quickstart.md.
export const getStaticPaths = (async () => {
  const docs = await getCollection('docs')
  return docs.map((doc) => ({ params: { slug: doc.id }, props: { doc } }))
}) satisfies GetStaticPaths

export const GET: APIRoute<{ doc: Doc }> = ({ props, site }) => markdownResponse(asMarkdown(props.doc, site!))
