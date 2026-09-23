/**
 * What `incus config set --help` says its argv is, read out of the binary.
 *
 * Not production code that runs during an apply: this is the anchor two
 * modules' tests share. It lives beside the transcript, in `incus-core`,
 * because more than one module renders a `config set` and they need
 * the same answer to the same question — and a second copy of the question is
 * how the two renderers would come to disagree with the binary separately.
 *
 * The transcript is `incus config set --help` captured verbatim from incus
 * 6.0.0 on build-host on 2026-08-18: stdout, exit 0, no daemon and no sudo, and
 * byte-identical at `COLUMNS=40`, at `COLUMNS=200` and through a pipe, so it is
 * a transcript rather than a rendering of one terminal. `vm`'s suite re-derives
 * it from the binary on every run, which is what stops it becoming a frozen
 * record that a renderer and its fixture can drift away from together.
 */
import * as fs from 'node:fs'

export const CONFIG_SET_HELP_PATH = `${import.meta.dir}/incus-config-set.help.txt`

export const readConfigSetHelp = (): string => fs.readFileSync(CONFIG_SET_HELP_PATH, 'utf8')

/**
 * The two argv forms the help spells out, as it spells them.
 *
 * Both are located by the prose around them rather than by line number, and
 * both throw when absent. A parser that returned `undefined` for a form it
 * could not find would make every assertion downstream vacuous on the day incus
 * rewords a heading — which is the one day this file most needs to fail.
 */
export function parseConfigSetForms(help: string): {
  documented: string
  backwardCompatible: string
} {
  const spec = (line: string | undefined, what: string): string => {
    const match = /^\s*incus config set (.+?)(?: \[flags\])?\s*$/.exec(line ?? '')
    if (match === null) throw new Error(`${what}: no \`incus config set\` argv line in: ${line}`)
    return match[1]!
  }

  const lines = help.split('\n')
  const usageAt = lines.findIndex((line) => /^Usage:\s*$/.test(line))
  if (usageAt === -1) throw new Error('no `Usage:` heading in `incus config set --help`')

  const legacyAt = lines.findIndex((line) => /For backward compatibility/.test(line))
  if (legacyAt === -1)
    throw new Error('no backward-compatibility note in `incus config set --help`')

  return {
    documented: spec(lines[usageAt + 1], 'Usage:'),
    backwardCompatible: spec(lines[legacyAt + 1], 'backward compatibility'),
  }
}

/**
 * The example the help gives for setting a **server** key, as one argv word.
 *
 * A separate question from `parseConfigSetForms`, and the distinction is the
 * reason this exists. Both `Usage:` specs carry `[<remote>:][<instance>]`, so
 * neither says anything about the call that names no instance at all — and
 * `incus config set <a> <b>` with two argv words and no `=` is not an instance
 * set but a *server* one. The Examples section is where the help states that
 * call in full, so it is the only part of the transcript that answers the
 * question a server-scoped `config set` is asking.
 *
 * Located by the `core.` prefix rather than by position: every server key incus
 * documents carries it, and an instance example (`limits.cpu=2`) does not.
 */
export function parseServerExample(help: string): string {
  const lines = help.split('\n')
  const examplesAt = lines.findIndex((line) => /^Examples:\s*$/.test(line))
  if (examplesAt === -1) throw new Error('no `Examples:` heading in `incus config set --help`')

  const example = lines
    .slice(examplesAt)
    .map((line) => /^\s*incus config set (core\.\S+)\s*$/.exec(line)?.[1])
    .find((found) => found !== undefined)
  if (example === undefined)
    throw new Error('no `core.` example under `Examples:` in `incus config set --help`')
  return example
}

/** How one form joins a key to its value. */
export type ConfigArgForm = 'pairs' | 'positional'

/**
 * Read a form's shape out of its own argument spec.
 *
 * Deliberately not a substring test for `=` anywhere in the line: the spec also
 * carries `[<remote>:][<instance>]`, and a rule loose enough to be satisfied by
 * punctuation elsewhere would answer `pairs` for both forms and agree with
 * everything.
 */
export function formShape(spec: string): ConfigArgForm {
  const pairs = /<key>=<value>/.test(spec)
  const positional = /<key> <value>/.test(spec)
  if (pairs === positional) throw new Error(`neither form, or both, in the argument spec: ${spec}`)
  return pairs ? 'pairs' : 'positional'
}

/**
 * The shape of a rendered call's config arguments — everything after the
 * subcommand and, where there is one, the instance reference.
 *
 * The same rule both guards apply, so a renderer cannot satisfy one and fail
 * the other. Empty is refused rather than answered: a caller that sliced past
 * the end of its own argv would otherwise get a confident `positional`.
 */
export function argvConfigShape(args: string[]): ConfigArgForm {
  if (args.length === 0) throw new Error('no config arguments to read a shape from')
  return args.every((arg) => arg.includes('=')) ? 'pairs' : 'positional'
}
