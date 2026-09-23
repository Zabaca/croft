import { afterAll, describe, expect, test } from 'bun:test'
import {
  mkdtempSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hostSymlinkModule, linkPlan } from './index'

// A symlink is the whole point here: the file it names stays the repo's copy,
// so editing the declared content needs no apply. Every state the path can be
// found in has to be told apart, because the two dangerous ones — a regular
// file somebody else wrote, and a link to a target that is not there — both
// look like success to anything that checks `existsSync(path)`.

// A fixture root this file owns and removes.
//
// One root per file, removed in `afterAll`, rather than a `mkdtempSync` per
// test. `process.on('exit')` never fires under `bun test`, so per-test temp
// directories are never reaped — roughly 50 files doing it that way had leaked
// 24 GB into /tmp before the discipline landed.
const ROOT = mkdtempSync(join(tmpdir(), 'host-symlink-'))
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

const dir = () => mkdtempSync(join(ROOT, 'host-symlink-'))

const withTarget = (name = 'target.md') => {
  const base = dir()
  const target = join(base, name)
  writeFileSync(target, 'the declared content\n')
  return { base, target }
}

describe('what the plan does with each state on disk', () => {
  test('an absent path is linked', () => {
    const { base, target } = withTarget()
    expect(linkPlan(join(base, 'link.md'), target).action).toBe('link')
  })

  test('a correct link is a no-op, so a re-apply changes nothing', () => {
    // The assertion the whole "confirm the re-apply is a no-op" discipline
    // rests on. A module that reports `changed: true` every run cannot tell
    // convergence from drift.
    const { base, target } = withTarget()
    const path = join(base, 'link.md')
    symlinkSync(target, path)
    expect(linkPlan(path, target).action).toBe('noop')
  })

  test('a link pointing somewhere else is re-pointed, not left alone', () => {
    // The drift this module exists to fix: a link made by hand at the right
    // path, aimed at a stale checkout. Treating any symlink as "already done"
    // would leave the wrong file live and report success.
    const { base, target } = withTarget()
    const stale = join(base, 'stale.md')
    writeFileSync(stale, 'an older copy\n')
    const path = join(base, 'link.md')
    symlinkSync(stale, path)
    // Compared whole rather than field by field: `replacing` is what an apply
    // prints to say what it displaced, and a plan that re-points without
    // reporting the old target is a silent overwrite.
    expect(linkPlan(path, target)).toEqual({ action: 'link', replacing: stale })
  })

  // The case that decides whether this module is safe to run against
  // `~/.claude/agents/`, a directory that already holds two hand-written files.
  test('a regular file is refused rather than replaced', () => {
    const { base, target } = withTarget()
    const path = join(base, 'link.md')
    writeFileSync(path, 'somebody else wrote this agent\n')
    expect(() => linkPlan(path, target)).toThrow(/regular file|not a symlink/i)
  })

  test('a directory is refused too', () => {
    const { base, target } = withTarget()
    const path = join(base, 'link.md')
    mkdirSync(path)
    expect(() => linkPlan(path, target)).toThrow(/not a symlink|directory/i)
  })
})

// The failure mode a symlink has and a copied file does not.
describe('a link to a target that is not there', () => {
  test('is refused before it is made', () => {
    // A dangling link is worse than no link: `~/.claude/agents/notes.md`
    // exists, `ls` shows it, and the agent is simply absent from every session
    // with nothing anywhere saying why.
    const base = dir()
    expect(() => linkPlan(join(base, 'link.md'), join(base, 'gone.md'))).toThrow(
      /target.*does not exist/i,
    )
  })

  test('is refused even when the link at that path is already correct', () => {
    // The renamed-target case: the declaration and the link agree with each
    // other and both point at nothing. Checking the target only on the write
    // path would call this converged.
    const { base, target } = withTarget()
    const path = join(base, 'link.md')
    symlinkSync(target, path)
    const gone = join(base, 'gone.md')
    symlinkSync(gone, join(base, 'other.md'))
    expect(() => linkPlan(path, gone)).toThrow(/target.*does not exist/i)
  })
})

