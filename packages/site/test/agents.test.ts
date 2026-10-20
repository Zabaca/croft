// What an agent reads must agree with what croft does.
//
// The plugin's skill (packages/croft/plugin) teaches the start of a project before an agent has seen the docs, its
// agent hands that start, or a project's own skill, to a subagent (D110), and
// the docs pages teach the same start at length. Two documents that say the same thing drift, and a skill that is
// confidently wrong is worse than none. So every line of every ```sh block in the skill must appear, verbatim, in a
// ```sh block of a hand-written docs page; every `croft <command>` named in the skill or those pages must be a
// command this croft has; and every `croft docs <name>` must have a page. The generated Guides and Reference need no
// such test: scripts/reference.ts renders them from croft's own docs command.
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { COMMANDS } from '../../croft/src/cli/commands/index.ts'
import { CODES } from '../../croft/src/core/errors.ts'
import { GUIDES, hrefFor, REFERENCE, toWebMarkdown } from '../scripts/reference.ts'
import { SITE } from '../site.mjs'
import { twinOf } from '../src/lib/twin.ts'
import { byteRange, markdownFor, wantsHtml } from '../worker/index.ts'

const ROOT = join(import.meta.dir, '..')
const PLUGIN = join(ROOT, '../croft/plugin')
const SKILL = readFileSync(join(PLUGIN, 'skills/getting-started/SKILL.md'), 'utf8')
const AGENT = readFileSync(join(PLUGIN, 'agents/croft.md'), 'utf8')
const DOCS_DIR = join(ROOT, 'src/content/docs/docs')
const PAGES = readdirSync(DOCS_DIR)
  .filter((f) => f.endsWith('.md'))
  .map((f) => ({ name: f, text: readFileSync(join(DOCS_DIR, f), 'utf8') }))
const CODE_SET = new Set(Object.keys(CODES))

/** The lines inside fences of one language. */
function fenced(markdown: string, lang: string): string[] {
  const lines: string[] = []
  let inside = false
  for (const line of markdown.split('\n')) {
    if (line.startsWith('```')) {
      inside = !inside && line.trim() === '```' + lang
      continue
    }
    if (inside && line.trim() !== '') lines.push(line)
  }
  return lines
}

