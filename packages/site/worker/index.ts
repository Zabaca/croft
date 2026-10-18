// The site is static files; this Worker only chooses which file a request gets.
//
// The same URL answers two readers. A browser sends `Accept: text/html` and gets the page. An agent's fetch (curl,
// a harness, an HTTP tool) usually names no HTML, and gets the Markdown written for it: the homepage answers with
// /llms.txt, and a docs page with its .md twin. Agents that drive a real browser send a browser's Accept and get the
// HTML, which names the Markdown in a <link rel="alternate">.
//
// wrangler.jsonc runs this Worker first only for `/` and `/docs/*`; every other path is served from the assets
// without waking it.

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> }
}

/** Whether the request asked for HTML. No Accept, or `*\/*` alone, counts as no. */
export function wantsHtml(accept: string | null): boolean {
  return (accept ?? '').toLowerCase().includes('text/html')
}

/** The Markdown twin of a path, if it has one: `/` → `/llms.txt`, `/docs/x/` → `/docs/x.md`. */
export function markdownFor(pathname: string): string | null {
  if (pathname === '/') return '/llms.txt'
  if (pathname === '/docs' || pathname === '/docs/') return '/docs.md'
  const m = pathname.match(/^\/docs\/(.+?)\/?$/)
  if (!m || /\.[a-z0-9]+$/i.test(m[1]!)) return null
  return `/docs/${m[1]}.md`
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const twin = (request.method === 'GET' || request.method === 'HEAD') && !wantsHtml(request.headers.get('accept'))
      ? markdownFor(url.pathname)
      : null

    if (twin) {
      const res = await env.ASSETS.fetch(new Request(new URL(twin, url), request))
      if (res.ok) {
        const headers = new Headers(res.headers)
        headers.set('Content-Type', `${twin.endsWith('.md') ? 'text/markdown' : 'text/plain'}; charset=utf-8`)
        headers.set('Vary', 'Accept')
        headers.set('Content-Location', twin)
        return new Response(res.body, { status: res.status, headers })
      }
    }

    const res = await env.ASSETS.fetch(request)
    const headers = new Headers(res.headers)
    headers.append('Vary', 'Accept')
    const md = markdownFor(url.pathname)
    if (md) headers.append('Link', `<${md}>; rel="alternate"; type="${md.endsWith('.md') ? 'text/markdown' : 'text/plain'}"`)
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
  },
}