describe('what a declaration has to look like', () => {
  const parse = (config: Record<string, unknown>) => hostSymlinkModule.configSchema.parse(config)

  test('the module converges under the name instances name it by', () => {
    expect(hostSymlinkModule.name).toBe('host-symlink')
  })

  test('an absolute path and an absolute target are accepted', () => {
    const parsed = parse({
      path: '/home/deploy/.claude/agents/x.md',
      target: '/home/deploy/repo/docs/agents/x.md',
    })
    expect(parsed.path).toBe('/home/deploy/.claude/agents/x.md')
  })

  test('a relative path is refused', () => {
    // It would be resolved against whatever cwd the apply happens to run in,
    // and an apply that writes a link into a worktree instead of `$HOME` is a
    // silent success — the same shape `systemd-mask` refuses for a relative
    // home.
    expect(() => parse({ path: '.claude/agents/x.md', target: '/home/deploy/repo/x.md' })).toThrow(
      /absolute/i,
    )
  })

  test('a relative target is refused, because a link stores it verbatim', () => {
    // A relative target is resolved against the *link's* directory, not the
    // cwd of the apply that wrote it. That is a second rule to hold in your
    // head for no gain here.
    expect(() =>
      parse({ path: '/home/deploy/.claude/agents/x.md', target: '../repo/x.md' }),
    ).toThrow(/absolute/i)
  })
})

// Everything above tests `linkPlan`, which *decides*. Nothing above runs the
// half that writes — so gutting `apply` to `return { ...config, changed: false }`
// left this file green, and a module whose effect no test invokes is an effect
// nobody has checked. These run the real `apply`.
//
// The harness is a fixture directory and nothing else, because `apply` touches
// exactly the two absolute paths its own config names: `config.path` and
// `config.target`. No test here can reach `~/.claude` — a mistake in one costs
// a temp directory, not the agent definitions on this box.
const APPLY_CTX = { secrets: {}, imports: {}, projectRoot: '/tmp' }

const apply = (path: string, target: string) =>
  hostSymlinkModule.apply(hostSymlinkModule.configSchema.parse({ path, target }), APPLY_CTX)

describe('the apply writes the link, and not only a plan of one', () => {
  test('an absent path becomes a link, through a directory that did not exist', async () => {
    const { base, target } = withTarget()
    // Nested on purpose. `mkdirSync(dirname(path), { recursive: true })` is a
    // step of the apply that no test above reaches, and `~/.claude/agents/` not
    // existing yet is exactly the state a rebuilt box starts in.
    const path = join(base, 'agents', 'notes.md')

    const result = await apply(path, target)

    expect(result.changed).toBe(true)
    expect(lstatSync(path).isSymbolicLink()).toBe(true)
    expect(readlinkSync(path)).toBe(target)
    // The property the module exists for, asserted through the link rather than
    // about it: what reads that path reads the repo's copy, so there is one
    // file and not two.
    expect(readFileSync(path, 'utf8')).toBe('the declared content\n')
  })

  test('a second apply reports unchanged, having left the link it made', async () => {
    const { base, target } = withTarget()
    const path = join(base, 'link.md')

    // The first half is asserted, not assumed. "Nothing happened" satisfies
    // `changed: false` on its own, so an idempotence test whose only claim is
    // that the second run was quiet passes against an apply that never wrote.
    const first = await apply(path, target)
    expect(first.changed).toBe(true)
    expect(readlinkSync(path)).toBe(target)

    const second = await apply(path, target)

    expect(second.changed).toBe(false)
    expect(readlinkSync(path)).toBe(target)
  })

  test('a link aimed at a stale target is re-pointed on disk', async () => {
    // The drift the module exists to fix: a link made by hand at the right
    // path, aimed at a checkout that has moved. `linkPlan` says to re-point it;
    // this is whether anything does.
    const { base, target } = withTarget()
    const stale = join(base, 'stale.md')
    writeFileSync(stale, 'an older copy\n')
    const path = join(base, 'link.md')
    symlinkSync(stale, path)

    const result = await apply(path, target)

    expect(result.changed).toBe(true)
    expect(readlinkSync(path)).toBe(target)
    expect(readFileSync(path, 'utf8')).toBe('the declared content\n')
    // `rmSync` on a symlink must remove the link and not follow it. Getting
    // that wrong would delete the file the old declaration pointed at — in
    // production, a file in a checkout — while every assertion above still
    // passed.
    expect(readFileSync(stale, 'utf8')).toBe('an older copy\n')
  })

  test('a regular file at the path survives the refusal byte for byte', async () => {
    // The refusal is `linkPlan`'s and is tested above. What is untested above is
    // that `apply` propagates it instead of catching it, and that it has not
    // already written by the time it does.
    const { base, target } = withTarget()
    const path = join(base, 'someone-elses.md')
    writeFileSync(path, 'somebody else wrote this agent\n')

    await expect(apply(path, target)).rejects.toThrow(/not a symlink/i)

    expect(lstatSync(path).isSymbolicLink()).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe('somebody else wrote this agent\n')
  })
})
