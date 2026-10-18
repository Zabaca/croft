import type { APIRoute } from 'astro'
import { asMarkdown, CROFT_VERSION, markdownResponse, sections, SUMMARY } from '../lib/agent-docs'

// Every docs page in one file, in sidebar order, for an agent that would rather read once than follow links.
export const GET: APIRoute = async ({ site }) => {
  const parts = [`# croft ${CROFT_VERSION}: the whole documentation`, '', `> ${SUMMARY}`, '']
  for (const { docs } of await sections()) for (const doc of docs) parts.push('---', '', asMarkdown(doc, site!))
  return markdownResponse(parts.join('\n'), 'text/plain')
}