/** Every `croft <word>` inside code: inline spans and sh fences. */
function croftCommands(markdown: string): string[] {
  const code = [...markdown.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!)
    .concat(fenced(markdown, 'sh').map((l) => l.replace(/\s#.*$/, '')))
  return code.flatMap((c) => [...c.matchAll(/(?:^|[\s(&;])croft ([a-z][a-z-]*)/g)].map((m) => m[1]!))
}

const COMMAND_NAMES = new Set(COMMANDS.map((c) => c.name))

describe('the plugin skill', () => {
  test('every sh line in the skill is in a docs page, verbatim', () => {
    const docsLines = new Set(PAGES.flatMap((p) => fenced(p.text, 'sh')))
    const lines = fenced(SKILL, 'sh')
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) expect(docsLines.has(line), line).toBe(true)
  })

  test('points at this site', () => {
    expect(SKILL).toContain(`${SITE}/llms.txt`)
    const plugin = JSON.parse(readFileSync(join(PLUGIN, '.claude-plugin/plugin.json'), 'utf8'))
    expect(plugin.homepage).toBe(SITE)
  })

  test('ships an agent that routes to the project skill or this one, and hands ask-first steps back', () => {
    expect(AGENT.startsWith('---\nname: croft\ndescription: ')).toBe(true)
    // Claude Code skips an agent file whose front matter is not valid YAML, without an error (D110).
    for (const text of [AGENT, SKILL]) {
      const front = Bun.YAML.parse(text.split('\n---\n')[0]!.slice('---\n'.length)) as Record<string, unknown>
      expect(typeof front.name).toBe('string')
      expect(typeof front.description).toBe('string')
    }
    expect(AGENT).toContain("the project has its own `croft` skill")
    expect(AGENT).toContain("load this plugin's `croft:getting-started` skill")
    expect(AGENT).toContain('- As a subagent, return the impact and the command, for the main conversation to put to the user.')
    expect(AGENT).toContain('`claude --agent croft:croft`')
    expect(SKILL).toContain('`.claude/agents/croft.md`')
  })

  test('is listed by the repository marketplace', () => {
    const market = JSON.parse(readFileSync(join(ROOT, '../../.claude-plugin/marketplace.json'), 'utf8'))
    expect(market.plugins.map((p: { source: string }) => p.source)).toContain('./packages/croft/plugin')
  })
})

describe('commands named to an agent', () => {
  for (const { name, text } of [{ name: 'SKILL.md', text: SKILL }, { name: 'agents/croft.md', text: AGENT }, ...PAGES]) {
    test(`${name} names only commands croft has`, () => {
      for (const cmd of croftCommands(text)) expect(COMMAND_NAMES.has(cmd), `croft ${cmd}`).toBe(true)
    })
    test(`${name} names only docs pages croft has`, () => {
      for (const m of text.matchAll(/croft docs ([A-Za-z_][A-Za-z_-]*[A-Za-z])/g)) {
        const name = m[1]!
        expect(hrefFor(name, CODE_SET) ?? null, `croft docs ${name}`).not.toBeNull()
      }
    })
  }
})

describe('the generated pages', () => {
  test('every topic croft lists is a guide or a reference page', async () => {
    const { docs } = await import('../../croft/src/cli/commands/docs.ts')
    const list = (await docs.run({ positionals: [], values: { list: true } } as never)).data as { topics: { name: string }[] }
    const placed = new Set([...GUIDES, ...REFERENCE].map(([t]) => t))
    for (const t of list.topics) expect(placed.has(t.name), t.name).toBe(true)
  })

  test('placeholders stay text, fences pass through, aligned tables become code', () => {
    const md = toWebMarkdown(
      [
        'Run croft run <asset> --rebuild, then croft docs trash.',
        '',
        '```ts',
        'const a = <T>(x: T) => x',
        '```',
        '',
        'KEY      TYPE     DEFAULT',
        'database string   "warehouse.duckdb"',
      ].join('\n'),
      CODE_SET,
    )
    expect(md).toContain('croft run &lt;asset> --rebuild')
    expect(md).toContain('[`croft docs trash`](/docs/guides/trash/)')
    expect(md).toContain('const a = <T>(x: T) => x')
    expect(md).toContain('```text\nKEY      TYPE     DEFAULT')
  })

  test('list continuations stay in their item', () => {
    const md = toWebMarkdown('- croft run x --rebuild refetches\n  everything (trash first)', CODE_SET)
    expect(md).not.toContain('```')
  })
})

describe('the worker', () => {
  test('a browser gets HTML; curl and fetch tools do not', () => {
    expect(wantsHtml('text/html,application/xhtml+xml,*/*;q=0.8')).toBe(true)
    expect(wantsHtml('*/*')).toBe(false)
    expect(wantsHtml(null)).toBe(false)
  })

  test('the Markdown for each path', () => {
    expect(markdownFor('/')).toBe('/llms.txt')
    expect(markdownFor('/docs/')).toBe('/docs.md')
    expect(markdownFor('/docs/quickstart/')).toBe('/docs/quickstart.md')
    expect(markdownFor('/docs/reference/errors/unknown-column')).toBe('/docs/reference/errors/unknown-column.md')
    expect(markdownFor('/docs/quickstart.md')).toBeNull()
    expect(markdownFor('/_astro/x.css')).toBeNull()
  })

  test('the video in byte ranges, as Safari asks for it', () => {
    expect(byteRange('bytes=0-1', 100)).toEqual({ start: 0, end: 1 })
    expect(byteRange('bytes=0-', 100)).toEqual({ start: 0, end: 99 })
    expect(byteRange('bytes=90-200', 100)).toEqual({ start: 90, end: 99 })
    expect(byteRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 })
    expect(byteRange('bytes=100-', 100)).toBe('unsatisfiable')
    expect(byteRange('bytes=0-1,5-6', 100)).toBeNull()
    expect(byteRange(null, 100)).toBeNull()
  })

  test('links inside a twin go to twins', () => {
    expect(twinOf('/docs/guides/ingest/')).toBe('/docs/guides/ingest.md')
    expect(twinOf('/docs/guides/ingest/#incremental')).toBe('/docs/guides/ingest.md#incremental')
    expect(twinOf('/docs/')).toBe('/docs.md')
    expect(twinOf('/llms.txt')).toBe('/llms.txt')
  })
})
