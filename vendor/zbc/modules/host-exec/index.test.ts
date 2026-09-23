import { describe, expect, test } from 'bun:test'
import { type Exec, exec, execStatus, withExec } from './index'

// The seam has to be held to the standard it was built to impose.
//
// A converted module's tests run its real `apply` against a fake machine, and
// that is the point of this module. But those tests only ever exercise the
// *substituted* half: `withExec` installs a fake, so `executeOnThisMachine` —
// the branch that actually reaches the box — is never entered by them. An
// untested real path inside the seam is the same defect the seam exists to
// remove, one level down, so it is entered here.
//
// The commands below are real. `printf`, `false`, `cat` and `sleep` are the
// smallest things that can distinguish the choices this file makes from their
// absence: what is captured, what is thrown, what stdin is connected to, and
// whether a timeout is passed on at all. Nothing here touches machine state —
// that is exactly why these four and not, say, `tailscale`.

describe('the real machine', () => {
  test('returns what the command wrote to stdout', () => {
    expect(exec('printf hello')).toBe('hello')
  })

  test('a non-zero exit throws rather than returning empty output', () => {
    // The contract converted modules rely on. `apt-get`, `incus` and
    // `tailscale` all report failure by exit code, and an apply that read a
    // failed command as "no output" would converge on nothing and say so.
    expect(() => exec('false')).toThrow()
  })

  test('the failure carries stderr, which is the only reason to capture it', () => {
    // stderr is `pipe` rather than `inherit` or `ignore` so that the diagnosis
    // arrives with the error instead of somewhere in an apply's scrollback.
    // With either other setting this is null and the message is a bare exit code.
    try {
      exec('printf boom >&2; exit 3')
      throw new Error('expected a throw')
    } catch (error) {
      expect(String((error as { stderr?: unknown }).stderr)).toBe('boom')
    }
  })

  test('stdout is returned without stderr mixed into it', () => {
    expect(exec('printf out; printf err >&2')).toBe('out')
  })

  test('a command that reads stdin gets EOF instead of inheriting the caller’s', async () => {
    // **This has to be asked from a process that has an open stdin, and the test
    // runner is not one.** The obvious version — `exec('cat', { timeout })` right
    // here — is green for every value of `stdio[0]`, measured: `'ignore'`,
    // `'inherit'` and `'pipe'` all give 11 pass / 0 fail. Bun hands a test process
    // a non-tty, already-at-EOF stdin (`process.stdin.isTTY` is `undefined`
    // under the runner), so `'inherit'` inherits an ended stream and `cat` exits
    // either way. It was written that way first and it pinned nothing.
    //
    // The case the setting exists for is an interactive `bun run apply` from the
    // canonical tree, where stdin *is* a terminal and a command that reads it
    // stops the converge dead. So the probe runs in a child whose stdin is a pipe
    // nobody ever writes to or closes — the property under test is reachable
    // there and nowhere in this process.
    const probe = `const { exec } = await import(${JSON.stringify(`${import.meta.dir}/index.ts`)})
      try { console.log(JSON.stringify({ eof: true, out: exec('cat', { timeout: 2000 }) })) }
      catch (error) { console.log(JSON.stringify({ eof: false, signal: error.signal })) }`

    const child = Bun.spawn([process.execPath, '-e', probe], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const said = (await new Response(child.stdout).text()).trim()

    // Parsed, not matched: a child that failed to start says nothing, and an
    // assertion on a substring of "" would pass for that too.
    expect(JSON.parse(said)).toEqual({ eof: true, out: '' })
  })

  // What the test above does **not** distinguish, on the record rather than
  // implied by its absence: `'ignore'` from `'pipe'`. `execSync` given
  // `stdio[0] = 'pipe'` and no `input` closes the write end at once, so the
  // child sees EOF exactly as it does under `'ignore'` — measured the same way,
  // and the reason the probe reports `eof: true` for both. The two are
  // indistinguishable for every command an apply runs, and the property actually
  // pinned is the one that can differ: stdin is not the caller's. If `input`
  // ever arrives in `ExecOptions`, that changes and this comment is wrong.

  test('a timeout kills a command that would otherwise outlast the apply', () => {
    // The kill is asserted, not just the throw. `sleep 30` exits 0 on its own,
    // so an `ExecOptions.timeout` that is accepted and never passed on produces
    // no error at all — and any other failure would arrive without a signal.
    // Converted modules pass a timeout precisely because a wedged `tailscale` or
    // `incus` call otherwise hangs an apply indefinitely.
    try {
      exec('sleep 30', { timeout: 250 })
      throw new Error('expected a throw')
    } catch (error) {
      expect((error as { signal?: unknown }).signal).toBe('SIGTERM')
    }
  })
})

describe('substituting the machine', () => {
  const record = () => {
    const commands: string[] = []
    const fake: Exec = (command) => {
      commands.push(command)
      return `stdout of ${command}`
    }
    return { fake, commands }
  }

  test('the fake receives the command and its options, and its output is returned', async () => {
    const seen: { command: string; timeout?: number }[] = []
    const fake: Exec = (command, options) => {
      seen.push({ command, timeout: options?.timeout })
      return 'faked'
    }

    const result = await withExec(fake, async () =>
      exec('tailscale serve status --json', { timeout: 60_000 }),
    )

    expect(result).toBe('faked')
    expect(seen).toEqual([{ command: 'tailscale serve status --json', timeout: 60_000 }])
  })

  test('the real machine is back once the body returns', async () => {
    const { fake, commands } = record()

    await withExec(fake, async () => {
      exec('inside')
    })

    expect(commands).toEqual(['inside'])
    // A real command, and it really ran — the binding is not still pointing at
    // the fake, which would have swallowed this as another recorded string.
    expect(exec('printf outside')).toBe('outside')
  })

  test('the previous machine is back even though the body threw', async () => {
    const { fake, commands } = record()

    await expect(
      withExec(fake, async () => {
        exec('inside')
        throw new Error('apply failed')
      }),
    ).rejects.toThrow('apply failed')

    expect(commands).toEqual(['inside'])
    expect(exec('printf outside')).toBe('outside')
  })

  test('the substitution outlives an await inside the body', async () => {
    // The half a set/restore pair gets wrong. A `withExec` that installed the
    // fake, called the body and restored without awaiting hands the machine back
    // at the body's first suspension point — and for these modules "the machine"
    // means a real `tailscale serve` fired from a unit test. Every converted
    // apply is async and awaits, so this is the normal case, not an edge one.
    const { fake, commands } = record()

    await withExec(fake, async () => {
      exec('before')
      await Promise.resolve()
      await new Promise((resolve) => setTimeout(resolve, 5))
      exec('after')
    })

    expect(commands).toEqual(['before', 'after'])
  })

  test('nesting restores the enclosing fake, not the machine', async () => {
    // A module's own seam test asserts from an outer scope for exactly
    // this reason: an unwind that jumped straight back to the real machine would
    // look identical from inside a single-level test.
    const outer = record()
    const inner = record()

    await withExec(outer.fake, async () => {
      await withExec(inner.fake, async () => {
        exec('innermost')
      })
      exec('back outside')
    })

    expect(inner.commands).toEqual(['innermost'])
    expect(outer.commands).toEqual(['back outside'])
  })
})

// ── The options `vm` and `vm-provision` brought with them ───────────────────
//
// `ExecOptions` carries `timeout` and nothing else until a
// module arrived needing more, and that each addition would come "with the
// module that needs it and the test that exercises it". These three and
// `execStatus` arrived with the work that converted `vm` (14 call
// sites) and `vm-provision` (2). Each one below is a behaviour those modules
// had under `execSync` and would have lost silently in the conversion, so each
// test is written to fail against the seam as it was before them.

describe('input', () => {
  test('is written to the command’s stdin', () => {
    // `vm-provision` delivers a multi-KB provisioning script to
    // `incus exec … -- bash -s` on stdin rather than in argv, so that secret
    // values exported by it never appear in any process list. Without this the
    // guest would run an empty script and the apply would report success.
    expect(exec('cat', { input: 'provision me' })).toBe('provision me')
  })

  test('stdin is still closed when no input is given', () => {
    // The property the seam already had — asserted here beside its opposite so
    // that adding `input` cannot quietly turn every other caller's stdin into
    // an open pipe nobody feeds. `cat` with a closed stdin exits at once; with
    // an open one it would hit the timeout and throw.
    expect(exec('cat', { timeout: 2000 })).toBe('')
  })
})

describe('maxBuffer', () => {
  // 2 MB, which is over Node's 1 MB default and under anything a real command
  // here produces. `incus init` streams an image-download progress bar to
  // stderr — captured, so it counts — which is why `vm` ran with 64 MB from the
  // day it was written.
  const twoMegabytes = 'head -c 2000000 /dev/zero | tr "\\0" x'

  test('a caller that does not ask for one keeps the 1 MB default', () => {
    // Not a silent truncation: the command is killed and `execSync` throws
    // ENOBUFS. This is the test that made the option honest — measured on bun
    // 1.3.14, `maxBuffer: undefined` is *unbounded* rather than "the default",
    // so passing the option straight through would have removed the cap from
    // every caller that never mentions it, `host-dir`
    // included. It went green either way; only the direction it is asserted in
    // says which.
    expect(() => exec(twoMegabytes)).toThrow(/ENOBUFS/)
  })

  test('a raised buffer returns the whole of a large stdout', () => {
    expect(exec(twoMegabytes, { maxBuffer: 8 * 1024 * 1024 })).toHaveLength(2_000_000)
  })
})

describe('stream', () => {
  test('sends stdout and stderr to this process’s own instead of capturing them', async () => {
    // `vm-provision` runs apt-get and a toolchain script inside a guest, which
    // takes minutes. Under the seam's default both streams are captured and the
    // operator watching `bun run apply` sees nothing until it ends — so the
    // module keeps `inherit`, as it had under `execSync`.
    //
    // Asked from a child, for the same reason the stdin probe above is: this
    // process's stdout is the test runner's, and asserting on what a test wrote
    // to it from inside the test is not something bun makes available. The
    // child's streams are pipes we hold, so `inherit` is observable there and
    // nowhere else.
    const probe = `const { exec } = await import(${JSON.stringify(`${import.meta.dir}/index.ts`)})
      const returned = exec('printf streamed; printf noisy >&2', { stream: true })
      console.log('|' + JSON.stringify({ returned }))`

    const child = Bun.spawn([process.execPath, '-e', probe], { stdout: 'pipe', stderr: 'pipe' })
    const [out, err] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])

    // Both halves. The output really reached the child's own streams…
    expect(out.startsWith('streamed|')).toBe(true)
    expect(err).toBe('noisy')
    // …and none of it came back as a value, which is what `inherit` means and
    // what a caller must not then log a second time.
    expect(JSON.parse(out.slice(out.indexOf('|') + 1))).toEqual({ returned: '' })
  })
})

