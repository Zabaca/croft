// The site is static files; this Worker only chooses which file a request gets.
//
// The same URL answers two readers. A browser sends `Accept: text/html` and gets the page. An agent's fetch (curl,
// a harness, an HTTP tool) usually names no HTML, and gets the Markdown written for it: the homepage answers with
// /llms.txt, and a docs page with its .md twin. Agents that drive a real browser send a browser's Accept and get the
// HTML, which names the Markdown in a <link rel="alternate">.
//
// It also serves the homepage's video in byte ranges: the assets answer a Range request with the whole file and a
// 200, and Safari (every browser on an iPhone) will not play an MP4 that way.
//
// wrangler.jsonc runs this Worker first only for `/`, `/docs/*` and the video; every other path is served from the
// assets without waking it.

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

/**
 * The bytes a Range header asks for, inclusive, out of `size`: `bytes=a-b`, `bytes=a-` or `bytes=-n`, the one range a
 * video player sends. null serves the whole file (no header, or one this does not read, such as several ranges);
 * 'unsatisfiable' starts past the end.
 */
export function byteRange(header: string | null, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  const m = header?.match(/^bytes=(\d*)-(\d*)$/)
  if (!m || (m[1] === '' && m[2] === '')) return null
  if (m[1] === '') {
    const n = Number(m[2])
    return n === 0 ? 'unsatisfiable' : { start: Math.max(0, size - n), end: size - 1 }
  }
  const start = Number(m[1])
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  if (start >= size) return 'unsatisfiable'
  return start > end ? null : { start, end }
}

async function ranged(request: Request, env: Env): Promise<Response> {
  const res = await env.ASSETS.fetch(request)
  const headers = new Headers(res.headers)
  headers.set('Accept-Ranges', 'bytes')
  const header = request.headers.get('range')
  if (!res.ok || !header) return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
  const body = await res.arrayBuffer()
  const range = byteRange(header, body.byteLength)
  if (range === null) return new Response(body, { status: 200, headers })
  if (range === 'unsatisfiable') {
    headers.set('Content-Range', `bytes */${body.byteLength}`)
    headers.delete('Content-Length')
    return new Response(null, { status: 416, headers })
  }
  headers.set('Content-Range', `bytes ${range.start}-${range.end}/${body.byteLength}`)
  headers.set('Content-Length', String(range.end - range.start + 1))
  return new Response(request.method === 'HEAD' ? null : body.slice(range.start, range.end + 1), { status: 206, headers })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname.endsWith('.mp4')) return ranged(request, env)
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
