import type { APIRoute } from 'astro'

// An explicit yes to crawlers and to agents. Some agents, and the crawlers that feed them, read silence as a request
// to stay off; a site whose readers are mostly agents wants the opposite. Content-Signal is Cloudflare's Content
// Signals Policy: search, use as an answer's input, and training are all allowed.
export const GET: APIRoute = ({ site }) =>
  new Response(
    [
      'User-agent: *',
      'Allow: /',
      '',
      'Content-Signal: search=yes, ai-input=yes, ai-train=yes',
      '',
      `Sitemap: ${new URL('/sitemap-index.xml', site).href}`,
      '',
      '# The docs for agents, as Markdown:',
      `# ${new URL('/llms.txt', site).href}`,
      '',
    ].join('\n'),
    { headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
  )
