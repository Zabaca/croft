// The docs as an agent reads them: the same collection Starlight renders, as Markdown. llms.txt, llms-full.txt and
// every page's .md twin are rendered from here, so the HTML and the Markdown cannot say different things.
import { getCollection, type CollectionEntry } from 'astro:content'
import version from '../generated-version.json'
import { twinOf } from './twin'

export type Doc = CollectionEntry<'docs'>

export const CROFT_VERSION: string = version.version

/** What croft is, in the words every agent-facing document opens with. */
export const SUMMARY =
  'croft is one command-line tool for local data pipelines in TypeScript, on one DuckDB file: it ingests APIs and files, transforms them with SQL or TypeScript, keeps the tables fresh on a schedule, and lets an app read them. It needs only Bun, and it is built to be driven by a coding agent.'

/** Sidebar sections, in order, with the pages each holds. Error codes go last: they are many and looked up by name. */
const SECTIONS: [title: string, match: (id: string) => boolean][] = [
  ['Start here', (id) => ['docs', 'docs/install', 'docs/quickstart', 'docs/agents'].includes(id)],
  ['Concepts', (id) => ['docs/concepts', 'docs/runs', 'docs/safety'].includes(id)],
  ['Guides', (id) => id.startsWith('docs/guides/')],
  ['Reference', (id) => id.startsWith('docs/reference/') && !id.startsWith('docs/reference/errors/')],
  ['Error codes', (id) => id.startsWith('docs/reference/errors/')],
]

const START = ['docs', 'docs/install', 'docs/quickstart', 'docs/agents', 'docs/concepts', 'docs/runs', 'docs/safety']

function order(a: Doc, b: Doc): number {
  const sa = START.indexOf(a.id)
  const sb = START.indexOf(b.id)
  if (sa !== -1 || sb !== -1) return (sa === -1 ? 99 : sa) - (sb === -1 ? 99 : sb)
  const oa = a.data.sidebar?.order ?? 999
  const ob = b.data.sidebar?.order ?? 999
  return oa - ob || a.id.localeCompare(b.id)
}

export async function sections(): Promise<{ title: string; docs: Doc[] }[]> {
  const all = await getCollection('docs')
  return SECTIONS.map(([title, match]) => ({ title, docs: all.filter((d) => match(d.id)).sort(order) }))
}

export const htmlPath = (doc: Doc) => `/${doc.id}/`
export const mdPath = (doc: Doc) => `/${doc.id}.md`

/** One page as Markdown: its title and description, then its body as written (or as generated from croft docs). */
export function asMarkdown(doc: Doc, site: URL): string {
  const lines = [`# ${doc.data.title}`, '']
  if (doc.data.description) lines.push(`> ${doc.data.description}`, '')
  // The generated pages escape `<` in prose so the HTML renders it; an agent reads the Markdown as text.
  lines.push((doc.body ?? '').trim().replaceAll('&lt;', '<'), '', `Source: ${new URL(htmlPath(doc), site).href}`, '')
  // Links inside the body are site-relative; an agent reading the file elsewhere needs them whole, and a link to
  // another docs page goes to that page's Markdown twin.
  return lines.join('\n').replace(/\]\((\/[^)\s]*)\)/g, (_, p: string) => `](${new URL(twinOf(p), site).href})`)
}

export function markdownResponse(text: string, type = 'text/markdown'): Response {
  return new Response(text, { headers: { 'Content-Type': `${type}; charset=utf-8` } })
}
