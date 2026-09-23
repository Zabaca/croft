import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MARKER_DIR, markerWrite, renderProvisionScript } from './index'

// One root per file, removed in `afterAll` — the convention the other module
// suites here use.
const ROOT = mkdtempSync(join(tmpdir(), 'provision-core-'))
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

// The payload a consumer actually executes is the rendered script with the
// marker write appended — `vm-provision` and `remote-provision` both compose it
// that way. So these run the composed thing through a real bash rather than
// matching its text: the property under test is whether the appended lines are
// REACHED, and no amount of string matching can answer that.
//
// MARKER_DIR is rewritten to a temp path because the real one is /var/lib.
let counter = 0
function run(script: string, env: Record<string, string> = {}) {
  const dir = join(ROOT, `run-${counter++}`)
  const payload = (
    renderProvisionScript({ packages: [], script, env }) + markerWrite('m', 'DIGEST')
  ).replaceAll(MARKER_DIR, dir)
  const proc = Bun.spawnSync(['bash', '-c', payload])
  const marker = join(dir, 'm')
  const recorded = existsSync(marker)
  return {
    code: proc.exitCode,
    out: proc.stdout.toString() + proc.stderr.toString(),
    recorded,
    digest: recorded ? readFileSync(marker, 'utf8') : null,
  }
}

describe('the declared script cannot swallow the marker write', () => {
  test('a script that runs to the end records its marker', () => {
    const r = run('echo hello')
    expect(r.code).toBe(0)
    expect(r.recorded).toBe(true)
    expect(r.digest).toBe('DIGEST')
  })

  // The defect this suite was written for. Observed on a real consumer
  // (cedarpad's `ws-service`): a readiness poll whose success path was
  // `exit 0`. The shell ended there, the appended marker write never ran, the
  // module saw exit code 0 and reported "provisioned" — and the provision
  // re-ran on every apply for eight days, restarting a live service each time.
  // Nothing failed and nothing noticed, because a missing marker is
  // indistinguishable from a first run.
  test('a script whose success path exits still records its marker', () => {
    const r = run('echo ready\nexit 0\necho unreachable')
    expect(r.code).toBe(0)
    expect(r.out).toContain('ready')
    expect(r.out).not.toContain('unreachable')
    expect(r.recorded).toBe(true)
  })

  test('the shape it was found in — a readiness poll that exits on success', () => {
    const r = run(
      [
        'answered=',
        'for i in 1 2 3; do',
        '  if [ -n "$answered" ]; then :; else answered=1; echo "[svc] up"; exit 0; fi',
        'done',
        'echo "[svc] never came up" >&2',
        'exit 1',
      ].join('\n'),
    )
    expect(r.code).toBe(0)
    expect(r.recorded).toBe(true)
  })

  test('a failing script records nothing, so the next apply retries', () => {
    const r = run('echo trying\nexit 1')
    expect(r.code).not.toBe(0)
    expect(r.recorded).toBe(false)
  })

  // `set -e` in the preamble is what stops half-done work being recorded as
  // done, and wrapping the script must not weaken it.
  test('a script that dies part-way records nothing', () => {
    const r = run('echo one\nfalse\necho two')
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('one')
    expect(r.out).not.toContain('two')
    expect(r.recorded).toBe(false)
  })

  test('a pipeline failure still aborts — pipefail survives too', () => {
    const r = run('false | cat\necho after')
    expect(r.code).not.toBe(0)
    expect(r.out).not.toContain('after')
    expect(r.recorded).toBe(false)
  })

  test('the preamble exports reach the declared script', () => {
    const r = run('test "$FOO" = bar\necho "saw $FOO"', { FOO: 'bar' })
    expect(r.code).toBe(0)
    expect(r.out).toContain('saw bar')
    expect(r.recorded).toBe(true)
  })

  // `(` immediately followed by `)` is a bash syntax error, so an empty script
  // must not be wrapped — rendering something unparseable would turn a no-op
  // into a failed apply.
  test('an empty script is still valid shell', () => {
    const r = run('')
    expect(r.code).toBe(0)
    expect(r.recorded).toBe(true)
  })

  test('a whitespace-only script is still valid shell', () => {
    const r = run('\n  \n')
    expect(r.code).toBe(0)
    expect(r.recorded).toBe(true)
  })

  test('a heredoc in the declared script still parses', () => {
    // Real provision scripts write unit files this way; whatever wraps the
    // script must not break heredoc parsing.
    const r = run('cat <<UNIT\n[Service]\nExecStart=/bin/true\nUNIT')
    expect(r.code).toBe(0)
    expect(r.out).toContain('ExecStart=/bin/true')
    expect(r.recorded).toBe(true)
  })
})