describe('execStatus', () => {
  // The non-throwing variant, deliberately left out at first. `vm` needs it at four
  // call sites: `incus list` on a machine with no such guest, and two liveness
  // probes whose whole purpose is to fail until the guest answers. Written as a
  // throw-and-catch at every call site it would be four copies of the same
  // unwrapping of `execSync`'s error — which is the Node detail this seam
  // exists to keep out of modules.

  test('a command that succeeds reports code 0 and its stdout', () => {
    expect(execStatus('printf ok')).toEqual({ code: 0, out: 'ok' })
  })

  test('a command that fails reports its exit code rather than throwing', () => {
    // A silent failure still says something: with neither stream carrying a
    // word, the error's own message is the only diagnosis there is, and `vm`
    // puts `out` straight into the error it raises.
    expect(execStatus('exit 3')).toEqual({ code: 3, out: 'Command failed: exit 3' })
  })

  test('the output carries both streams, because the diagnosis is usually on stderr', () => {
    // `incus list` on a daemon that refuses says why on stderr and nothing on
    // stdout, and `vm` puts `out` straight into the error it raises.
    expect(execStatus('printf out; printf err >&2; exit 1')).toEqual({ code: 1, out: 'outerr' })
  })

  test('options reach the command the same way', () => {
    expect(execStatus('cat', { input: 'fed' })).toEqual({ code: 0, out: 'fed' })
  })

  test('a fake that throws without an exit code still reports a failure and says what', async () => {
    // How an in-memory machine refuses: a fake models a daemon that will not
    // answer by throwing, and it has no `status` to offer. Reporting `code: 0`
    // there would read as success, and reporting an empty `out` would strip the
    // only diagnosis the fake gave.
    const refuse: Exec = () => {
      throw new Error('fake incus: no such instance')
    }

    const result = await withExec(refuse, async () => execStatus('sudo incus list --format json'))

    expect(result.code).toBe(1)
    expect(result.out).toContain('no such instance')
  })

  test('a fake that returns is a success, with the fake’s own output', async () => {
    const answer: Exec = () => '[]'

    expect(await withExec(answer, async () => execStatus('sudo incus list --format json'))).toEqual(
      {
        code: 0,
        out: '[]',
      },
    )
  })
})
