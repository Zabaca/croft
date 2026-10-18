// A docs path's Markdown twin. Kept apart from agent-docs.ts, which needs astro:content, so tests can import it.

/** `/docs/guides/ingest/#x` → `/docs/guides/ingest.md#x`; anything else is left as it is. */
export function twinOf(path: string): string {
  const hash = path.indexOf('#')
  const base = (hash === -1 ? path : path.slice(0, hash)).replace(/\/+$/, '')
  const anchor = hash === -1 ? '' : path.slice(hash)
  if (!/^\/docs(\/|$)/.test(base) || /\.[a-z0-9]+$/i.test(base)) return path
  return `${base}.md${anchor}`
}
