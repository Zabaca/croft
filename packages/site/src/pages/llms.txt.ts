import type { APIRoute } from 'astro'
import { CROFT_VERSION, markdownResponse, mdPath, sections, SUMMARY } from '../lib/agent-docs'

// /llms.txt, after https://llmstxt.org: the H1, a one-paragraph summary, then one list of links per section, each
// link to a page's Markdown twin. The error codes are the "Optional" section: an agent fetches the one it met.
export const GET: APIRoute = async ({ site }) => {
  const out = [
    '# croft',
    '',
    `> ${SUMMARY}`,
    '',
    `These docs describe croft ${CROFT_VERSION}, the version on npm as @zabaca/croft. Every link is a Markdown page; ${new URL('/llms-full.txt', site).href} is all of them in one file. Inside a croft project, \`croft docs <topic|CODE>\` prints the same Guides, Reference and error pages offline, for the version that project pins.`,
    '',
    'Install: `bun add -g @zabaca/croft`, then `croft init my-data`. croft needs Bun 1.3.14 or newer on macOS or Linux.',
    '',
  ]
  for (const { title, docs } of await sections()) {
    out.push(`## ${title === 'Error codes' ? 'Optional' : title}`, '')
    if (title === 'Error codes') out.push('Every error code croft reports, one page each, the same as `croft docs <CODE>`.', '')
    for (const doc of docs) {
      const desc = doc.data.description ? `: ${doc.data.description}` : ''
      out.push(`- [${doc.data.title}](${new URL(mdPath(doc), site).href})${desc}`)
    }
    out.push('')
  }
  return markdownResponse(out.join('\n'), 'text/plain')
}
